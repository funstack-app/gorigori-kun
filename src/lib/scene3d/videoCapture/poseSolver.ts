/**
 * 動画→モーションの心臓部: MediaPipe Pose の world landmarks(33点) を
 * 標準リグ(20本DEF骨格)の回転仕様 GeneratedMotionSpec に変換する純関数ソルバー。
 *
 * 設計(Codexレビュー反映):
 *   - 出力は motionGen.ts の euler意味論(「X正=前に倒す」等、実績のある規約)に合わせる
 *     → buildGeneratedClip / 修正チャット / 連結 / レイヤーがそのまま使える
 *   - 体の平行移動は捨てる(軌跡は別レイヤー)。骨盤の上下(hipsY)と向き(rootYaw)は残す
 *   - 回転はswing(向き)のみをXYZ eulerに分解。捻れ(twist)はv1では0
 *   - 低信頼(visibility低)の四肢は直前フレームの姿勢を保持(暴れ防止)
 *   - three.js非依存の小さなベクトル演算のみ(nodeで単体検証できる)
 */

import type { GeneratedMotionSpec } from "../motionGen";

export type CapturedLandmark = { x: number; y: number; z: number; visibility?: number };
/** 1フレーム分: MediaPipe world landmarks 33点(腰中央原点・メートル・yは画像流儀で下向き正) */
export type CapturedFrame = { time: number; landmarks: CapturedLandmark[] };

/* ---------------------------------- 小さなベクトル演算 ---------------------------------- */

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-9 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const deg = (rad: number): number => (rad * 180) / Math.PI;
const clampDeg = (d: number, lim = 150): number => Math.max(-lim, Math.min(lim, d));

/* ---------------------------------- ランドマーク定義 ---------------------------------- */

// MediaPipe Pose 33点のインデックス
const LM = {
  nose: 0,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
} as const;

const p = (f: CapturedFrame, i: number): V3 => {
  const l = f.landmarks[i];
  return [l.x, l.y, l.z];
};
const vis = (f: CapturedFrame, ...idx: number[]): number => {
  let s = 0;
  for (const i of idx) s += f.landmarks[i]?.visibility ?? 0;
  return s / idx.length;
};

/* ---------------------------------- 体の基準フレーム ---------------------------------- */

/**
 * 抽象体フレーム: X=本人の右, Y=上, Z=後ろ(右手系)。
 * この座標系で「静止時の腕・脚=(0,-1,0)」から目標方向へのswingをXYZ eulerに分解すると、
 * motionGenの意味論(腕: X正=前へ振り上げ / Z負=左腕を横上げ)と一致する。
 * MediaPipe world は y下向き正・x画像右(=本人の左が画像右に映る)なので、体基準に直してから使う
 */
type BodyFrame = { right: V3; up: V3; back: V3 };

function bodyFrameOf(f: CapturedFrame): BodyFrame {
  const hipC = mid(p(f, LM.hipL), p(f, LM.hipR));
  const shC = mid(p(f, LM.shoulderL), p(f, LM.shoulderR));
  // MediaPipe y は下向き正 → 上 = hip→shoulder
  const up = norm(sub(shC, hipC));
  // 本人の右 = 右腰 - 左腰 (world座標は本人基準のラベル)
  let right = norm(sub(p(f, LM.hipR), p(f, LM.hipL)));
  // 直交化
  right = norm(sub(right, scale(up, dot(right, up))));
  const back = norm(cross(right, up)); // 右手系: X×Y=Z(後ろ)
  return { right, up, back };
}

/** ワールド方向ベクトル → 抽象体フレーム成分 [右, 上, 後ろ] */
const toBody = (v: V3, b: BodyFrame): V3 => [dot(v, b.right), dot(v, b.up), dot(v, b.back)];

/* ---------------------------------- swing → euler ---------------------------------- */

/**
 * 静止方向(0,-1,0)を dir へ向ける最小回転(swing)を、XYZ euler(度)に分解する。
 * q = rest→dir の最短回転。R = Rx*Ry*Rz(XYZ order)としてeuler抽出
 */
function swingEulerFromDown(dir: V3): [number, number, number] {
  const d = norm(dir);
  if (len(d) < 1e-6) return [0, 0, 0];
  const restV: V3 = [0, -1, 0];
  // 最短回転クォータニオン
  const c = cross(restV, d);
  const w = 1 + dot(restV, d);
  if (w < 1e-6) return [180, 0, 0]; // 真逆(真上): X180で表現
  let [qx, qy, qz] = c;
  let qw = w;
  const ql = Math.hypot(qx, qy, qz, qw);
  qx /= ql;
  qy /= ql;
  qz /= ql;
  qw /= ql;
  // XYZ order euler抽出(three.js Euler.setFromQuaternion 'XYZ' と同式)
  const m11 = 1 - 2 * (qy * qy + qz * qz);
  const m12 = 2 * (qx * qy - qz * qw);
  const m13 = 2 * (qx * qz + qy * qw);
  const m23 = 2 * (qy * qz - qx * qw);
  const m33 = 1 - 2 * (qx * qx + qy * qy);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex: number;
  let ez: number;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qz * qz));
    ez = 0;
  }
  return [deg(ex), deg(ey), deg(ez)];
}

