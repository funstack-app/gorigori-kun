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
const wrap180 = (d: number): number => {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
};

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
  heelL: 29,
  heelR: 30,
  footL: 31,
  footR: 32,
} as const;

/** 接地しうる関節(逆立ち=手首、正座=膝も床に着く)。hipsY の接地補正で使う */
const CONTACT_LMS = [
  LM.wristL, LM.wristR, LM.kneeL, LM.kneeR,
  LM.ankleL, LM.ankleR, LM.heelL, LM.heelR, LM.footL, LM.footR,
] as const;

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

type Quat = [number, number, number, number]; // x, y, z, w

/** 静止方向(0,-1,0)→dir の最短回転クォータニオン */
function quatSwingFromDown(dir: V3): Quat {
  const d = norm(dir);
  if (len(d) < 1e-6) return [0, 0, 0, 1];
  const restV: V3 = [0, -1, 0];
  const c = cross(restV, d);
  const w = 1 + dot(restV, d);
  if (w < 1e-6) return [1, 0, 0, 0]; // 真逆(真上): X180
  const ql = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / ql, c[1] / ql, c[2] / ql, w / ql];
}

/** 3x3回転行列(行優先 m[row][col]) → クォータニオン (Shepperd法) */
function quatFromMatrix(m: number[][]): Quat {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** 球面線形補間(最短経路) */
function slerpQ(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb: Quat = b;
  if (d < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    d = -d;
  }
  if (d > 0.9995) {
    const q: Quat = [
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ];
    const l = Math.hypot(...q);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const th = Math.acos(d);
  const sa = Math.sin((1 - t) * th) / Math.sin(th);
  const sb = Math.sin(t * th) / Math.sin(th);
  return [
    a[0] * sa + bb[0] * sb,
    a[1] * sa + bb[1] * sb,
    a[2] * sa + bb[2] * sb,
    a[3] * sa + bb[3] * sb,
  ];
}

/** XYZ euler(度) → クォータニオン */
function quatFromEulerXYZ([dx, dy, dz]: [number, number, number]): Quat {
  const x = (dx * Math.PI) / 360;
  const y = (dy * Math.PI) / 360;
  const z = (dz * Math.PI) / 360;
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** 2クォータニオン間の実回転角(度) */
function quatAngle(a: Quat, b: Quat): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return deg(2 * Math.acos(Math.min(1, d)));
}

/** クォータニオン → XYZ euler(度)。three.js Euler.setFromQuaternion 'XYZ' と同式 */
function eulerXYZFromQuat([qx, qy, qz, qw]: Quat): [number, number, number] {
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

/**
 * 3点(付け根・関節・先端)から、付け根ボーンの回転を捻れ込みで解く。
 * 静止基準: ボーン方向=(0,-1,0)、曲げ軸=restBendAxis(肘=+X:前へ曲がる / 膝=-X:後ろへ曲がる)。
 * 曲げが浅いと法線が不安定なため、旧実装は15°で捻れ解をON/OFFの急切替にしていたが、
 * 高速動作で境界をまたぐ瞬間に実回転105°/フレームのスナップが出た(2026-07-21 実測)。
 * → swing解と捻れ解をクォータニオン空間で混合し、曲げ10°〜25°でなめらかに移行する
 */
function limbEulerWithTwist(
  dir: V3,
  bendPlaneNormal: V3 | null,
  restBendAxis: V3,
  bendDeg: number,
): [number, number, number] {
  const d = norm(dir);
  if (len(d) < 1e-6) return [0, 0, 0];
  const qSwing = quatSwingFromDown(d);
  // 混合重み: 曲げ10°以下=swingのみ / 25°以上=捻れ解のみ / 間はスムーズステップ
  const tRaw = Math.max(0, Math.min(1, (bendDeg - 10) / 15));
  const w = tRaw * tRaw * (3 - 2 * tRaw);
  if (!bendPlaneNormal || w <= 0) return eulerXYZFromQuat(qSwing);
  // 目標基底: t1=ボーン方向, t2=曲げ軸(dirと直交化), t3=t1×t2
  const t2 = norm(sub(bendPlaneNormal, scale(d, dot(bendPlaneNormal, d))));
  if (len(t2) < 1e-6) return eulerXYZFromQuat(qSwing);
  const t3 = cross(d, t2);
  // 静止基底: r1=(0,-1,0), r2=restBendAxis, r3=r1×r2
  const r1: V3 = [0, -1, 0];
  const r2 = restBendAxis;
  const r3 = cross(r1, r2);
  // 回転行列 M = T * R^T (Rの各列→Tの各列へ写す)
  const T = [d, t2, t3];
  const R = [r1, r2, r3];
  const m: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      m[i][j] = T[0][i] * R[0][j] + T[1][i] * R[1][j] + T[2][i] * R[2][j];
  const qTwist = quatFromMatrix(m);
  return eulerXYZFromQuat(w >= 1 ? qTwist : slerpQ(qSwing, qTwist, w));
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
    // 2026-07-21 高速ダンス向け調整(Sol設計レビュー採用): 旧(1.5, 0.3)は手ブレ除去寄りで
    // 速い反転・着地の衝撃を丸めていた。minCutoff↑=静止時の追従を上げ、beta↑=高速時の遅れを減らす
    private minCutoff = 2.5,
    private beta = 0.6,
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

  // 接地補正: 腰から「最下端の接地候補関節」までの上下距離(逆立ちでは手首、正座では膝が基準になる)。
  // 足首固定だと逆立ち・床技で骨盤が最大まで沈む誤りになる(2026-07-21 PoC実測)
  const lowestDropOf = (f: CapturedFrame): number => {
    const hipC = mid(p(f, LM.hipL), p(f, LM.hipR));
    let best: number | null = null;
    for (const i of CONTACT_LMS) {
      if ((f.landmarks[i]?.visibility ?? 0) < MIN_VIS) continue;
      const d = f.landmarks[i].y - hipC[1]; // y下向き正: 正の値=関節が腰より下
      if (best == null || d > best) best = d;
    }
    if (best != null) return best;
    // 全候補が低信頼: 従来どおり足首中点で代用
    const ankC = mid(p(f, LM.ankleL), p(f, LM.ankleR));
    return ankC[1] - hipC[1];
  };
  const lowestDrops = frames.map(lowestDropOf);
  // 3フレーム移動平均(接地関節が足首→手首に切り替わる瞬間の段差をならす)
  const lowestSmooth = lowestDrops.map((_, i) => {
    const s = lowestDrops.slice(Math.max(0, i - 1), i + 2);
    return s.reduce((a, v) => a + v, 0) / s.length;
  });

  // 立ち姿勢の基準: 接地距離の最大値(最も伸びた瞬間)を「立ち」とみなす
  let standingDrop = 0;
  for (const d of lowestSmooth) {
    if (d > standingDrop) standingDrop = d;
  }

  // rootYaw の基準: 最初のフレームの体の向き
  const b0 = bodyFrameOf(frames[0]);
  const yaw0 = Math.atan2(-b0.back[0], -b0.back[2]); // 前方ベクトル(-back)の水平角

  type KF = GeneratedMotionSpec["keyframes"][number];
  const keyframes: KF[] = [];
  let prevBones: Record<string, [number, number, number]> = {};
  let prevYawDeg = 0;
  let prevTwistDeg = 0;
  // 低信頼で解けなかった(ボーン, キーフレーム番号)の記録。後段で前後の実測から補間する
  const missing = new Map<string, number[]>();
  const markMissing = (bn: string, idx: number) => {
    let arr = missing.get(bn);
    if (!arr) missing.set(bn, (arr = []));
    arr.push(idx);
  };

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
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
      const clavName = `DEF-shoulder.${side}`;
      if (v < MIN_VIS) {
        // 低信頼: この場では書かず「欠測」として記録 → 後段で前後の実測から補間する
        // (旧: 直前姿勢を保持 → 激しい動きの最中に固まり、復帰時にワープしていた)
        markMissing(upperName, keyframes.length);
        markMissing(foreName, keyframes.length);
        markMissing(clavName, keyframes.length);
        continue;
      }
      const upperDir = toBody(sub(el, sh), b);
      const foreDir = toBody(sub(wr, el), b);
      // 肘: 内角180°=伸び切り → 曲げ角=180-内角(正)。doc: forearm X正=肘曲げ
      const elbowBend = clampDeg(Math.max(0, 180 - angleBetween(sub(sh, el), sub(wr, el))));
      // 曲げが浅いと平面法線が不安定 → 10°〜25°でswing解へなめらかに移行(急切替禁止)
      const bendNormal = elbowBend > 10 ? norm(cross(upperDir, foreDir)) : null;
      const [ex, ey, ez] = limbEulerWithTwist(upperDir, bendNormal, [1, 0, 0], elbowBend);
      bones[upperName] = [clampDeg(ex), clampDeg(ey), clampDeg(ez)];
      bones[foreName] = [elbowBend, 0, 0];

      // ---- 鎖骨(肩の持ち上げ・すぼめ)。肩が胴体に張り付いたままの硬さを解消 ----
      // 軸実測(2026-07-21 synthbone): X+=腕ごと持ち上げ / Y+=前へ下げすぼめ / Z=視覚変化ほぼなし
      // 注意: 抽象体フレームは Y=上+(bodyFrameOf)。Y下+と取り違えて符号が逆だった
      // (Codex Verifier指摘 2026-07-21: 腕を下ろすと鎖骨が上がる逆連動になっていた)
      {
        const shCenter = mid(p(f, LM.shoulderL), p(f, LM.shoulderR));
        const clavDir = toBody(sub(sh, shCenter), b); // 体フレーム: x=右+ y=上+ z=後+
        const lat = Math.abs(clavDir[0]);
        if (lat > 1e-6) {
          const liftDeg = deg(Math.atan2(clavDir[1], lat)); // 肩のすくめ(上+)
          const fwdDeg = deg(Math.atan2(-clavDir[2], lat)); // 前に出る(+)
          // 腕の挙上に連動して鎖骨が持ち上がる(人体では腕水平以降の可動は肩甲帯が担う)。
          // 挙上角: 下=-90 / 水平=0 / 真上=+90
          const u = norm(upperDir);
          const armUp = deg(Math.asin(Math.max(-1, Math.min(1, u[1]))));
          const coupled = Math.max(0, armUp - 60) * 0.4;
          bones[clavName] = [
            clampDeg(liftDeg * 0.6 + coupled, 30),
            clampDeg(fwdDeg * 0.4, 20),
            0,
          ];
        }
      }
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
      const footHoldName = `DEF-foot.${side}`;
      if (v < MIN_VIS) {
        markMissing(thighName, keyframes.length);
        markMissing(shinName, keyframes.length);
        markMissing(footHoldName, keyframes.length);
        continue;
      }
      const thighDir = toBody(sub(kn, hip), b);
      const shinDir = toBody(sub(an, kn), b);
      const kneeBend = clampDeg(Math.max(0, 180 - angleBetween(sub(hip, kn), sub(an, kn))));
      const bendNormal = kneeBend > 10 ? norm(cross(thighDir, shinDir)) : null;
      // 脚の骨軸は腕と鏡映(doc: thigh X負=前上げ / shin X正=後ろ曲げ) → 静止曲げ軸=-X
      const [ex, ey, ez] = limbEulerWithTwist(thighDir, bendNormal, [-1, 0, 0], kneeBend);
      // 腿の骨軸はX(前後)が反転している(docの符号規約)。基底解でも同様に反転して合わせる
      bones[thighName] = [clampDeg(-ex), clampDeg(-ey), clampDeg(ez)];
      bones[shinName] = [kneeBend, 0, 0];

      // ---- 足首(つま先の上下)。足が板のまま=ステップが硬い問題の解消 ----
      // 軸実測(2026-07-21 synthbone): X+=つま先を下げる(底屈)。
      // 立位で脛(下向き)と足(踵→つま先)は約90°。90°からの差分が底屈/背屈
      {
        const footName = `DEF-foot.${side}`;
        const heel = p(f, side === "L" ? LM.heelL : LM.heelR);
        const toe = p(f, side === "L" ? LM.footL : LM.footR);
        const vFoot = vis(
          f,
          side === "L" ? LM.heelL : LM.heelR,
          side === "L" ? LM.footL : LM.footR,
          side === "L" ? LM.ankleL : LM.ankleR,
        );
        if (vFoot >= MIN_VIS) {
          const plantar = 90 - angleBetween(sub(an, kn), sub(toe, heel));
          bones[footName] = [clampDeg(plantar, 45), 0, 0];
        } else {
          markMissing(footName, keyframes.length);
        }
      }
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
      // 肩線ベクトルは L-R = 本人の左向き = 体フレームで(-1,0,0)が無捻り。
      // 旧式 atan2(-z, x) は基準が180°ずれ、常に±180付近を出力→クランプで±45に丸まり
      // 符号ノイズで毎フレームΔ90°パタパタしていた(2026-07-21 ハーネス実測で発覚)。
      // 正: 無捻りで0°になる atan2(z, -x)。さらにアンラップで±180跨ぎを連続化する
      const twistRaw = deg(Math.atan2(shLine[2], -shLine[0]));
      let twistCont = twistRaw;
      while (twistCont - prevTwistDeg > 180) twistCont -= 360;
      while (twistCont - prevTwistDeg < -180) twistCont += 360;
      prevTwistDeg = twistCont;
      const twist = Math.max(-135, Math.min(135, twistCont));
      const perX = clampDeg(leanF / 3, 40);
      const perY = clampDeg(twist / 3, 45);
      const perZ = clampDeg(-leanS / 3, 30);
      // 常に書き込む(しきい値で書いたり書かなかったりすると0との間で震える)
      const v: [number, number, number] = [perX, perY, perZ];
      bones["DEF-spine.001"] = v;
      bones["DEF-spine.002"] = v;
      bones["DEF-spine.003"] = v;
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
    // 接地補正済みの最下端距離を使う(逆立ち・床技でも接地関節基準で骨盤高さが出る)
    const drop = lowestSmooth[fi];
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

  // 欠測スパンの補完: 0.6秒以下は前後の実測から線形補間(オフライン処理の利点)。
  // それ超・冒頭末尾は最寄りの実測を保持。全キーへ値を書き切る
  // (キーに無いボーンはレスト姿勢に落ち、跳ねの原因になるため)
  const lerpDeg = (a: number, b2: number, t: number) => a + wrap180(b2 - a) * t;
  for (const [bn, idxs] of missing) {
    let i = 0;
    while (i < idxs.length) {
      let j = i;
      while (j + 1 < idxs.length && idxs[j + 1] === idxs[j] + 1) j++;
      const s = idxs[i];
      const e = idxs[j];
      const before = s > 0 ? keyframes[s - 1].bones[bn] : undefined;
      const after = e + 1 < keyframes.length ? keyframes[e + 1].bones[bn] : undefined;
      const spanSec = keyframes[e].time - keyframes[s].time;
      for (let k = s; k <= e; k++) {
        if (before && after && spanSec <= 0.6) {
          const t = (k - s + 1) / (e - s + 2);
          keyframes[k].bones[bn] = [
            lerpDeg(before[0], after[0], t),
            lerpDeg(before[1], after[1], t),
            lerpDeg(before[2], after[2], t),
          ];
        } else {
          const src = before ?? after;
          if (src) keyframes[k].bones[bn] = [src[0], src[1], src[2]];
        }
      }
      i = j + 1;
    }
  }

  // 単発スパイク除去(2026-07-21 Sol設計レビュー#4の「解いた後の回転を整える」層):
  // 各ボーンの回転列に角距離メディアン(窓3)。1フレームだけの外れ姿勢
  // (検出ノイズ由来の実回転100°超/フレームの往復)を潰し、持続する速い動きはそのまま通す
  {
    const boneNames = new Set<string>();
    for (const kf of keyframes) for (const bnn of Object.keys(kf.bones)) boneNames.add(bnn);
    for (const bn of boneNames) {
      const eulers = keyframes.map((kf) => kf.bones[bn]);
      const quats = eulers.map((e) => (e ? quatFromEulerXYZ(e) : null));
      for (let k = 1; k < keyframes.length - 1; k++) {
        const a = quats[k - 1];
        const q = quats[k];
        const c = quats[k + 1];
        if (!a || !q || !c) continue;
        // 3点のうち「他2点への角距離の和」が最小のものをメディアンとして採用
        const costA = quatAngle(a, q) + quatAngle(a, c);
        const costQ = quatAngle(q, a) + quatAngle(q, c);
        const costC = quatAngle(c, a) + quatAngle(c, q);
        if (costQ <= costA && costQ <= costC) continue; // 中央値が自分=変更なし
        const src = costA < costC ? k - 1 : k + 1;
        const e = eulers[src];
        if (e) keyframes[k].bones[bn] = [e[0], e[1], e[2]];
      }
    }
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
