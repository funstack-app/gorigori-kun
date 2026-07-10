/**
 * scene3d エディタ状態ストア
 *
 * SceneProject(正本データ)と編集UI状態(選択・再生・ドラッグ)を分離して保持する。
 * カメラ姿勢の計算はここでは行わない(evaluateScene.ts が唯一の真実)。
 *
 * ショット構造: project.shots がカット割。selectedShotId のショットに対して
 * カメラ操作(プリセット/レンズ/尺)が効く。CapCut風タイムラインの正本
 */

import { create } from "zustand";

import { createDefaultProject, createDefaultShot, SCENE_FPS } from "../scene3d/types";
import type {
  CameraPresetId,
  SceneAspectRatio,
  SceneEntity,
  SceneEntityKind,
  SceneProject,
  SceneShot,
  Vec3,
} from "../scene3d/types";
import {
  getShotMove,
  locateShot,
  resolveLookAt,
  totalDurationFrames,
} from "../scene3d/evaluateScene";

let entitySeq = 1;
let shotSeq = 1;

const ENTITY_LABELS: Record<SceneEntityKind, string> = {
  mannequin: "人物",
  sphere: "球",
  box: "箱",
  wall: "壁",
  column: "柱",
  stairs: "階段",
  building: "ビル",
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

export type Scene3dExportStatus =
  | { phase: "idle" }
  | { phase: "rendering"; done: number; total: number }
  | { phase: "encoding" }
  | { phase: "done"; mp4Path: string | null; firstFramePath: string | null; framesDir: string }
  | { phase: "error"; message: string };

type Scene3dState = {
  project: SceneProject;
  selectedEntityId: string | null;
  selectedShotId: string;
  /** カメラが選択対象になっているか(選択物体の黄色ハイライトをカメラに向ける) */
  cameraSelected: boolean;
  /** 再生中フラグ。再生中は evaluateCamera がビューを乗っ取る */
  playing: boolean;
  /** カメラビュー(撮影カメラの画で確認)トグル */
  cameraView: boolean;
  /** ペインが2枚以上あるか(編集ビューへのカメラ乗っ取りを止める判定に使う) */
  splitView: boolean;
  /** ペイン分割レイアウト(Blender風ツリー) */
  paneLayout: PaneNode;
  /** 現在の通しフレーム(再生・スクラブ共用。表示は floor する) */
  currentFrame: number;
  /** 床ドラッグ中のエンティティID(OrbitControls無効化に使う) */
  draggingEntityId: string | null;
  /** 再生を開始した位置(停止時にここへ戻る) */
  playStartFrame: number;
  /** タイムラインの縮尺(1秒あたりのpx) */
  timelineZoom: number;
  /**
   * 書き出し要求ノンス。increment すると Viewport 内の ExportDriver が
   * 書き出しを開始する(UIボタン → Canvas内コンポーネントへの橋渡し)
   */
  exportRequest: number;
  exportStatus: Scene3dExportStatus;

  addEntity: (kind: SceneEntityKind) => void;
  removeEntity: (id: string) => void;
  selectEntity: (id: string | null) => void;
  moveEntity: (id: string, position: Vec3) => void;
  rotateEntity: (id: string, rotationY: number) => void;
  scaleEntity: (id: string, scale: number) => void;
  setEntityFloors: (id: string, floors: number) => void;
  setEntityParam: (id: string, key: "width" | "height" | "depth", value: number) => void;
  setDragging: (id: string | null) => void;

  /** カット操作(CapCut風タイムライン) */
  selectShot: (id: string) => void;
  /** カメラをクリック選択(カットの選択 + カメラのハイライト) */
  selectCameraOfShot: (shotId: string) => void;
  addShot: () => void;
  removeShot: (id: string) => void;
  reorderShots: (activeId: string, overId: string) => void;
  setShotDurationFrames: (id: string, frames: number) => void;
  /** 再生ヘッド位置でカットを2分割(ハサミ)。カメラは分割点の姿勢を引き継ぐ */
  splitShotAtPlayhead: () => void;

  /** カメラ機材の管理(マルチカム) */
  addCamera: () => void;
  removeCamera: (cameraId: string) => void;
  assignShotCamera: (shotId: string, cameraId: string) => void;

  /** 以下のカメラ操作は selectedShotId のショットが使うカメラに効く */
  setCameraPreset: (preset: CameraPresetId) => void;
  setCameraTarget: (entityId: string | null) => void;
  setLens: (lensMm: number) => void;
  setOrbitDegrees: (degrees: number) => void;
  moveCameraEndpoint: (which: "start" | "end", position: Vec3) => void;
  /** 軌道の中間点を動かして通り道を曲げる(nullで直線に戻す) */
  moveCameraMid: (position: Vec3 | null) => void;

  setPlaying: (playing: boolean) => void;
  /**
   * 再生/停止トグル。再生開始時の位置を覚え、停止時にそこへ戻る
   * (編集ソフトの標準挙動。スペースキーと再生ボタンの共通経路)
   */
  togglePlay: () => void;
  setCameraView: (on: boolean) => void;
  toggleSplitView: () => void;
  applyPaneOp: (op: PaneOp) => void;
  setCurrentFrame: (frame: number) => void;
  setAspectRatio: (ratio: SceneAspectRatio) => void;
  setTimelineZoom: (pxPerSec: number) => void;
  resetProject: () => void;

  /** 書き出しを要求する(実行は Viewport 内 ExportDriver) */
  requestExport: () => void;
  setExportStatus: (status: Scene3dExportStatus) => void;
};

/** 選択中ショットを取得(消えていたら先頭にフォールバック) */
export function getSelectedShot(state: Pick<Scene3dState, "project" | "selectedShotId">): SceneShot {
  return (
    state.project.shots.find((s) => s.id === state.selectedShotId) ?? state.project.shots[0]
  );
}

/** ショットの開始位置(通しフレーム) */
export function shotStartFrame(project: SceneProject, shotId: string): number {
  let acc = 0;
  for (const s of project.shots) {
    if (s.id === shotId) return acc;
    acc += s.durationFrames;
  }
  return 0;
}

function updateShot(
  project: SceneProject,
  shotId: string,
  patch: (shot: SceneShot) => SceneShot,
): SceneProject {
  return {
    ...project,
    shots: project.shots.map((s) => (s.id === shotId ? patch(s) : s)),
  };
}

/** 選択カットが使っているカメラの動きを更新する */
function updateSelectedCameraMove(
  state: Pick<Scene3dState, "project" | "selectedShotId">,
  patch: (move: import("../scene3d/types").CameraMove) => import("../scene3d/types").CameraMove,
): SceneProject {
  const shot = getSelectedShot(state);
  return {
    ...state.project,
    cameras: state.project.cameras.map((c) =>
      c.id === shot.cameraId ? { ...c, move: patch(c.move) } : c,
    ),
  };
}

/** カット名を並び順で振り直す(カット1, カット2, ...) */
function renumberShots(shots: SceneShot[]): SceneShot[] {
  return shots.map((sh, i) => ({ ...sh, label: `カット${i + 1}` }));
}

export const useScene3d = create<Scene3dState>((set, get) => ({
  project: createDefaultProject(),
  selectedEntityId: "actor-1",
  selectedShotId: "shot-1",
  cameraSelected: false,
  playing: false,
  cameraView: false,
  splitView: countLeaves(loadPaneLayout()) > 1,
  paneLayout: loadPaneLayout(),
  currentFrame: 0,
  draggingEntityId: null,
  playStartFrame: 0,
  timelineZoom: (() => {
    const saved = Number(localStorage.getItem("scene3d.timeline.zoom"));
    return Number.isFinite(saved) && saved >= 8 && saved <= 120 ? saved : 28;
  })(),
  exportRequest: 0,
  exportStatus: { phase: "idle" },

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
      ...(kind === "building" ? { params: { floors: 3 } } : {}),
    };
    set({
      project: { ...project, entities: [...project.entities, entity] },
      selectedEntityId: id,
    });
  },

  removeEntity: (id) => {
    const { project, selectedEntityId } = get();
    const entities = project.entities.filter((e) => e.id !== id);
    // 各カメラの注視対象からも外す
    const cameras = project.cameras.map((c) =>
      c.move.targetEntityId === id
        ? { ...c, move: { ...c.move, targetEntityId: entities[0]?.id ?? null } }
        : c,
    );
    set({
      project: { ...project, entities, cameras },
      selectedEntityId: selectedEntityId === id ? null : selectedEntityId,
    });
  },

  selectEntity: (id) => set({ selectedEntityId: id, cameraSelected: false }),

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

  scaleEntity: (id, scale) => {
    const { project } = get();
    const clamped = Math.max(0.3, Math.min(4, scale));
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, scale: clamped } : e,
        ),
      },
    });
  },

  setEntityFloors: (id, floors) => {
    const { project } = get();
    const clamped = Math.max(1, Math.min(12, Math.round(floors)));
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, params: { ...e.params, floors: clamped } } : e,
        ),
      },
    });
  },

  setEntityParam: (id, key, value) => {
    const { project } = get();
    const clamped = Math.max(0.1, Math.min(30, value));
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, params: { ...e.params, [key]: clamped } } : e,
        ),
      },
    });
  },

  setDragging: (id) => set({ draggingEntityId: id }),

  selectShot: (id) => {
    const { project } = get();
    if (!project.shots.some((s) => s.id === id)) return;
    // 選んだカットの頭に再生ヘッドを移動(どこを編集しているか分かるように)
    set({ selectedShotId: id, currentFrame: shotStartFrame(project, id) });
  },

  selectCameraOfShot: (shotId) => {
    const { project } = get();
    if (!project.shots.some((s) => s.id === shotId)) return;
    set({
      selectedShotId: shotId,
      currentFrame: shotStartFrame(project, shotId),
      cameraSelected: true,
      selectedEntityId: null,
    });
  },

  addShot: () => {
    const { project } = get();
    const id = `shot-${Date.now()}-${shotSeq++}`;
    const selected = getSelectedShot(get());
    // 選択中カットの複製(同じカメラを使い回す=マルチカム)
    const shot: SceneShot = {
      ...selected,
      id,
      moveWindow: selected.moveWindow ? [...selected.moveWindow] : undefined,
    };
    const next = { ...project, shots: renumberShots([...project.shots, shot]) };
    set({ project: next, selectedShotId: id, currentFrame: shotStartFrame(next, id) });
  },

  addCamera: () => {
    const { project } = get();
    const selectedMove = getShotMove(project, getSelectedShot(get()));
    const camId = `camera-${Date.now()}-${shotSeq++}`;
    const camera = {
      id: camId,
      label: `カメラ${project.cameras.length + 1}`,
      // 現在のカメラの複製から始める(少し横にずらす)
      move: {
        ...selectedMove,
        startPos: [selectedMove.startPos[0] + 1.5, selectedMove.startPos[1], selectedMove.startPos[2]] as Vec3,
        endPos: [selectedMove.endPos[0] + 1.5, selectedMove.endPos[1], selectedMove.endPos[2]] as Vec3,
        midPos: null,
      },
    };
    // 新カメラを使う新カットも末尾に追加(カメラを足す=マルチカットを作る)
    const shotId = `shot-${Date.now()}-${shotSeq++}`;
    const shot: SceneShot = createDefaultShot(shotId, "", camId);
    const next = {
      ...project,
      cameras: [...project.cameras, camera],
      shots: renumberShots([...project.shots, shot]),
    };
    set({
      project: next,
      selectedShotId: shotId,
      cameraSelected: true,
      selectedEntityId: null,
      currentFrame: shotStartFrame(next, shotId),
    });
  },

  removeCamera: (cameraId) => {
    const { project } = get();
    if (project.cameras.length <= 1) return;
    if (project.shots.some((sh) => sh.cameraId === cameraId)) return; // 使用中は消せない
    set({
      project: {
        ...project,
        cameras: project.cameras.filter((c) => c.id !== cameraId),
      },
    });
  },

  assignShotCamera: (shotId, cameraId) => {
    const { project } = get();
    if (!project.cameras.some((c) => c.id === cameraId)) return;
    set({
      project: updateShot(project, shotId, (sh) => ({
        ...sh,
        cameraId,
        moveWindow: undefined,
      })),
    });
  },

  removeShot: (id) => {
    const { project, selectedShotId } = get();
    if (project.shots.length <= 1) return; // 最低1カットは残す
    const shots = renumberShots(project.shots.filter((s) => s.id !== id));
    // 使い手がいなくなったカメラ(レーン)は一緒に片付ける
    const cameras = project.cameras.filter((c) =>
      shots.some((sh) => sh.cameraId === c.id),
    );
    const next = { ...project, shots, cameras };
    const nextSelected = selectedShotId === id ? shots[0].id : selectedShotId;
    set({
      project: next,
      selectedShotId: nextSelected,
      currentFrame: Math.min(get().currentFrame, totalDurationFrames(next) - 1),
    });
  },

  reorderShots: (activeId, overId) => {
    const { project } = get();
    const from = project.shots.findIndex((s) => s.id === activeId);
    const to = project.shots.findIndex((s) => s.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const shots = [...project.shots];
    const [moved] = shots.splice(from, 1);
    shots.splice(to, 0, moved);
    set({ project: { ...project, shots: renumberShots(shots) } });
  },

  splitShotAtPlayhead: () => {
    const { project, currentFrame } = get();
    const MIN = SCENE_FPS / 2; // 両側最低0.5秒
    const frame = Math.floor(currentFrame);
    const { shot, localFrame, shotIndex } = locateShot(project, frame);
    if (localFrame < MIN || shot.durationFrames - localFrame < MIN) return;

    // 分割点の「動きの進み具合」を窓にマップ(位置の連続性が正確に保たれる)
    const move = getShotMove(project, shot);
    const rawT = localFrame / Math.max(1, shot.durationFrames - 1);
    const te = move.easing === "easeInOut" ? rawT * rawT * (3 - 2 * rawT) : rawT;
    const [w0, w1] = shot.moveWindow ?? [0, 1];
    const tSplit = w0 + (w1 - w0) * te;

    const secondId = `shot-${Date.now()}-${shotSeq++}`;
    const first: SceneShot = { ...shot, durationFrames: localFrame, moveWindow: [w0, tSplit] };
    const second: SceneShot = {
      ...shot,
      id: secondId,
      durationFrames: shot.durationFrames - localFrame,
      moveWindow: [tSplit, w1],
    };
    const shots = [...project.shots];
    shots.splice(shotIndex, 1, first, second);
    set({
      project: { ...project, shots: renumberShots(shots) },
      selectedShotId: secondId,
    });
  },

  setShotDurationFrames: (id, frames) => {
    const { project } = get();
    const clamped = Math.max(SCENE_FPS, Math.min(15 * SCENE_FPS, Math.round(frames)));
    set({ project: updateShot(project, id, (s) => ({ ...s, durationFrames: clamped })) });
  },

  setCameraPreset: (preset) => {
    const { project } = get();
    const shot = getSelectedShot(get());
    const target = resolveLookAt(project, shot);
    const placement = presetPlacement(preset, target);
    // 動きが変わったら、このカメラを使う全カットの窓をリセット
    const next = updateSelectedCameraMove(get(), (m) => ({
      ...m,
      preset,
      ...placement,
      midPos: null,
    }));
    set({
      project: {
        ...next,
        shots: next.shots.map((sh) =>
          sh.cameraId === shot.cameraId ? { ...sh, moveWindow: undefined } : sh,
        ),
      },
      currentFrame: shotStartFrame(project, shot.id),
    });
  },

  setCameraTarget: (entityId) => {
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, targetEntityId: entityId })) });
  },

  setLens: (lensMm) => {
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, lensMm })) });
  },

  setOrbitDegrees: (orbitDegrees) => {
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, orbitDegrees })) });
  },

  moveCameraEndpoint: (which, position) => {
    const key = which === "start" ? "startPos" : "endPos";
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, [key]: position })) });
  },

  moveCameraMid: (position) => {
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, midPos: position })) });
  },

  setPlaying: (playing) => set({ playing }),
  togglePlay: () => {
    const { playing, currentFrame, playStartFrame } = get();
    if (playing) {
      // 停止: 再生を始めた位置に戻る
      set({ playing: false, currentFrame: playStartFrame });
    } else {
      set({ playing: true, playStartFrame: currentFrame });
    }
  },
  setCameraView: (cameraView) => set({ cameraView }),
  toggleSplitView: () => {
    // プリセット切替: 1枚 → 編集+カメラの2枚 / 2枚以上 → 編集1枚に戻す
    const { paneLayout } = get();
    const next: PaneNode =
      countLeaves(paneLayout) === 1
        ? splitLeafNode(paneLayout, firstLeafId(paneLayout), "row")
        : defaultPaneLayout();
    localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(next));
    set({ paneLayout: next, splitView: countLeaves(next) > 1, cameraView: false });
  },

  applyPaneOp: (op) => {
    const { paneLayout } = get();
    let next: PaneNode | null = paneLayout;
    switch (op.type) {
      case "split":
        next = splitLeafNode(paneLayout, op.id, op.dir);
        break;
      case "close":
        next = ensureEditorLeaf(closeLeafNode(paneLayout, op.id) ?? defaultPaneLayout(), "");
        break;
      case "ratio":
        next = setNodeRatio(paneLayout, op.id, op.delta);
        break;
      case "toggleView":
        // 編集ビューゼロを許さない(視点操作不能になるため)。カメラ⇄編集の入替として振る舞う
        next = ensureEditorLeaf(toggleLeafView(paneLayout, op.id), op.id);
        break;
      case "reset":
        next = defaultPaneLayout();
        break;
    }
    localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(next));
    set({ paneLayout: next, splitView: countLeaves(next) > 1 });
  },
  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setAspectRatio: (aspectRatio) => {
    const { project } = get();
    set({ project: { ...project, aspectRatio } });
  },
  setTimelineZoom: (pxPerSec) => {
    const clamped = Math.max(8, Math.min(120, Math.round(pxPerSec)));
    localStorage.setItem("scene3d.timeline.zoom", String(clamped));
    set({ timelineZoom: clamped });
  },
  resetProject: () =>
    set({
      project: createDefaultProject(),
      selectedEntityId: "actor-1",
      selectedShotId: "shot-1",
      playing: false,
      cameraView: false,
      currentFrame: 0,
      exportStatus: { phase: "idle" },
    }),

  requestExport: () => {
    const { exportStatus } = get();
    const busy = exportStatus.phase === "rendering" || exportStatus.phase === "encoding";
    if (busy) return;
    set({ playing: false, exportRequest: get().exportRequest + 1 });
  },
  setExportStatus: (exportStatus) => set({ exportStatus }),
}));


