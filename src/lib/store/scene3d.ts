/**
 * scene3d エディタ状態ストア
 *
 * SceneProject(正本データ)と編集UI状態(選択・再生・ドラッグ)を分離して保持する。
 * カメラ姿勢の計算はここでは行わない(evaluateScene.ts が唯一の真実)。
 */

import { create } from "zustand";

import { createDefaultProject, SCENE_FPS } from "../scene3d/types";
import type {
  CameraPresetId,
  SceneEntity,
  SceneEntityKind,
  SceneProject,
  Vec3,
} from "../scene3d/types";
import { resolveLookAt } from "../scene3d/evaluateScene";

let entitySeq = 1;

const ENTITY_LABELS: Record<SceneEntityKind, string> = {
  mannequin: "人物",
  sphere: "球",
  box: "箱",
};

/**
 * プリセット選択時のカメラ初期配置。注視対象の位置を基準に
 * 「それらしい開始/終了位置」を決める(ユーザーはドラッグで直せる)
 */
function presetPlacement(
  preset: CameraPresetId,
  target: Vec3,
): { startPos: Vec3; endPos: Vec3; orbitDegrees: number } {
  const [tx, , tz] = target;
  const eye = 1.4; // 目線の高さ
  switch (preset) {
    case "pushIn":
      return { startPos: [tx, eye, tz + 5], endPos: [tx, eye - 0.1, tz + 1.8], orbitDegrees: 0 };
    case "pullOut":
      return { startPos: [tx, eye - 0.1, tz + 1.8], endPos: [tx, eye, tz + 5], orbitDegrees: 0 };
    case "track":
      return { startPos: [tx - 3, eye, tz + 3], endPos: [tx + 3, eye, tz + 3], orbitDegrees: 0 };
    case "pan":
      return { startPos: [tx - 1.2, eye, tz + 3.5], endPos: [tx + 1.2, eye, tz + 3.5], orbitDegrees: 0 };
    case "orbit":
      return { startPos: [tx, eye, tz + 4], endPos: [tx, eye, tz + 4], orbitDegrees: 120 };
    case "crane":
      return { startPos: [tx + 2, 1.0, tz + 4], endPos: [tx + 2.5, 3.5, tz + 4.5], orbitDegrees: 0 };
    case "handheld":
      return { startPos: [tx + 0.4, eye, tz + 3.2], endPos: [tx + 0.6, eye, tz + 2.6], orbitDegrees: 0 };
    case "fixed":
    default:
      return { startPos: [tx, eye, tz + 4], endPos: [tx, eye, tz + 4], orbitDegrees: 0 };
  }
}

type Scene3dState = {
  project: SceneProject;
  selectedEntityId: string | null;
  /** 再生中フラグ。再生中は evaluateCamera がビューを乗っ取る */
  playing: boolean;
  /** カメラビュー(撮影カメラの画で確認)トグル */
  cameraView: boolean;
  /** 現在フレーム(再生・スクラブ共用。表示は floor する) */
  currentFrame: number;
  /** 床ドラッグ中のエンティティID(OrbitControls無効化に使う) */
  draggingEntityId: string | null;

  addEntity: (kind: SceneEntityKind) => void;
  removeEntity: (id: string) => void;
  selectEntity: (id: string | null) => void;
  moveEntity: (id: string, position: Vec3) => void;
  rotateEntity: (id: string, rotationY: number) => void;
  setDragging: (id: string | null) => void;

  setCameraPreset: (preset: CameraPresetId) => void;
  setCameraTarget: (entityId: string | null) => void;
  setLens: (lensMm: number) => void;
  setOrbitDegrees: (degrees: number) => void;
  setDurationSeconds: (seconds: number) => void;
  moveCameraEndpoint: (which: "start" | "end", position: Vec3) => void;

  setPlaying: (playing: boolean) => void;
  setCameraView: (on: boolean) => void;
  setCurrentFrame: (frame: number) => void;
  resetProject: () => void;
};

export const useScene3d = create<Scene3dState>((set, get) => ({
  project: createDefaultProject(),
  selectedEntityId: "actor-1",
  playing: false,
  cameraView: false,
  currentFrame: 0,
  draggingEntityId: null,

  addEntity: (kind) => {
    const { project } = get();
    const count = project.entities.filter((e) => e.kind === kind).length + 1;
    const id = `${kind}-${Date.now()}-${entitySeq++}`;
    const entity: SceneEntity = {
      id,
      kind,
      label: `${ENTITY_LABELS[kind]}${count}`,
      // 既存と重ならないよう少しずらして置く(その後ユーザーがドラッグ)
      position: [((count - 1) % 4) * 1.2 - 1.2, 0, Math.floor((count - 1) / 4) * 1.2],
      rotationY: 0,
      scale: 1,
    };
    set({
      project: { ...project, entities: [...project.entities, entity] },
      selectedEntityId: id,
    });
  },

  removeEntity: (id) => {
    const { project, selectedEntityId } = get();
    const entities = project.entities.filter((e) => e.id !== id);
    const camera =
      project.camera.targetEntityId === id
        ? { ...project.camera, targetEntityId: entities[0]?.id ?? null }
        : project.camera;
    set({
      project: { ...project, entities, camera },
      selectedEntityId: selectedEntityId === id ? null : selectedEntityId,
    });
  },

  selectEntity: (id) => set({ selectedEntityId: id }),

  moveEntity: (id, position) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, position } : e,
        ),
      },
    });
  },

  rotateEntity: (id, rotationY) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, rotationY } : e,
        ),
      },
    });
  },

  setDragging: (id) => set({ draggingEntityId: id }),

  setCameraPreset: (preset) => {
    const { project } = get();
    const target = resolveLookAt(project);
    const placement = presetPlacement(preset, target);
    set({
      project: { ...project, camera: { ...project.camera, preset, ...placement } },
      currentFrame: 0,
    });
  },

  setCameraTarget: (entityId) => {
    const { project } = get();
    set({ project: { ...project, camera: { ...project.camera, targetEntityId: entityId } } });
  },

  setLens: (lensMm) => {
    const { project } = get();
    set({ project: { ...project, camera: { ...project.camera, lensMm } } });
  },

  setOrbitDegrees: (orbitDegrees) => {
    const { project } = get();
    set({ project: { ...project, camera: { ...project.camera, orbitDegrees } } });
  },

  setDurationSeconds: (seconds) => {
    const { project } = get();
    const clamped = Math.min(15, Math.max(2, Math.round(seconds)));
    set({
      project: { ...project, durationFrames: clamped * SCENE_FPS },
      currentFrame: 0,
    });
  },

  moveCameraEndpoint: (which, position) => {
    const { project } = get();
    const key = which === "start" ? "startPos" : "endPos";
    set({ project: { ...project, camera: { ...project.camera, [key]: position } } });
  },

  setPlaying: (playing) => set({ playing }),
  setCameraView: (cameraView) => set({ cameraView }),
  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  resetProject: () =>
    set({
      project: createDefaultProject(),
      selectedEntityId: "actor-1",
      playing: false,
      cameraView: false,
      currentFrame: 0,
    }),
}));
