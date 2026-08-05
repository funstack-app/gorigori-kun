/**
 * 画像1枚 → 静的ポーズclip の配管 (Slice B / bd a6q・2wm)。
 *
 * 動画取り込み(videoCapture/videoToClip.ts)の**1枚絵版**。新規研究要素は無く、
 * 同じ MediaPipe Pose (同梱WASM・完全ローカル・決定論) と同じ poseSolver を使う。
 * LLM は一切使わない。
 *
 * 注意(videoToClip の罠リストに対応する差分):
 *   - WASM/モデルは public/ に同梱済み(オフライン・版固定)。追加リソースなし
 *   - runningMode は PoseLandmarker の**生成時に固定**されるため、VIDEO モードの
 *     既存シングルトン(videoToClip.ts:27-53)とは**別インスタンス**を持つ
 *   - IMAGE モードは detect() で、VIDEO モードの単調増加タイムスタンプ制約が無い
 *   - solveFramesToSpec は frames.length < 2 で throw する(poseSolver.ts:363)。
 *     1枚絵では **同一フレームを t=0 / t=0.5 に複製**して渡す(決定論的回避)。
 *     同一2フレームなので出力は実質静止clipになる
 *   - ただしその複製が **欠測ボーンの補間を構造的に殺す**(下記 fillMissingBones)。
 *     poseSolver は低visibilityの四肢を「欠測」として記録し、後段で前後フレームの
 *     実測から補間する(poseSolver.ts:806-825)が、1枚絵は2フレームとも同一なので
 *     欠測なら前後とも欠測 → キーがどこにも書かれず、再生時にレスト姿勢(Y Bot の
 *     **Tポーズ**)へ落ちる。実データで「右腕だけTポーズ」「両脚だけTポーズ」が
 *     発生していた(2026-08-05 分析: 5 spec中4件で8〜13本欠落)。
 *     この穴は **この経路で閉じる**(poseSolver 側を触ると動画経路に退行が波及する)
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { convertFileSrc } from "@tauri-apps/api/core";

import type { GeneratedMotionSpec } from "./motionGen";
import { buildGeneratedClip, MIXAMO_BONES } from "./motionGen";
import { loadCaptureRig, registerGeneratedClip } from "./motionLibrary";
import { saveGeneratedSpec } from "./motionStore";
import { smoothFrames, solveFramesToSpec } from "./videoCapture/poseSolver";
import type { CapturedFrame } from "./videoCapture/poseSolver";

/** MediaPipe Pose の landmark 点数。33点未満は「人物を捉えていない」と判定する */
const REQUIRED_LANDMARKS = 33;
/** 採用に必要な visibility 平均。poseSolver の MIN_VIS(0.5) と同値で揃える */
const MIN_MEAN_VISIBILITY = 0.5;
/** 複製する2フレーム目の時刻(秒)。0.5秒の静止clipになる */
const DUPLICATE_FRAME_TIME = 0.5;

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/**
 * IMAGE モード専用の PoseLandmarker シングルトン。
 * VIDEO モードの既存インスタンスとは別に持つ(runningMode は生成時固定のため、
 * 1つのインスタンスで detect と detectForVideo を混ぜることはできない)。
 */
function getImageLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
      return PoseLandmarker.createFromOptions(fileset, {
        // heavy採用の根拠は videoToClip.ts:41-42 と同じ(1枚絵はさらにやり直しが効かない)
        baseOptions: { modelAssetPath: "/models/pose_landmarker_heavy.task" },
        runningMode: "IMAGE",
        numPoses: 1,
      });
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null; // 失敗したら次回作り直す
    });
  }
  return landmarkerPromise;
}

/** convertFileSrc したパスを HTMLImageElement にロードする */
async function loadImageElement(path: string): Promise<HTMLImageElement> {
  const src = convertFileSrc(path);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("画像を読み込めませんでした"));
  });
  return img;
}

