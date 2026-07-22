/**
 * 時系列3D補正(lifting)。MediaPipeの単フレーム3Dの弱点(震え・奥行きブレ)を、
 * 2D関節列を±121フレームの窓ごと処理する学習済み小型モデル(VideoPose3D, MIT,
 * fp16 33.9MB)で補正する。CPUのみ(onnxruntime-web wasm)でどのPCでも動く。
 *
 * 実測(2026-07-22 PoC, short2ダンス15秒): ジッタ55→16mm(-71%) / 奥行きジッタ35→7.8mm(-78%)。
 * fp16化の劣化は平均0.14mm(実質ゼロ)。処理は数百ms級。
 *
 * 設計:
 * - 融合方式: 主要12関節(肩肘手首・腰膝足首)をAI出力で置換し、末端(足先・手指・顔)は
 *   MediaPipeの相対形状を保って親関節の移動量だけ平行移動(足接地検出は image 座標のため無影響)
 * - 失敗時は入力をそのまま返す(現行方式へのフォールバック。モデル欠落でも取り込みは動く)
 */
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import type { CapturedFrame } from "./poseSolver";

type Ort = typeof import("onnxruntime-web");
let ortMod: Ort | null = null;
let sessPromise: Promise<import("onnxruntime-web").InferenceSession> | null = null;

async function getSession(): Promise<import("onnxruntime-web").InferenceSession> {
  if (!sessPromise) {
    sessPromise = (async () => {
      // wasm(CPU)専用ビルドを公式exportで読む(Sol設計レビュー2026-07-22採用):
      // - 既定ビルドはWebGPU用部品(jsep)までfetchし環境により404で全滅する(実測)
      // - "onnxruntime-web/wasm" は外部.mjs不要のbundle版に解決される
      // - .wasm実体は公式export(distなし)を?urlで資産化=完全オフライン同梱
      const ort = (await import("onnxruntime-web/wasm")) as unknown as Ort;
      ortMod = ort;
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
      // Tauri WebViewはSharedArrayBuffer前提にしない(単スレッドで十分速い)
      ort.env.wasm.numThreads = 1;
      return ort.InferenceSession.create("/models/pose_lifter_fp16.onnx", {
        executionProviders: ["wasm"],
      });
    })();
    sessPromise.catch(() => {
      sessPromise = null; // 次回リトライ可能に
    });
  }
  return sessPromise;
}

/** MediaPipe 33点 → COCO17(モデル入力順) */
const MP2COCO = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
/** 置換対応 (MediaPipe index, H36M index)。
 * H36M: 0Hip 1RHip 2RKnee 3RAnkle 4LHip 5LKnee 6LAnkle 7Spine 8Thorax 9Neck 10Head
 *       11LSho 12LElb 13LWri 14RSho 15RElb 16RWri */
const PAIRS: [number, number][] = [
  [11, 11], [12, 14], [13, 12], [14, 15], [15, 13], [16, 16],
  [23, 4], [24, 1], [25, 5], [26, 2], [27, 6], [28, 3],
];
/** モデルの受容野(±121フレーム)に合わせた端パディング量 */
const PAD = 121;

type V3 = [number, number, number];
const midOf = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * フレーム列へ時系列3D補正を適用した新しい配列を返す。
 * 失敗時・データ不足時は入力配列をそのまま返す(参照比較でフォールバック判定可能)。
 * aspect = 動画の 高さ/幅 (2D正規化座標をモデルの画面正規化へ変換するのに必要)
 */
