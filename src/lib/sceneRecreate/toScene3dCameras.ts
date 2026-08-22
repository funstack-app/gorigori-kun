import type { CameraPresetId, Vec3 } from "../scene3d/types";
import type { Scene3dCameraSpec } from "../store/scene3d";
import {
  CAMERA_ANGLE_LABELS,
  SHOT_SIZE_LABELS,
  type CameraAngle,
  type CameraWork,
  type ShotAnalysis,
  type ShotSize,
} from "./types";

const CAMERA_WORK_PRESETS: Record<CameraWork, CameraPresetId> = {
  fixed: "fixed",
  pan: "pan",
  tilt: "crane",
  dolly: "pushIn",
  zoom: "pushIn",
  handheld: "handheld",
  crane: "crane",
  unknown: "fixed",
};

const SHOT_SIZE_PLACEMENT: Record<ShotSize, { lensMm: number; distanceM: number }> = {
  "extreme-close-up": { lensMm: 85, distanceM: 1.2 },
  "close-up": { lensMm: 65, distanceM: 2 },
  medium: { lensMm: 50, distanceM: 3.5 },
  long: { lensMm: 35, distanceM: 6 },
  "extreme-long": { lensMm: 24, distanceM: 10 },
  unknown: { lensMm: 50, distanceM: 3.5 },
};

type ResolvedAngle = Exclude<CameraAngle, "unknown">;

function resolveAngle(angle: CameraAngle): ResolvedAngle {
  switch (angle) {
    case "high-angle":
    case "low-angle":
    case "birds-eye":
    case "dutch":
      return angle;
    case "eye-level":
    case "unknown":
    default:
      return "eye-level";
  }
}

function anglePlacement(angle: ResolvedAngle, distanceM: number): {
  cameraPos: Vec3;
  lookAtPos: Vec3;
} {
  switch (angle) {
    case "high-angle":
      return { cameraPos: [0, 3.5, distanceM], lookAtPos: [0, 1.5, 0] };
    case "low-angle":
      return { cameraPos: [0, 0.6, distanceM], lookAtPos: [0, 1.5, 0] };
    case "birds-eye":
      // 完全な鉛直ではカメラの上方向と重なるため、Z をごく小さくずらす。
      return { cameraPos: [0, distanceM, 0.01], lookAtPos: [0, 0, 0] };
    case "dutch":
    case "eye-level":
    default:
      return { cameraPos: [0, 1.5, distanceM], lookAtPos: [0, 1.5, 0] };
  }
}

function cameraEndpoints(
  preset: CameraPresetId,
  cameraPos: Vec3,
  distanceM: number,
  angle: ResolvedAngle,
): { startPos: Vec3; endPos: Vec3 } {
  const [x, y, z] = cameraPos;
  switch (preset) {
    case "pan": {
      const travel = Math.max(0.6, distanceM * 0.25);
      return { startPos: [x - travel, y, z], endPos: [x + travel, y, z] };
    }
    case "pushIn":
      return angle === "birds-eye"
        ? { startPos: cameraPos, endPos: [x, Math.max(0.4, y * 0.6), z] }
        : { startPos: cameraPos, endPos: [x, y, distanceM * 0.6] };
    case "crane":
      return {
        startPos: cameraPos,
        endPos: [x, y + Math.max(1, distanceM * 0.25), z],
      };
    case "handheld":
      return {
        startPos: cameraPos,
        endPos: [x + 0.2, y + 0.08, angle === "birds-eye" ? z + 0.15 : z * 0.9],
      };
    case "fixed":
    default:
      return { startPos: cameraPos, endPos: cameraPos };
  }
}

/** 分析済みショットを Scene 3D のカメラ初期配置へ決定論で変換する。 */
export function shotToCameraSpec(shot: ShotAnalysis): Scene3dCameraSpec {
  const preset = CAMERA_WORK_PRESETS[shot.cameraWork] ?? CAMERA_WORK_PRESETS.unknown;
  const size = SHOT_SIZE_PLACEMENT[shot.shotSize] ?? SHOT_SIZE_PLACEMENT.unknown;
  const angle = resolveAngle(shot.angle);
  const { cameraPos, lookAtPos } = anglePlacement(angle, size.distanceM);
  const { startPos, endPos } = cameraEndpoints(preset, cameraPos, size.distanceM, angle);
  const sizeLabel = SHOT_SIZE_LABELS[shot.shotSize] ?? SHOT_SIZE_LABELS.unknown;
  const angleLabel = CAMERA_ANGLE_LABELS[shot.angle] ?? CAMERA_ANGLE_LABELS.unknown;
  const dutchNote = shot.angle === "dutch" ? "（傾きは手動）" : "";

  return {
    label: `S${shot.shotNumber} ${sizeLabel}・${angleLabel}${dutchNote}`,
    preset,
    lensMm: size.lensMm,
    startPos,
    endPos,
    lookAtPos,
  };
}

/** ショット列を既存シーンの末尾へ追加し、Scene 3D を開く。 */
export async function sendShotsToScene3d(shots: ShotAnalysis[]): Promise<number> {
  if (shots.length === 0) return 0;

  // 純関数だけを使うテストや分析画面の表示時には、Scene 3D の保存データを読まない。
  // 実際に書き出す瞬間だけ各ストアを読み込み、既存シーンの末尾へ追加する。
  const [{ useScene3d }, { useSkillMode }, { useToasts }] = await Promise.all([
    import("../store/scene3d"),
    import("../store/skillMode"),
    import("../store/toasts"),
  ]);
  const added = useScene3d
    .getState()
    .appendCamerasFromSpecs(shots.map((shot) => shotToCameraSpec(shot)));
  if (added === 0) return 0;

  // selectedSkillId を先に置くことで、続く enabled=true の同期が正しいスキルIDを見る。
  useSkillMode.getState().setSelectedSkillId("gori-scene-3d");
  useSkillMode.getState().setEnabled(true);
  useToasts.getState().push({
    kind: "success",
    text: `${added}台のカメラを Scene 3D に追加しました`,
    ttlMs: 4000,
  });
  return added;
}