/**
 * 欠測ボーンの埋め値 = **自然な立ちポーズ**(レストのTポーズではない)。
 *
 * 値は推測でなく実測: 腕を体側に下ろした直立ランドマークを poseSolver に通した
 * 出力そのもの(LeftArm/RightArm = [85.9, 0, 0]、脚と背骨は [0,0,0] = レストで既に直立)。
 * ここに書いていないボーンはレスト姿勢が自然な立ちと一致するため 0 で埋める。
 *
 * Tポーズ(0,0,0)で埋めない理由: Y Bot のレストは**両腕を真横に水平**なので、
 * 腕を 0 で埋めると「片腕だけ真横に突き出た人」になる(まさに報告された症状)。
 */
const NATURAL_STANDING: Record<string, [number, number, number]> = {
  "mixamorig:LeftArm": [85.9, 0, 0],
  "mixamorig:RightArm": [85.9, 0, 0],
};

/**
 * 「検出できていれば poseSolver が必ず書くボーン」→ 人間向けラベル。
 *
 * **告知の対象はこれだけ**。poseSolver が書くのは 22 本中この 12 本で
 * (Hips/Head は別経路で常に書かれる)、Spine系・Neck・Hand・ToeBase は
 * **検出成否によらず一度も書かれない**(poseSolver.ts の bones[...] 代入は
 * Hips/腕3/脚3/Head のみ)。それらの欠落は「隠れていた」証拠にならないので、
 * 埋めはするが告知はしない。**過剰申告すると告知そのものが信用されなくなる**。
 */
const REPORTABLE_BONES: [RegExp, string][] = [
  [/^mixamorig:Left(Shoulder|Arm|ForeArm)$/, "左腕"],
  [/^mixamorig:Right(Shoulder|Arm|ForeArm)$/, "右腕"],
  [/^mixamorig:Left(UpLeg|Leg|Foot)$/, "左脚"],
  [/^mixamorig:Right(UpLeg|Leg|Foot)$/, "右脚"],
];

/** 告知対象ならラベル、対象外(=元から解かれないボーン)なら null */
function labelForBone(bone: string): string | null {
  for (const [re, label] of REPORTABLE_BONES) if (re.test(bone)) return label;
  return null;
}

/**
 * 全キーフレームに 22 ボーン分の値を書き切り、埋めた部位を返す。
 *
 * poseSolver が欠測扱いにしたボーンは spec に**キーが存在しない**。そのまま再生すると
 * レスト(Tポーズ)に落ちるので、ここで自然な立ちポーズを書き込む。
 * **黙って埋めない**: 埋めたボーンのラベル(「右腕」等)を返し、呼び出し側が告知する
 * (no-silent-gap-filling: 推測で埋めるなら必ず推定と明示する)。
 *
 * 静止clip前提の処理なので全フレームに同じ値を書く(1枚絵は動きゼロ)。
 */