/** 2ベクトルのなす角(度) */
const angleBetween = (a: V3, b: V3): number => {
  const na = norm(a);
  const nb = norm(b);
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(na, nb)))));
};

/* ---------------------------------- One Euro フィルタ ---------------------------------- */

/** ランドマーク平滑化(解く前に座標へかける)。ジッタ除去と追従性の両立 */
class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;
  constructor(
    private minCutoff = 1.5,
    private beta = 0.3,
    private dCutoff = 1.0,
  ) {}
  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x: number, t: number): number {
    if (this.xPrev == null || this.tPrev == null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const ad = this.alpha(this.dCutoff, dt);
    const dxHat = ad * dx + (1 - ad) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;
    return xHat;
  }
}

/** 全ランドマーク座標にOne Euroをかける(時系列順) */
export function smoothFrames(frames: CapturedFrame[]): CapturedFrame[] {
  if (frames.length === 0) return frames;
  const n = frames[0].landmarks.length;
  const filters: OneEuro[][] = Array.from({ length: n }, () => [
    new OneEuro(),
    new OneEuro(),
    new OneEuro(),
  ]);
  return frames.map((f) => ({
    time: f.time,
    landmarks: f.landmarks.map((l, i) => ({
      x: filters[i][0].filter(l.x, f.time),
      y: filters[i][1].filter(l.y, f.time),
      z: filters[i][2].filter(l.z, f.time),
      visibility: l.visibility,
    })),
  }));
}

/* ---------------------------------- 本体: フレーム列 → Spec ---------------------------------- */

const MIN_VIS = 0.5;

/**
 * world landmarks のフレーム列 → GeneratedMotionSpec。
 * 呼び出し側は事前に smoothFrames を通すこと(解いた後の角度平滑より安定)
 */
