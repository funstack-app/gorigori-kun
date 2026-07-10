/**
 * scene3d 決定性評価器
 *
 * evaluateCamera(project, frame) が唯一のカメラ姿勢の真実。
 * R3Fプレビューも PNG連番書き出しも必ずここを通す。
 * three.js に依存しない(数値計算のみ)ことで、単体での決定性検証を可能にする。
 */

import type {
  CameraPose,
  SceneEntity,
  SceneProject,
  Vec3,
} from "./types";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function easeInOut(t: number): number {
  // smoothstep: 端で速度0になる標準イージング
  return t * t * (3 - 2 * t);
}

/** フレーム番号 → 正規化時間(0..1)。durationFrames=1 でも0除算しない */
export function frameToT(project: SceneProject, frame: number): number {
  const last = Math.max(1, project.durationFrames - 1);
  return clamp01(frame / last);
}

export function findEntity(
  project: SceneProject,
  id: string | null,
): SceneEntity | undefined {
  if (id == null) return undefined;
  return project.entities.find((e) => e.id === id);
}

/** 注視点: 対象エンティティの胸元(人型)/中心。対象なしなら原点付近 */
export function resolveLookAt(project: SceneProject): Vec3 {
  const target = findEntity(project, project.camera.targetEntityId);
  if (!target) return [0, 1, 0];
  const headHeight = target.kind === "mannequin" ? 1.3 * target.scale : 0.5 * target.scale;
  return [target.position[0], target.position[1] + headHeight, target.position[2]];
}

/** フルサイズ(縦24mm)換算の焦点距離 → 垂直画角(度) */
export function lensToFovDeg(lensMm: number): number {
  return (2 * Math.atan(12 / lensMm) * 180) / Math.PI;
}

/**
 * 決定論的な手持ち揺れ。乱数を使わず正弦波の合成で生成する
 * (同一フレーム→同一揺れ。書き出し再現性のため)
 */
function handheldOffset(frame: number, fps: number): Vec3 {
  const t = frame / fps;
  const amp = 0.03;
  return [
    amp * (Math.sin(t * 2.1) * 0.6 + Math.sin(t * 5.3 + 1.7) * 0.4),
    amp * (Math.sin(t * 2.9 + 0.8) * 0.5 + Math.sin(t * 6.1 + 2.4) * 0.5) * 0.6,
    amp * (Math.sin(t * 1.7 + 2.2) * 0.7 + Math.sin(t * 4.7 + 0.3) * 0.3),
  ];
}

/** Y軸周りに point を center 中心で角度(度)回転 */
function rotateAroundY(point: Vec3, center: Vec3, degrees: number): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const dx = point[0] - center[0];
  const dz = point[2] - center[2];
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    center[0] + dx * cos - dz * sin,
    point[1],
    center[2] + dx * sin + dz * cos,
  ];
}

/** カメラ姿勢の評価(決定性の中核) */
export function evaluateCamera(project: SceneProject, frame: number): CameraPose {
  const { camera } = project;
  const rawT = frameToT(project, frame);
  const t = camera.easing === "easeInOut" ? easeInOut(rawT) : rawT;
  const lookAt = resolveLookAt(project);

  let position: Vec3;
  switch (camera.preset) {
    case "fixed":
      position = camera.startPos;
      break;
    case "orbit":
      position = rotateAroundY(camera.startPos, lookAt, camera.orbitDegrees * t);
      break;
    case "handheld": {
      const base = lerpVec3(camera.startPos, camera.endPos, t);
      const off = handheldOffset(frame, project.fps);
      position = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
      break;
    }
    // pushIn / pullOut / track / pan / crane は「開始→終了の補間」で表現が共通。
    // 違いはUI側がプリセット選択時に endPos をどう初期化するかで作る
    default:
      position = lerpVec3(camera.startPos, camera.endPos, t);
      break;
  }

  return {
    position,
    lookAt,
    fovDeg: lensToFovDeg(camera.lensMm),
  };
}