/* ---------------------------------- ペイン分割レイアウト(Blender風) ---------------------------------- */

export type PaneView = "editor" | "camera";
export type PaneNode =
  | { kind: "leaf"; id: string; view: PaneView }
  | { kind: "split"; id: string; dir: "row" | "col"; ratio: number; a: PaneNode; b: PaneNode };

const PANE_LAYOUT_KEY = "scene3d.paneLayout.v1";
let paneSeq = 1;

function defaultPaneLayout(): PaneNode {
  return { kind: "leaf", id: "pane-root", view: "editor" };
}

function loadPaneLayout(): PaneNode {
  try {
    const raw = localStorage.getItem(PANE_LAYOUT_KEY);
    if (!raw) return defaultPaneLayout();
    return JSON.parse(raw) as PaneNode;
  } catch {
    return defaultPaneLayout();
  }
}

export function countLeaves(node: PaneNode): number {
  return node.kind === "leaf" ? 1 : countLeaves(node.a) + countLeaves(node.b);
}

export function firstLeafId(node: PaneNode): string {
  return node.kind === "leaf" ? node.id : firstLeafId(node.a);
}

function splitLeafNode(node: PaneNode, id: string, dir: "row" | "col"): PaneNode {
  if (node.kind === "leaf") {
    if (node.id !== id) return node;
    // 分割: 元ペインを a に、新ペイン(カメラの画)を b に
    return {
      kind: "split",
      id: `split-${Date.now()}-${paneSeq++}`,
      dir,
      ratio: 0.5,
      a: node,
      b: { kind: "leaf", id: `pane-${Date.now()}-${paneSeq++}`, view: "camera" },
    };
  }
  return { ...node, a: splitLeafNode(node.a, id, dir), b: splitLeafNode(node.b, id, dir) };
}