export function solveFramesToSpec(
  frames: CapturedFrame[],
  name: string,
): GeneratedMotionSpec {
  if (frames.length < 2) throw new Error("フレームが足りません(2枚以上必要)");

  // 立ち姿勢の基準: 腰→足首の上下距離の最大値(最も伸びた瞬間)を「立ち」とみなす
  let standingDrop = 0;
  for (const f of frames) {
    const hipC = mid(p(f, LM.hipL), p(f, LM.hipR));
    const ankC = mid(p(f, LM.ankleL), p(f, LM.ankleR));
    const drop = ankC[1] - hipC[1]; // y下向き正: 正の値=足首が腰より下
    if (drop > standingDrop) standingDrop = drop;
  }

  // rootYaw の基準: 最初のフレームの体の向き
  const b0 = bodyFrameOf(frames[0]);
  const yaw0 = Math.atan2(-b0.back[0], -b0.back[2]); // 前方ベクトル(-back)の水平角

  type KF = GeneratedMotionSpec["keyframes"][number];
  const keyframes: KF[] = [];
  let prevBones: Record<string, [number, number, number]> = {};
  let prevYawDeg = 0;

  for (const f of frames) {
    const b = bodyFrameOf(f);
    const bones: Record<string, [number, number, number]> = {};

    // ---- 腕(左右対称に処理) ----
    for (const side of ["L", "R"] as const) {
      const sh = p(f, side === "L" ? LM.shoulderL : LM.shoulderR);
      const el = p(f, side === "L" ? LM.elbowL : LM.elbowR);
      const wr = p(f, side === "L" ? LM.wristL : LM.wristR);
      const v = vis(
        f,
        side === "L" ? LM.shoulderL : LM.shoulderR,
        side === "L" ? LM.elbowL : LM.elbowR,
        side === "L" ? LM.wristL : LM.wristR,
      );
      const upperName = `DEF-upper_arm.${side}`;
      const foreName = `DEF-forearm.${side}`;
      if (v < MIN_VIS) {
        // 低信頼: 直前の姿勢を保持
        if (prevBones[upperName]) bones[upperName] = prevBones[upperName];
        if (prevBones[foreName]) bones[foreName] = prevBones[foreName];
        continue;
      }
      const upperDir = toBody(sub(el, sh), b);
      const [ex, ey, ez] = swingEulerFromDown(upperDir);
      bones[upperName] = [clampDeg(ex), clampDeg(ey), clampDeg(ez)];
      // 肘: 内角180°=伸び切り → 曲げ角=180-内角(正)。doc: forearm X正=肘曲げ
      const elbowBend = clampDeg(Math.max(0, 180 - angleBetween(sub(sh, el), sub(wr, el))));
      bones[foreName] = [elbowBend, 0, 0];
    }

    // ---- 脚(左右対称に処理) ----
    for (const side of ["L", "R"] as const) {
      const hip = p(f, side === "L" ? LM.hipL : LM.hipR);
      const kn = p(f, side === "L" ? LM.kneeL : LM.kneeR);
      const an = p(f, side === "L" ? LM.ankleL : LM.ankleR);
      const v = vis(
        f,
        side === "L" ? LM.hipL : LM.hipR,
        side === "L" ? LM.kneeL : LM.kneeR,
        side === "L" ? LM.ankleL : LM.ankleR,
      );
      const thighName = `DEF-thigh.${side}`;
      const shinName = `DEF-shin.${side}`;
      if (v < MIN_VIS) {
        if (prevBones[thighName]) bones[thighName] = prevBones[thighName];
        if (prevBones[shinName]) bones[shinName] = prevBones[shinName];
        continue;
      }
      const thighDir = toBody(sub(kn, hip), b);
      const [ex, ey, ez] = swingEulerFromDown(thighDir);
      // doc: thigh X負=腿を前へ上げる。腕(X正=前)と逆符号の骨軸なのでXを反転する
      bones[thighName] = [clampDeg(-ex), clampDeg(ey), clampDeg(ez)];
      // 膝: 曲げ=正(doc: shin X正=膝曲げ)
      const kneeBend = clampDeg(Math.max(0, 180 - angleBetween(sub(hip, kn), sub(an, kn))));
      bones[shinName] = [kneeBend, 0, 0];
    }

    // ---- 胴体(前後左右の傾き + 肩の捻りを spine 3本に分配) ----
    {
      // 前傾・横傾げは「世界の鉛直」基準(カメラ水平前提)。体軸同士は直交で常に0になるため、
      // 水平化した前方・右方向に対する体のupの倒れ込みで測る。doc: X正=前に倒す
      const worldUp: V3 = [0, -1, 0]; // MediaPipeはy下向き正
      const forwardW: V3 = [-b.back[0], -b.back[1], -b.back[2]];
      const fH = norm(sub(forwardW, scale(worldUp, dot(forwardW, worldUp))));
      const rH = norm(sub(b.right, scale(worldUp, dot(b.right, worldUp))));
      const leanF = deg(Math.asin(Math.max(-1, Math.min(1, dot(b.up, fH)))));
      const leanS = deg(Math.asin(Math.max(-1, Math.min(1, dot(b.up, rH)))));
      // 肩線と腰線の水平ねじり(Y捻り)。体フレームは腰基準なので肩線の向き=捻り
      const shLine = toBody(sub(p(f, LM.shoulderL), p(f, LM.shoulderR)), b);
      const twist = deg(Math.atan2(-shLine[2], shLine[0]));
      const perX = clampDeg(leanF / 3, 40);
      const perY = clampDeg(twist / 3, 45);
      const perZ = clampDeg(-leanS / 3, 30);
      if (Math.abs(perX) > 1.5 || Math.abs(perY) > 2 || Math.abs(perZ) > 1.5) {
        const v: [number, number, number] = [perX, perY, perZ];
        bones["DEF-spine.001"] = v;
        bones["DEF-spine.002"] = v;
        bones["DEF-spine.003"] = v;
      }
    }

    // ---- 頭(鼻と耳から向きの概算) ----
    {
      const v = vis(f, LM.nose, LM.earL, LM.earR);
      if (v >= MIN_VIS) {
        const earC = mid(p(f, LM.earL), p(f, LM.earR));
        const headF = toBody(sub(p(f, LM.nose), earC), b);
        // 前=-Z(back負)。左右向き(Y捻り)と上下(X)を概算
        const yaw = deg(Math.atan2(headF[0], -headF[2]));
        const pitch = deg(Math.atan2(-headF[1], Math.hypot(headF[0], headF[2])));
        bones["DEF-head"] = [clampDeg(-pitch, 45), clampDeg(yaw, 70), 0];
      } else if (prevBones["DEF-head"]) {
        bones["DEF-head"] = prevBones["DEF-head"];
      }
    }

    // ---- 骨盤の上下(しゃがみ・沈み込み。体重感の正体) ----
    const hipC = mid(p(f, LM.hipL), p(f, LM.hipR));
    const ankC = mid(p(f, LM.ankleL), p(f, LM.ankleR));
    const drop = ankC[1] - hipC[1];
    const hipsY = Math.max(-0.4, Math.min(0.3, -(standingDrop - drop)));

    // ---- 体の向き(rootYaw: 開始向きからの累積・左回り正) ----
    const yawNow = Math.atan2(-b.back[0], -b.back[2]);
    let dYaw = deg(yawNow - yaw0);
    // アンラップ(直前フレームと連続になるよう±360補正)
    while (dYaw - prevYawDeg > 180) dYaw -= 360;
    while (dYaw - prevYawDeg < -180) dYaw += 360;
    prevYawDeg = dYaw;

    keyframes.push({
      time: Math.round(f.time * 1000) / 1000,
      hipsY: Math.round(hipsY * 1000) / 1000,
      rootYaw: Math.round(dYaw * 10) / 10,
      bones,
    });
    prevBones = bones;
  }

  const duration = frames[frames.length - 1].time;
  return {
    name,
    duration: Math.max(0.5, Math.round(duration * 100) / 100),
    loop: false,
    moveSpeed: 0, // 平行移動は捨てる(軌跡は別レイヤー)。骨盤上下・向きは残す
    keyframes,
  };
}
