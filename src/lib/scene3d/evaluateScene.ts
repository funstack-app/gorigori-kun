/**
 * scene3d 決定性評価器
 *
 * evaluateCamera(project, globalFrame) が唯一のカメラ姿勢の真実。
 * R3Fプレビューも PNG連番書き出しも必ずここを通す。
 * three.js に依存しない(数値計算のみ)ことで、単体での決定性検証を可能にする。
 *
 * ショット構造: 通しフレーム(globalFrame)を「どのショットの何フレーム目か」に
 * 変換してからカメラを評価する。ショット境界はハードカット(カット割)
 */

import { createDefaultCameraMove } from "./types";
import type {
  CameraMove,
  CameraPose,
  SceneEntity,
  SceneProject,
  SceneShot,
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

/** 全ショット合計の尺(フレーム) */
export function totalDurationFrames(project: SceneProject): number {
  return project.shots.reduce((sum, s) => sum + s.durationFrames, 0);
}

/** 通しフレーム → 該当ショットとショット内フレーム */
export function locateShot(
  project: SceneProject,
  globalFrame: number,
): { shot: SceneShot; localFrame: number; shotIndex: number } {
  let remaining = Math.max(0, globalFrame);
  for (let i = 0; i < project.shots.length; i++) {
    const shot = project.shots[i];
    if (remaining < shot.durationFrames) {
      return { shot, localFrame: remaining, shotIndex: i };
    }
    remaining -= shot.durationFrames;
  }
  // 末尾を超えたら最終ショットの最終フレーム
  const last = project.shots[project.shots.length - 1];
  return {
    shot: last,
    localFrame: Math.max(0, last.durationFrames - 1),
    shotIndex: project.shots.length - 1,
  };
}

export function findEntity(
  project: SceneProject,
  id: string | null,
): SceneEntity | undefined {
  if (id == null) return undefined;
  return project.entities.find((e) => e.id === id);
}

/** ショットが使うカメラの動きを引く(参照切れは既定カメラでフォールバック) */
export function getShotMove(project: SceneProject, shot: SceneShot): CameraMove {
  const cam = project.cameras.find((c) => c.id === shot.cameraId) ?? project.cameras[0];
  return cam ? cam.move : createDefaultCameraMove();
}

/** 注視点: 対象エンティティの胸元(人型)/中心。対象なしなら原点付近 */
export function resolveLookAt(project: SceneProject, shot: SceneShot): Vec3 {
  const target = findEntity(project, getShotMove(project, shot).targetEntityId);
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

/** ショット内フレームでのカメラ姿勢評価 */
export function evaluateShotCamera(
  project: SceneProject,
  shot: SceneShot,
  localFrame: number,
): CameraPose {
  const camera = getShotMove(project, shot);
  const lastFrame = Math.max(1, shot.durationFrames - 1);
  const rawT = clamp01(localFrame / lastFrame);
  const eased = camera.easing === "easeInOut" ? easeInOut(rawT) : rawT;
  // moveWindow: カメラの動きのうち使う区間へマップ(分割カットの続き再生)
  const [w0, w1] = shot.moveWindow ?? [0, 1];
  const t = w0 + (w1 - w0) * eased;
  const lookAt = resolveLookAt(project, shot);

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
      const off = handheldOffset(localFrame, project.fps);
      position = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
      break;
    }
    // pushIn / pullOut / track / pan / crane は「開始→終了の補間」で表現が共通。
    // midPos があれば2次ベジェで通り道を曲げる(軌道の自由調整)
    default: {
      const mid = camera.midPos;
      if (mid) {
        const u = 1 - t;
        position = [
          u * u * camera.startPos[0] + 2 * u * t * mid[0] + t * t * camera.endPos[0],
          u * u * camera.startPos[1] + 2 * u * t * mid[1] + t * t * camera.endPos[1],
          u * u * camera.startPos[2] + 2 * u * t * mid[2] + t * t * camera.endPos[2],
        ];
      } else {
        position = lerpVec3(camera.startPos, camera.endPos, t);
      }
      break;
    }
  }

  return {
    position,
    lookAt,
    fovDeg: lensToFovDeg(camera.lensMm),
  };
}

/** カメラ姿勢の評価(決定性の中核)。通しフレームで指定する */
export function evaluateCamera(project: SceneProject, globalFrame: number): CameraPose {
  const { shot, localFrame } = locateShot(project, globalFrame);
  return evaluateShotCamera(project, shot, localFrame);
}