function fillMissingBones(spec: GeneratedMotionSpec): string[] {
  const filled = new Set<string>();
  for (const kf of spec.keyframes) {
    for (const bone of MIXAMO_BONES) {
      if (kf.bones[bone]) continue;
      const v = NATURAL_STANDING[bone] ?? [0, 0, 0];
      kf.bones[bone] = [v[0], v[1], v[2]];
      filled.add(bone);
    }
  }
  // ラベルの重複を潰しつつ、REPORTABLE_BONES の並び順を保つ(出力を決定論にする)
  const order = REPORTABLE_BONES.map(([, l]) => l);
  const labels = new Set(
    [...filled].map(labelForBone).filter((l): l is string => l !== null),
  );
  return [...labels].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** landmarks 配列の visibility 平均。未定義は 0 として扱う(甘く見ない) */
function meanVisibility(landmarks: { visibility?: number }[]): number {
  if (landmarks.length === 0) return 0;
  let sum = 0;
  for (const l of landmarks) sum += l.visibility ?? 0;
  return sum / landmarks.length;
}

/**
 * MediaPipe の検出結果 → 静止 spec。
 * 検出品質が閾値未満なら **null を正直に返す**(黙って劣化した spec を作らない)。
 *
 * 検出そのものと分離してあるのは、フィクスチャ landmarks で単体検証できるようにするため。
 */
export function buildStaticSpecFromLandmarks(
  world: { x: number; y: number; z: number; visibility?: number }[] | undefined,
  name: string,
  image?: { x: number; y: number; visibility?: number }[],
): GeneratedMotionSpec | null {
  if (!world || world.length < REQUIRED_LANDMARKS) return null;
  if (meanVisibility(world) < MIN_MEAN_VISIBILITY) return null;

  const landmarks = world.map((l) => ({
    x: l.x,
    y: l.y,
    z: l.z,
    visibility: l.visibility,
  }));
  const imageLandmarks = image?.map((l) => ({
    x: l.x,
    y: l.y,
    visibility: l.visibility,
  }));

  // solveFramesToSpec の「2枚以上必要」制約への決定論的対応。
  // 同一の landmarks を t=0 / t=0.5 に複製する(動きゼロ = 静止ポーズ)。
  // ここを1フレームに減らすと solveFramesToSpec が throw する(牙の実証済み)。
  const frames: CapturedFrame[] = [
    { time: 0, landmarks, image: imageLandmarks },
    { time: DUPLICATE_FRAME_TIME, landmarks, image: imageLandmarks },
  ];

  // solveFramesToSpec は rig:"mixamo" / loop:false / moveSpeed:0 を返す(poseSolver.ts:863-871)。
  // 1枚絵に必要な値と一致しているので上書きしない。
  const spec = solveFramesToSpec(smoothFrames(frames), name);

  // 欠測ボーンを自然な立ちポーズで埋め切る(埋めないと部位単位でTポーズが残る)。
  // 埋めた部位は spec に記録して呼び出し側が告知する(黙って埋めない)。
  const estimatedParts = fillMissingBones(spec);
  if (estimatedParts.length > 0) spec.estimatedParts = estimatedParts;
  return spec;
}

/**
 * 画像ファイル1枚から静的ポーズ spec を作る。
 * 人物を検出できなければ **null**(呼び出し側がフォールバック連鎖を判断する)。
 *
 * @param path Tauri のファイルパス(convertFileSrc して読む)
 * @param name clip の表示名。省略時は時刻つきの既定名
 */
export async function capturePoseFromImage(
  path: string,
  name?: string,
): Promise<GeneratedMotionSpec | null> {
  const landmarker = await getImageLandmarker();
  const img = await loadImageElement(path);
  const res = landmarker.detect(img);

  const stamp = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return buildStaticSpecFromLandmarks(
    res.worldLandmarks?.[0],
    name ?? `ポーズ(画像 ${stamp})`,
    res.landmarks?.[0],
  );
}

/**
 * spec を clip として登録し、再起動後も引けるよう永続化する。
 *
 * Scene3dWorkspace.tsx:940-950 の動画取込経路と**同じ5段**:
 *   loadCaptureRig → buildGeneratedClip → registerGeneratedClip
 *   → saveGeneratedSpec → registerImportedMotions
 *
 * 5段目(zustand ストアへの反映)は React 側の store を掴む必要があるため、
 * 呼び出し側から `registerImported` として渡す(この配管を UI 非依存に保つため)。
 */
export async function registerPoseClip(
  spec: GeneratedMotionSpec,
  registerImported: (items: { id: string; name: string }[]) => void,
): Promise<{ id: string; name: string }> {
  // 取り込みは Mixamo規格(Y Bot)で再生する。solveFramesToSpec の出力は rig:"mixamo"
  const template = await loadCaptureRig();
  const id = `gen-${Date.now()}`;
  const clip = buildGeneratedClip(template, spec, id);
  const entry = registerGeneratedClip(id, spec.name, clip, spec.plants, spec.rig);
  if (!entry) throw new Error("クリップの登録に失敗しました");
  saveGeneratedSpec(id, spec);
  registerImported([entry]);
  return entry;
}