function closeLeafNode(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const a = closeLeafNode(node.a, id);
  const b = closeLeafNode(node.b, id);
  if (a && b) return { ...node, a, b };
  return a ?? b; // 片方が消えたら残りが繰り上がる(Blenderの統合と同じ)
}

function setNodeRatio(node: PaneNode, id: string, delta: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === id) {
    // デルタ加算: ストア内の最新値基準なのでドラッグ中の取りこぼしが起きない
    return { ...node, ratio: Math.max(0.15, Math.min(0.85, node.ratio + delta)) };
  }
  return { ...node, a: setNodeRatio(node.a, id, delta), b: setNodeRatio(node.b, id, delta) };
}

function toggleLeafView(node: PaneNode, id: string): PaneNode {
  if (node.kind === "leaf") {
    if (node.id !== id) return node;
    return { ...node, view: node.view === "editor" ? "camera" : "editor" };
  }
  return { ...node, a: toggleLeafView(node.a, id), b: toggleLeafView(node.b, id) };
}

function hasEditorLeaf(node: PaneNode): boolean {
  return node.kind === "leaf" ? node.view === "editor" : hasEditorLeaf(node.a) || hasEditorLeaf(node.b);
}

/** 編集ビューが1枚も無くなる操作なら、他の先頭ペインを編集に切替えて保証する */
function ensureEditorLeaf(node: PaneNode, excludeId: string): PaneNode {
  if (hasEditorLeaf(node)) return node;
  let converted = false;
  const convertFirst = (n: PaneNode): PaneNode => {
    if (converted) return n;
    if (n.kind === "leaf") {
      if (n.id === excludeId) return n;
      converted = true;
      return { ...n, view: "editor" };
    }
    return { ...n, a: convertFirst(n.a), b: convertFirst(n.b) };
  };
  const result = convertFirst(node);
  // 1枚構成で excludeId しかない場合はそのペイン自体を編集に戻す
  if (!converted && result.kind === "leaf") return { ...result, view: "editor" };
  return result;
}

