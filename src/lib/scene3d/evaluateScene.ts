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

/** 注視点: 被写体指定なら追従(歩行中はその実位置)、なしなら固定の注視点 */
export function resolveLookAt(
  project: SceneProject,
  shot: SceneShot,
  globalFrame = 0,
): Vec3 {
  const move = getShotMove(project, shot);
  const target = findEntity(project, move.targetEntityId);
  if (!target) return move.lookAtPos ?? [0, 1, 0];
  const pose = evaluateEntityPose(project, target, globalFrame);
  const headHeight = target.kind === "mannequin" ? 1.3 * target.scale : 0.5 * target.scale;
  return [pose.position[0], pose.position[1] + headHeight, pose.position[2]];
}

/** 歩行パラメータ(決定論。速度m/s / 1サイクルの歩幅m) */
const GAIT = {
  walk: { speed: 1.4, cycle: 1.32 },
  run: { speed: 3.4, cycle: 2.2 },
} as const;

export type EntityPose = {
  position: Vec3;
  rotationY: number;
  /** 歩行サイクル: moving中は phase が 0..1 で循環 */
  gait: { moving: boolean; phase: number; run: boolean };
  /** 移動系クリップのみ: 経路を走破するのに要する秒数(到着後アクションの開始時刻) */
  travelSeconds?: number;
};

/**
 * 折れ線パスに沿って speed で進んだ位置(プロシージャル歩行と移動系クリップの共通経路)。
 * traveled はタイムライン先頭からの移動距離(m)。歩行位相の算出に使う
 */
function followPath(
  entity: SceneEntity,
  path: Vec3[],
  speed: number,
  fps: number,
  globalFrame: number,
): { position: Vec3; rotationY: number; traveled: number; arrived: boolean } {
  const traveled = (Math.max(0, globalFrame) / fps) * speed;
  const points: Vec3[] = [entity.position, ...path];

  let remaining = traveled;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-6) continue;
    const rotY = Math.atan2(dx, dz); // +Zが正面
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return {
        position: [a[0] + dx * t, entity.position[1], a[2] + dz * t],
        rotationY: rotY,
        traveled,
        arrived: false,
      };
    }
    remaining -= segLen;
  }
  // 到着: 最終点で最後の向きのまま止まる
  const last = points[points.length - 1];
  const prev = points[points.length - 2] ?? entity.position;
  const rotY = Math.atan2(last[0] - prev[0], last[2] - prev[2]);
  return {
    position: [last[0], entity.position[1], last[2]],
    rotationY: Number.isFinite(rotY) ? rotY : entity.rotationY,
    traveled,
    arrived: true,
  };
}

/**
 * 人物の位置・向き・歩行位相の決定性評価。
 * モーションはタイムライン全体で再生され、経路を歩き切ったら到着点で立ち止まる
 */
export function evaluateEntityPose(
  project: SceneProject,
  entity: SceneEntity,
  globalFrame: number,
): EntityPose {
  const idle: EntityPose = {
    position: entity.position,
    rotationY: entity.rotationY,
    gait: { moving: false, phase: 0, run: false },
  };
  const motion = entity.motion;
  if (!motion || entity.kind !== "mannequin") return idle;

  if (motion.type === "clip") {
    // 移動系クリップ: 焼き込まれた速度でパスに沿って移動(手足はミキサーが駆動)
    const speed = motion.speed ?? 0;
    const path = motion.path ?? [];
    if (speed <= 0 || path.length === 0) return idle;
    const p = followPath(entity, path, speed, project.fps, globalFrame);
    // 到着時刻(秒)。ビューポートが到着後アクションの開始時刻に使う
    const points: Vec3[] = [entity.position, ...path];
    let pathLen = 0;
    for (let i = 0; i < points.length - 1; i++) {
      pathLen += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][2] - points[i][2]);
    }
    return {
      position: p.position,
      rotationY: p.rotationY,
      gait: { moving: !p.arrived, phase: 0, run: false },
      travelSeconds: pathLen / speed,
    };
  }

  if (motion.path.length === 0) return idle;
  const g = GAIT[motion.type];
  const p = followPath(entity, motion.path, g.speed, project.fps, globalFrame);
  if (p.arrived) {
    return {
      position: p.position,
      rotationY: p.rotationY,
      gait: { moving: false, phase: 0, run: false },
    };
  }
  return {
    position: p.position,
    rotationY: p.rotationY,
    gait: { moving: true, phase: (p.traveled % g.cycle) / g.cycle, run: motion.type === "run" },
  };
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
  globalFrame?: number,
): CameraPose {
  const camera = getShotMove(project, shot);
  const lastFrame = Math.max(1, shot.durationFrames - 1);
  const rawT = clamp01(localFrame / lastFrame);
  const eased = camera.easing === "easeInOut" ? easeInOut(rawT) : rawT;
  // moveWindow: カメラの動きのうち使う区間へマップ(分割カットの続き再生)
  const [w0, w1] = shot.moveWindow ?? [0, 1];
  const t = w0 + (w1 - w0) * eased;
  const lookAt = resolveLookAt(project, shot, globalFrame ?? localFrame);

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
  return evaluateShotCamera(project, shot, localFrame, globalFrame);
}