export async function liftFrames(
  frames: CapturedFrame[],
  aspect: number,
): Promise<CapturedFrame[]> {
  try {
    const T = frames.length;
    if (T < 5 || !Number.isFinite(aspect) || aspect <= 0) return frames;
    // 2D入力を構築(imageが無いフレームは直前の値を保持)
    const inp = new Float32Array((T + PAD * 2) * 17 * 2);
    let last: { x: number; y: number }[] | null = null;
    const rows: { x: number; y: number }[][] = [];
    for (const f of frames) {
      const img: { x: number; y: number }[] | null =
        f.image && f.image.length >= 33 ? f.image : last;
      if (!img) return frames; // 冒頭からimage無し→補正不能、現行方式のまま
      last = img;
      rows.push(MP2COCO.map((i) => ({ x: img[i].x, y: img[i].y })));
    }
    for (let t = 0; t < T + PAD * 2; t++) {
      const row = rows[Math.min(T - 1, Math.max(0, t - PAD))];
      for (let j = 0; j < 17; j++) {
        // VideoPose3Dの画面正規化: x=px/w*2-1, y=py/w*2-h/w (正規化0-1座標から等価変換)
        inp[(t * 17 + j) * 2] = row[j].x * 2 - 1;
        inp[(t * 17 + j) * 2 + 1] = (2 * row[j].y - 1) * aspect;
      }
    }

    const t0 = performance.now();
    const sess = await getSession();
    const ort = ortMod;
    if (!ort) return frames;
    console.info(`時系列3D補正: モデル準備 ${Math.round(performance.now() - t0)}ms`);
    const t1 = performance.now();
    const out = await sess.run({
      kps2d: new ort.Tensor("float32", inp, [1, T + PAD * 2, 17, 2]),
    });
    console.info(`時系列3D補正: 推論 ${Math.round(performance.now() - t1)}ms (${T}フレーム)`);
    const pose = out.pose3d;
    const data = pose.data as Float32Array;
    if (pose.dims[1] !== T) return frames;
    const lp = (t: number, j: number): V3 => [
      data[(t * 17 + j) * 3],
      data[(t * 17 + j) * 3 + 1],
      data[(t * 17 + j) * 3 + 2],
    ];
    const wp = (f: CapturedFrame, i: number): V3 => [
      f.landmarks[i].x,
      f.landmarks[i].y,
      f.landmarks[i].z,
    ];

    // スケール整合: 胴体長(MediaPipe)/胴体長(モデル) の全フレーム平均
    let mpT = 0;
    let lfT = 0;
    for (let t = 0; t < T; t++) {
      const f = frames[t];
      const hipC = midOf(wp(f, 23), wp(f, 24));
      const shC = midOf(wp(f, 11), wp(f, 12));
      mpT += Math.hypot(shC[0] - hipC[0], shC[1] - hipC[1], shC[2] - hipC[2]);
      const a = lp(t, 0);
      const b = lp(t, 8);
      lfT += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const s = lfT > 1e-6 ? mpT / lfT : 1;

    return frames.map((f, t) => {
      const lms = f.landmarks.map((l) => ({ ...l }));
      const hipC = midOf(wp(f, 23), wp(f, 24));
      const set = (i: number, v: V3) => {
        lms[i].x = v[0];
        lms[i].y = v[1];
        lms[i].z = v[2];
      };
      // 主要関節を置換(モデル出力は骨盤相対 → MediaPipeの腰中心に載せる)
      for (const [m, h] of PAIRS) {
        const q = lp(t, h);
        set(m, [hipC[0] + q[0] * s, hipC[1] + q[1] * s, hipC[2] + q[2] * s]);
      }
      // 末端は親関節の移動量で平行移動(相対形状=MediaPipeの実測を保つ)
      const shift = (targets: number[], parent: number) => {
        const d: V3 = [
          lms[parent].x - f.landmarks[parent].x,
          lms[parent].y - f.landmarks[parent].y,
          lms[parent].z - f.landmarks[parent].z,
        ];
        for (const i of targets) {
          lms[i].x += d[0];
          lms[i].y += d[1];
          lms[i].z += d[2];
        }
      };
      shift([29, 31], 27); // 左かかと・つま先 ← 左足首
      shift([30, 32], 28); // 右かかと・つま先 ← 右足首
      shift([17, 19, 21], 15); // 左手指 ← 左手首
      shift([18, 20, 22], 16); // 右手指 ← 右手首
      // 顔(0-10): モデルの頭位置と耳中心の差で平行移動
      const headL = lp(t, 10);
      const earC = midOf(wp(f, 7), wp(f, 8));
      const dh: V3 = [
        hipC[0] + headL[0] * s - earC[0],
        hipC[1] + headL[1] * s - earC[1],
        hipC[2] + headL[2] * s - earC[2],
      ];
      for (let i = 0; i <= 10; i++) {
        lms[i].x += dh[0];
        lms[i].y += dh[1];
        lms[i].z += dh[2];
      }
      return { ...f, landmarks: lms };
    });
  } catch (e) {
    // モデル欠落・wasm不可などは現行方式で続行(取り込み自体を止めない)
    console.warn("時系列3D補正をスキップ(現行方式で続行):", e);
    return frames;
  }
}