export type PaneOp =
  | { type: "split"; id: string; dir: "row" | "col" }
  | { type: "close"; id: string }
  | { type: "ratio"; id: string; delta: number }
  | { type: "toggleView"; id: string }
  | { type: "reset" };

/* ---------------------------------- Undo / Redo ---------------------------------- */
// 履歴はUI反応不要のためストア外のモジュール変数で持つ(project の参照変化だけ監視)。
// 連続操作(床ドラッグ・尺リサイズ等)は400ms窓で1つの履歴に吸収する

let undoPast: SceneProject[] = [];
let undoFuture: SceneProject[] = [];
let lastChangeAt = 0;
let applyingHistory = false;

useScene3d.subscribe((state, prevState) => {
  if (applyingHistory) return;
  if (state.project === prevState.project) return;
  const now = Date.now();
  if (now - lastChangeAt >= 400) {
    undoPast.push(prevState.project);
    if (undoPast.length > 100) undoPast.shift();
    undoFuture = [];
  }
  lastChangeAt = now;
});

export function undoScene3d(): void {
  const prev = undoPast.pop();
  if (!prev) return;
  applyingHistory = true;
  const current = useScene3d.getState().project;
  undoFuture.push(current);
  restoreProject(prev);
  applyingHistory = false;
}

export function redoScene3d(): void {
  const next = undoFuture.pop();
  if (!next) return;
  applyingHistory = true;
  undoPast.push(useScene3d.getState().project);
  restoreProject(next);
  applyingHistory = false;
}

/** 履歴復元時に、選択・再生ヘッドが消えたID/範囲を指さないよう整合させる */
function restoreProject(project: SceneProject): void {
  const st = useScene3d.getState();
  const selectedShotId = project.shots.some((s) => s.id === st.selectedShotId)
    ? st.selectedShotId
    : project.shots[0].id;
  const selectedEntityId =
    st.selectedEntityId && project.entities.some((e) => e.id === st.selectedEntityId)
      ? st.selectedEntityId
      : null;
  useScene3d.setState({
    project,
    selectedShotId,
    selectedEntityId,
    playing: false,
    currentFrame: Math.min(st.currentFrame, totalDurationFrames(project) - 1),
  });
}
