/**
 * scene3d エディタ状態ストア
 *
 * SceneProject(正本データ)と編集UI状態(選択・再生・ドラッグ)を分離して保持する。
 * カメラ姿勢の計算はここでは行わない(evaluateScene.ts が唯一の真実)。
 *
 * ショット構造: project.shots がカット割。selectedShotId のショットに対して
 * カメラ操作(プリセット/レンズ/尺)が効く。CapCut風タイムラインの正本
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import {
  createDefaultCameraMove,
  createDefaultProject,
  createDefaultShot,
  SCENE_FPS,
} from "../scene3d/types";
import type {
  CameraPresetId,
  SceneAspectRatio,
  SceneEntity,
  SceneEntityKind,
  SceneProject,
  SceneShot,
  Vec3,
} from "../scene3d/types";
import type { SceneLayoutDraft } from "../scene3d/layoutAnalysis";
import {
  getShotMove,
  locateShot,
  resolveLookAt,
  totalDurationFrames,
} from "../scene3d/evaluateScene";
import { resolveClipSpeed } from "../scene3d/clipSpeed";
import type { EntityMotionType } from "../scene3d/types";

let entitySeq = 1;
let shotSeq = 1;

/** モーション種類を切り替えても行き先を引き継ぐための現経路(clip/walk/run共通) */
function existingMotionPath(e: SceneEntity): Vec3[] {
  if (!e.motion || e.motion.type === "fall") return [];
  return e.motion.type === "clip" ? (e.motion.path ?? []) : e.motion.path;
}

/** 経路が無いときの既定: 向いている方向へ2.5m */
function defaultMotionPath(e: SceneEntity): Vec3[] {
  return [
    [
      e.position[0] + Math.sin(e.rotationY) * 2.5,
      e.position[1],
      e.position[2] + Math.cos(e.rotationY) * 2.5,
    ],
  ];
}

const ENTITY_LABELS: Record<SceneEntityKind, string> = {
  mannequin: "人物",
  sphere: "球",
  box: "箱",
  wall: "壁",
  column: "柱",
  stairs: "階段",
  building: "ビル",
  table: "机",
  chair: "椅子",
  sofa: "ソファ",
  bed: "ベッド",
  shelf: "棚",
  pedestal: "台座",
  car: "車",
  tree: "木",
  streetlight: "街灯",
};

/**
 * プリセット選択時のカメラ初期配置。注視対象の位置を基準に
 * 「それらしい開始/終了位置」を決める(ユーザーはドラッグで直せる)
 */
function presetPlacement(
  preset: CameraPresetId,
  target: Vec3,
): { startPos: Vec3; endPos: Vec3; orbitDegrees: number; midPos?: Vec3 } {
  const [tx, , tz] = target;
  const eye = 1.4; // 目線の高さ
  switch (preset) {
    case "spiralIn":
      return { startPos: [tx, 2.4, tz + 5], endPos: [tx, 2.4, tz + 5], orbitDegrees: 150 };
    case "dollyZoom":
      return { startPos: [tx, eye, tz + 6], endPos: [tx, eye, tz + 2.2], orbitDegrees: 0 };
    case "flyover":
      // 前方から頭上を飛び越えて背後へ(中間点を真上に置いた曲線)
      return {
        startPos: [tx, 1.2, tz + 6],
        endPos: [tx, 1.6, tz - 6],
        orbitDegrees: 0,
        midPos: [tx, 4.5, tz],
      };
    case "riseReveal":
      return { startPos: [tx, 0.3, tz + 2.2], endPos: [tx, 3.4, tz + 6], orbitDegrees: 0 };
    case "follow":
      return { startPos: [tx - 1.8, eye, tz + 2.6], endPos: [tx - 1.8, eye, tz + 2.6], orbitDegrees: 0 };
    case "whipPan":
      return { startPos: [tx - 2.5, eye, tz + 3.5], endPos: [tx + 2.5, eye, tz + 3.5], orbitDegrees: 0 };
    case "shake":
      return { startPos: [tx, eye, tz + 3.2], endPos: [tx, eye, tz + 3.2], orbitDegrees: 0 };
    case "snapZoom":
      return { startPos: [tx, eye, tz + 4.5], endPos: [tx, eye, tz + 4.5], orbitDegrees: 0 };
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

/**
 * 絵コンテ由来のカット1件 (CHAIN-01)。3D の shot へ写す入力。
 *
 * なぜ「絵コンテ→3D」の橋が必要か (2026-07-25):
 * 3D は localStorage "scene3d.project.v3" に閉じた独立アプリ状態で、絵コンテで
 * 決めた尺・カメラ意図・採用画像が一切渡らず、ユーザーが全部手入力し直していた。
 * 尺と枚数(カット数)が入るだけで手入力量が激減するため、カメラプリセットは
 * 初期値のままにして「尺 + カット数 + 意図の記録」だけを移送する。
 */
export type StoryboardCutImport = {
  cutId: string;
  /** カットの尺(秒)。3D は frame 管理なので SCENE_FPS で換算する */
  durationSeconds: number;
  /** 採用テイクの画像パス (未採用なら undefined)。 */
  imagePath?: string;
  /** カットの説明 (絵コンテの intent など)。 */
  description?: string;
  /** カメラ意図のメモ (絵コンテの cameraNote)。カメラ設定には反映せず記録だけ。 */
  cameraNote?: string;
};

/**
 * 3D の shot が「どの絵コンテカット由来か」の記録。
 *
 * SceneProject(= localStorage 保存スキーマ v3)には足さない。理由は 2つ:
 * (1) 保存スキーマを変えると既存ユーザーのプロジェクトが移行対象になる
 * (2) renumberShots() が label を「カットN」で毎回上書きするため label には保持できない
 * よって shotId をキーにしたストア内の別マップとして持つ(セッション内の参照用)。
 */
export type StoryboardShotOrigin = {
  cutId: string;
  imagePath?: string;
  description?: string;
  cameraNote?: string;
};

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
  /** エンティティを複製(モーション・寸法ごと)。複製をそのまま選択する */
  duplicateEntity: (id: string) => void;
  /** レイヤー一覧の並び替え: id を overId の位置へ挿入 */
  reorderEntity: (id: string, overId: string) => void;
  selectEntity: (id: string | null) => void;
  clearSelection: () => void;
  moveEntity: (id: string, position: Vec3) => void;
  rotateEntity: (id: string, rotationY: number) => void;
  /** 3軸回転(BlenderのR相当)。axis指定で1軸ずつ設定(ラジアン) */
  setEntityRotation: (id: string, axis: "x" | "y" | "z", radians: number) => void;
  /** R+ドラッグのグリグリ回転(差分加算。横=向きY / 縦=傾きX) */
  rotateEntityFree: (id: string, dYaw: number, dPitch: number) => void;
  scaleEntity: (id: string, scale: number) => void;
  /** S+ドラッグの拡縮(差分加算) */
  scaleEntityBy: (id: string, delta: number) => void;
  setEntityFloors: (id: string, floors: number) => void;
  setEntityParam: (id: string, key: "width" | "height" | "depth" | "floors", value: number) => void;
  /** インポート済みモーション一覧(実体は motionLibrary モジュールが持つ) */
  importedMotions: { id: string; name: string }[];
  registerImportedMotions: (items: { id: string; name: string }[]) => void;
  /** モーションを一覧から外し、使用中の人物のモーションも解除する(AI生成の削除用) */
  removeImportedMotion: (id: string) => void;
  /** 人物のモーション設定(walk/run)。null=立ち止まる。開始時は前方2.5mが行き先 */
  setEntityMotion: (id: string, type: EntityMotionType | null) => void;
  /** インポートしたクリップを人物に割当(その場再生) */
  setEntityMotionClip: (id: string, clipId: string) => void;
  /** 到着後アクションを設定。null=待機(既定)に戻す */
  setEntityArrivalClip: (id: string, clipId: string | null) => void;
  /** モーション連結: 到着後アクションの列に1つ追加(つなぎ目はクロスフェード) */
  appendEntityArrivalStep: (id: string, clipId: string) => void;
  /** モーション連結: 到着後アクションの列からindex番目を外す */
  removeEntityArrivalStep: (id: string, index: number) => void;
  /** 視線ノード: 頭が追う相手を設定("__camera"=カメラ / entityId / null=なし) */
  setEntityLookAt: (id: string, target: string | null) => void;
  /** 並列レイヤー: 上半身に重ねるクリップを設定(null=なし) */
  setEntityOverlayClip: (id: string, clipId: string | null) => void;
  /** モーションの行き先(最終経由点)を動かす */
  moveMotionTarget: (id: string, position: Vec3) => void;
  /** 体の軌跡: 通過点をつかんだ位置に追加し、新しい通過点のindexを返す */
  insertMotionPathPoint: (id: string, position: Vec3) => number;
  /** 体の軌跡: index番目の通過点を動かす */
  moveMotionPathPoint: (id: string, index: number, position: Vec3) => void;
  /** 体の軌跡: index番目の通過点を消す(最後の1点=行き先は消せない) */
  removeMotionPathPoint: (id: string, index: number) => void;
  setDragging: (id: string | null) => void;

  /**
   * shotId → 絵コンテ由来カットの記録 (CHAIN-01)。
   * 絵コンテから読み込んだ shot だけがここに載る。手で足した shot は載らない。
   */
  storyboardOrigins: Record<string, StoryboardShotOrigin>;
  /**
   * 絵コンテの確定カットを shots へ写す (CHAIN-01)。
   * mode="append" は既存カットを残して末尾へ追加、mode="replace" は shots を作り直す。
   * カメラは 1 カット 1 台を新規作成し、プリセットは初期値のまま(尺と枚数だけ移送)。
   * 返り値: 実際に取り込んだカット数。
   */
  importStoryboardCuts: (cuts: StoryboardCutImport[], mode: "append" | "replace") => number;
  /**
   * 画像の移動 / relink (旧→新パス) を storyboardOrigins[].imagePath へ追従させる (S3)。
   *
   * ここが無いと「プロジェクトへ移動」した瞬間に 3D の由来記録が旧パスのままになり、
   * 由来サムネが割れる。ヒットが 1 件も無ければ state を変えない。
   */
  relinkStoryboardOrigins: (pathMap: Record<string, string>) => void;

  /**
   * 画像→3Dシーン再構成 (Slice D) の着地点。解析済みレイアウト草案を実シーンへ写像する。
   * 追加するのは entities(人物+小物) と cameras/shots のみ。schemaVersion は 3 のまま。
   */
  applyImageScene: (
    draft: SceneLayoutDraft,
    poseClipId: string | null,
    /** 入力画像のアスペクト (幅/高さ)。渡すとカメラ枠の比率へ反映する (r3 追補)。 */
    sourceAspect?: number | null,
  ) => ImageSceneApplyResult;

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
  setCameraLookAtPos: (position: Vec3) => void;
  setLens: (lensMm: number) => void;
  setOrbitDegrees: (degrees: number) => void;
  moveCameraEndpoint: (which: "start" | "end", position: Vec3) => void;
  /** 軌道の中間点を動かして通り道を曲げる(nullで直線に戻す) */
  moveCameraMid: (position: Vec3 | null) => void;
  /** 真珠の道: 通過点をつかんだ位置に追加し、新しい真珠のindexを返す(挿入区間は自動判定) */
  insertCameraPathPoint: (position: Vec3) => number;
  /**
   * 軌道系プリセット(オービット等)を、今の軌道の形を保ったまま「自由な道」へ変換する。
   * 道をつかんだ瞬間に呼ばれる(見た目が変わらないので操作が驚きにならない)
   */
  convertCameraToFreePath: (startPos: Vec3, endPos: Vec3, mids: Vec3[]) => void;
  /** カメラワークをリセット: 真珠・曲げを消し、変換前のプリセットに戻す */
  resetCameraWork: () => void;
  /** 道を手で描くモード(ビューポートの一筆書きでカメラ軌跡を作る) */
  pathDrawMode: boolean;
  setPathDrawMode: (on: boolean) => void;
  /** 真珠の道: index番目の通過点を動かす */
  moveCameraPathPoint: (index: number, position: Vec3) => void;
  /** 真珠の道: index番目の通過点を消す(全部消えたら直線に戻る) */
  removeCameraPathPoint: (index: number) => void;

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

/**
 * 旧保存データの移行: speed/path を持たない clip モーション(移動系クリップ対応前の保存)は
 * 旗(行き先)が出ないため、読込時に速度を焼き込む。標準ライブラリは clipId から解決できる
 */
function migrateProject(project: SceneProject): SceneProject {
  return {
    ...project,
    entities: project.entities.map((e) => {
      if (e.motion?.type !== "clip" || e.motion.speed !== undefined) return e;
      const speed = resolveClipSpeed(e.motion.clipId);
      if (speed <= 0) return e;
      const path = e.motion.path?.length ? e.motion.path : defaultMotionPath(e);
      return { ...e, motion: { ...e.motion, speed, path } };
    }),
  };
}

/**
 * 画像→3Dシーン再構成 (Slice D) の反映結果。
 * UI が「置換したのか追記したのか」「何体置いたのか」を正直に告知するために返す。
 */
export type ImageSceneApplyResult = {
  mode: "replace" | "append";
  /** 追加した人物マネキンの ID。person が無ければ null */
  personEntityId: string | null;
  /** 追加した小物の数 */
  objectCount: number;
  /** 追加したカメラ ID (追加カットのカメラ) */
  cameraId: string;
};

/**
 * 「初期未編集シーン」判定 (設計書 §1 論点4-4)。
 *
 * 既定プロジェクトと**深く等価**なときだけ置換してよい。1つでもユーザーの手が
 * 入っていたら追記に倒す (既存エンティティを消さない)。
 *
 * 実装は `createDefaultProject()` との構造比較。個別フィールドを列挙する方式だと
 * 「回転・拡大縮小・カメラ編集・ショット編集・画面比率」のように**見落とした項目が
 * 静かに初期状態と誤認され、ユーザーの編集を消す** (Sol 評価 blocking B-3)。
 * 既定生成関数を正本にすれば、types.ts に項目が増えても自動で追随する。
 *
 * `createDefaultProject()` は時刻・乱数を含まない決定論な生成関数なので、
 * 生成しなおして JSON 比較するのが最も確実。
 */
function isPristineScene(project: SceneProject): boolean {
  const pristine = createDefaultProject();
  // 生成のたびに値が変わる項目は無いので、キー順を揃えた安定シリアライズで足りる。
  return stableStringify(project) === stableStringify(pristine);
}

/**
 * キー順に依存しない安定シリアライズ。
 * localStorage 復元・spread によるキー順の入れ替えで比較が壊れないようにする。
 * undefined のプロパティは「無い」と同一視する (既定生成と復元でズレる項目のため)。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** 度 → ラジアン。解析 JSON は度、SceneEntity.rotationY はラジアン */
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * 入力画像のアスペクト (幅/高さ) を、scene3d が持つ3つの比率のうち最も近いものへ丸める
 * (r3 追補: 入力画像のアスペクトをカメラ枠へ反映。4:5 等の変換表は作らない = 最小)。
 * 判定できない値なら null を返し、呼び出し元は既存の比率を維持する。
 */
function snapSourceAspect(aspect: number | null | undefined): SceneAspectRatio | null {
  if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect <= 0) return null;
  const candidates: [SceneAspectRatio, number][] = [
    ["16:9", 16 / 9],
    ["1:1", 1],
    ["9:16", 9 / 16],
  ];
  let best = candidates[0];
  // 比率の差は対数で測る (縦横で対称にするため。線形だと横長側の差が過大評価される)。
  let bestDelta = Math.abs(Math.log(aspect / best[1]));
  for (const c of candidates) {
    const delta = Math.abs(Math.log(aspect / c[1]));
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best[0];
}

/**
 * カメラの極座標 (方位角・距離・高さ) → ワールド座標。
 *
 * 解析プロンプトの規約: 真正面 (被写体の正面から見る) = azimuth 0 で、そこは +Z 側。
 * 右回り込みが正。scene3d の座標系は X=右 / Z=カメラ側なので、
 * azimuth 0 → [0, h, +d]、azimuth +90 → [+d, h, 0] になる向きで写像する。
 */
function cameraPosFromPolar(azimuthDeg: number, distanceM: number, heightM: number): Vec3 {
  const a = degToRad(azimuthDeg);
  return [Math.sin(a) * distanceM, heightM, Math.cos(a) * distanceM];
}

const initialProject = ((): SceneProject => {
  try {
    const raw = localStorage.getItem("scene3d.project.v3");
    if (raw) {
      const parsed = JSON.parse(raw) as SceneProject;
      if (parsed.schemaVersion === 3 && parsed.shots?.length && parsed.cameras?.length) {
        return migrateProject(parsed);
      }
    }
  } catch {
    /* 壊れた保存データは無視して初期シーン */
  }
  return createDefaultProject();
})();

export const useScene3d = create<Scene3dState>((set, get) => ({
  project: initialProject,
  // 起動時は何も選択しない(自由視点から始める。選択はユーザーのクリックで)
  selectedEntityId: null,
  selectedShotId: initialProject.shots[0].id,
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
  // 絵コンテ由来カットの記録 (CHAIN-01)。localStorage には保存しない
  // (保存スキーマ v3 を変えないため。読み込みはユーザー操作でやり直せる)
  storyboardOrigins: {},

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

  duplicateEntity: (id) => {
    const { project } = get();
    const src = project.entities.find((e) => e.id === id);
    if (!src) return;
    const newId = `${src.kind}-${Date.now()}-${entitySeq++}`;
    const copy: SceneEntity = {
      ...src,
      id: newId,
      label: `${src.label}のコピー`,
      // 元と重ならないよう斜めに0.6mずらす(高さは維持)
      position: [src.position[0] + 0.6, src.position[1], src.position[2] + 0.6],
      motion: src.motion ? (JSON.parse(JSON.stringify(src.motion)) as SceneEntity["motion"]) : src.motion,
      params: src.params ? { ...src.params } : undefined,
    };
    const idx = project.entities.findIndex((e) => e.id === id);
    const entities = [...project.entities];
    entities.splice(idx + 1, 0, copy);
    set({ project: { ...project, entities }, selectedEntityId: newId });
  },

  reorderEntity: (id, overId) => {
    const { project } = get();
    const from = project.entities.findIndex((e) => e.id === id);
    const to = project.entities.findIndex((e) => e.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const entities = [...project.entities];
    const [moved] = entities.splice(from, 1);
    entities.splice(to, 0, moved);
    set({ project: { ...project, entities } });
  },

  selectEntity: (id) => set({ selectedEntityId: id, cameraSelected: false }),
  /** 何もない場所のクリック/Esc: 物体もカメラも選択解除(自由視点の状態) */
  clearSelection: () => set({ selectedEntityId: null, cameraSelected: false }),

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

  setEntityRotation: (id, axis, radians) => {
    const { project } = get();
    const key = axis === "x" ? "rotationX" : axis === "y" ? "rotationY" : "rotationZ";
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, [key]: radians } : e,
        ),
      },
    });
  },

  rotateEntityFree: (id, dYaw, dPitch) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id
            ? { ...e, rotationY: e.rotationY + dYaw, rotationX: (e.rotationX ?? 0) + dPitch }
            : e,
        ),
      },
    });
  },

  scaleEntityBy: (id, delta) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id
            ? { ...e, scale: Math.max(0.3, Math.min(4, e.scale + delta)) }
            : e,
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
    // floors(ビル階数)は整数1〜20、寸法系は0.1〜30m
    const clamped =
      key === "floors"
        ? Math.max(1, Math.min(20, Math.round(value)))
        : Math.max(0.1, Math.min(30, value));
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, params: { ...e.params, [key]: clamped } } : e,
        ),
      },
    });
  },

  importedMotions: [],
  registerImportedMotions: (items) => {
    const { importedMotions } = get();
    const known = new Set(importedMotions.map((m) => m.id));
    set({ importedMotions: [...importedMotions, ...items.filter((m) => !known.has(m.id))] });
  },

  removeImportedMotion: (id) => {
    const { project, importedMotions } = get();
    set({
      importedMotions: importedMotions.filter((m) => m.id !== id),
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.motion?.type !== "clip") return e;
          if (e.motion.clipId === id) return { ...e, motion: null };
          if (
            e.motion.arrivalClipId === id ||
            e.motion.arrivalSequence?.some((s) => s.clipId === id)
          ) {
            const seq = e.motion.arrivalSequence?.filter((s) => s.clipId !== id);
            return {
              ...e,
              motion: {
                ...e.motion,
                arrivalClipId: e.motion.arrivalClipId === id ? undefined : e.motion.arrivalClipId,
                arrivalSequence: seq && seq.length > 0 ? seq : undefined,
              },
            };
          }
          return e;
        }),
      },
    });
  },

  setEntityMotionClip: (id, clipId) => {
    const { project, importedMotions } = get();
    const clipName = importedMotions.find((m) => m.id === clipId)?.name;
    const speed = resolveClipSpeed(clipId, clipName);
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id) return e;
          // その場再生クリップ(ダンス・座る等)は経路を持たない
          if (speed <= 0) return { ...e, motion: { type: "clip", clipId } };
          // 移動系クリップ(歩く/走る等): 既存の経路を維持。無ければ既定経路
          const prev = existingMotionPath(e);
          const path = prev.length > 0 ? prev : defaultMotionPath(e);
          return { ...e, motion: { type: "clip", clipId, speed, path } };
        }),
      },
    });
  },

  setEntityArrivalClip: (id, clipId) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id || e.motion?.type !== "clip") return e;
          // 単発指定は連結列を置き換える(触り慣れた既存挙動を維持)
          return {
            ...e,
            motion: { ...e.motion, arrivalClipId: clipId ?? undefined, arrivalSequence: undefined },
          };
        }),
      },
    });
  },

  appendEntityArrivalStep: (id, clipId) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id || e.motion?.type !== "clip") return e;
          const base =
            e.motion.arrivalSequence ??
            (e.motion.arrivalClipId ? [{ clipId: e.motion.arrivalClipId }] : []);
          return {
            ...e,
            motion: {
              ...e.motion,
              arrivalSequence: [...base, { clipId }],
              arrivalClipId: undefined,
            },
          };
        }),
      },
    });
  },

  removeEntityArrivalStep: (id, index) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id || e.motion?.type !== "clip") return e;
          const seq = [...(e.motion.arrivalSequence ?? [])];
          if (index < 0 || index >= seq.length) return e;
          seq.splice(index, 1);
          return {
            ...e,
            motion: { ...e.motion, arrivalSequence: seq.length > 0 ? seq : undefined },
          };
        }),
      },
    });
  },

  setEntityMotion: (id, type) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id) return e;
          if (type == null) return { ...e, motion: null };
          if (type === "fall") return { ...e, motion: { type: "fall" } };
          // 既存の経路は維持しつつ種類だけ変更。無ければ向いている方向へ2.5m
          const prev = existingMotionPath(e);
          const path = prev.length > 0 ? prev : defaultMotionPath(e);
          return { ...e, motion: { type, path } };
        }),
      },
    });
  },

  moveMotionTarget: (id, position) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) => {
          if (e.id !== id || !e.motion) return e;
          // 倒れる・その場再生クリップは行き先を持たない
          if (e.motion.type === "fall") return e;
          if (e.motion.type === "clip" && (e.motion.speed ?? 0) <= 0) return e;
          const cur = e.motion.type === "clip" ? (e.motion.path ?? []) : e.motion.path;
          if (cur.length === 0) return e;
          const path = [...cur];
          path[path.length - 1] = position;
          return { ...e, motion: { ...e.motion, path } };
        }),
      },
    });
  },

  insertMotionPathPoint: (id, position) => {
    const { project } = get();
    const e = project.entities.find((en) => en.id === id);
    const cur = e ? existingMotionPath(e) : [];
    if (!e || cur.length === 0) return 0;
    // 挿入位置: [現在地, ...経由点] の折れ線のうち、一番近い区間に入れる
    const chain: Vec3[] = [e.position, ...cur];
    let bestSeg = 0;
    let bestD = Infinity;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const abx = b[0] - a[0];
      const abz = b[2] - a[2];
      const len2 = abx * abx + abz * abz;
      const t =
        len2 === 0
          ? 0
          : Math.max(0, Math.min(1, ((position[0] - a[0]) * abx + (position[2] - a[2]) * abz) / len2));
      const d = Math.hypot(position[0] - (a[0] + abx * t), position[2] - (a[2] + abz * t));
      if (d < bestD) {
        bestD = d;
        bestSeg = i;
      }
    }
    const next = [...cur];
    next.splice(bestSeg, 0, position);
    set({
      project: {
        ...project,
        entities: project.entities.map((en) =>
          en.id === id && en.motion && en.motion.type !== "fall"
            ? { ...en, motion: { ...en.motion, path: next } }
            : en,
        ),
      },
    });
    return bestSeg;
  },

  moveMotionPathPoint: (id, index, position) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((en) => {
          if (en.id !== id || !en.motion || en.motion.type === "fall") return en;
          const cur = existingMotionPath(en);
          if (index < 0 || index >= cur.length) return en;
          const path = [...cur];
          path[index] = position;
          return { ...en, motion: { ...en.motion, path } };
        }),
      },
    });
  },

  removeMotionPathPoint: (id, index) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((en) => {
          if (en.id !== id || !en.motion || en.motion.type === "fall") return en;
          const cur = existingMotionPath(en);
          // 最後の1点(行き先)は消せない(旗が消えて操作不能になるため)
          if (cur.length <= 1 || index < 0 || index >= cur.length) return en;
          const path = [...cur];
          path.splice(index, 1);
          return { ...en, motion: { ...en.motion, path } };
        }),
      },
    });
  },

  setEntityOverlayClip: (id, clipId) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id && e.motion?.type === "clip"
            ? { ...e, motion: { ...e.motion, overlayClipId: clipId ?? undefined } }
            : e,
        ),
      },
    });
  },

  setEntityLookAt: (id, target) => {
    const { project } = get();
    set({
      project: {
        ...project,
        entities: project.entities.map((e) =>
          e.id === id ? { ...e, lookAt: target ?? undefined } : e,
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

  importStoryboardCuts: (cuts, mode) => {
    const usable = cuts.filter((c) => c.cutId);
    if (usable.length === 0) return 0;

    const { project, storyboardOrigins } = get();
    const stamp = Date.now();

    // 1カット = 1カメラ。プリセットは初期値のまま(尺と枚数の移送が目的で、
    // カメラワークは 3D 側でドラッグして決める前提)。
    const newCameras = usable.map((_, i) => ({
      id: `camera-sb-${stamp}-${shotSeq + i}`,
      label: `カメラ${(mode === "replace" ? 0 : project.cameras.length) + i + 1}`,
      move: createDefaultCameraMove(),
    }));
    const newShots: SceneShot[] = usable.map((c, i) => {
      const shot = createDefaultShot(`shot-sb-${stamp}-${shotSeq + i}`, "", newCameras[i].id);
      // 尺は秒 → フレーム換算。0以下・NaN は既定尺(createDefaultShot)のまま残す
      const frames = Math.round((c.durationSeconds ?? 0) * SCENE_FPS);
      return frames > 0 ? { ...shot, durationFrames: frames } : shot;
    });
    shotSeq += usable.length;

    const nextShots =
      mode === "replace" ? renumberShots(newShots) : renumberShots([...project.shots, ...newShots]);
    const nextCameras =
      mode === "replace"
        ? newCameras
        : [...project.cameras, ...newCameras];

    // replace では既存 shot の記録も一緒に捨てる(残すと孤児レコードになる)
    const nextOrigins: Record<string, StoryboardShotOrigin> =
      mode === "replace" ? {} : { ...storyboardOrigins };
    usable.forEach((c, i) => {
      nextOrigins[newShots[i].id] = {
        cutId: c.cutId,
        imagePath: c.imagePath,
        description: c.description,
        cameraNote: c.cameraNote,
      };
    });

    const next: SceneProject = { ...project, shots: nextShots, cameras: nextCameras };
    const firstId = nextShots.find((s) => s.id === newShots[0].id)?.id ?? nextShots[0].id;
    set({
      project: next,
      storyboardOrigins: nextOrigins,
      selectedShotId: firstId,
      currentFrame: shotStartFrame(next, firstId),
      playing: false,
    });
    return usable.length;
  },

  relinkStoryboardOrigins: (pathMap) => {
    const map = new Map(
      Object.entries(pathMap).filter(
        ([oldPath, newPath]) => oldPath && newPath && oldPath !== newPath,
      ),
    );
    if (map.size === 0) return;
    const origins = get().storyboardOrigins;
    let hit = false;
    const next: Record<string, StoryboardShotOrigin> = {};
    for (const [shotId, origin] of Object.entries(origins)) {
      const newPath = origin.imagePath ? map.get(origin.imagePath) : undefined;
      if (newPath) {
        hit = true;
        next[shotId] = { ...origin, imagePath: newPath };
      } else {
        next[shotId] = origin;
      }
    }
    if (!hit) return;
    set({ storyboardOrigins: next });
  },

  applyImageScene: (draft, poseClipId, sourceAspect) => {
    const { project } = get();
    const stamp = Date.now();

    // 初期未編集シーンなら丸ごと置換、それ以外は追記 (既存シーンを壊さない)。
    const mode: "replace" | "append" = isPristineScene(project) ? "replace" : "append";
    const baseEntities = mode === "replace" ? [] : project.entities;

    const added: SceneEntity[] = [];

    // 人物: 既存の mannequin + clip モーションで表現する (types.ts は変更しない)。
    // poseClipId が null になることは無い (呼び出し側が T字 clip を必ず登録する) が、
    // null で来ても素立ちのマネキンとして着地させる (位置は反映される)。
    let personEntityId: string | null = null;
    if (draft.person) {
      personEntityId = `mannequin-${stamp}-${entitySeq++}`;
      added.push({
        id: personEntityId,
        kind: "mannequin",
        label: `人物${baseEntities.filter((e) => e.kind === "mannequin").length + 1}`,
        position: [draft.person.floorX, 0, draft.person.floorZ],
        rotationY: degToRad(draft.person.rotationYDeg),
        scale: 1,
        // 静的ポーズ: speed/path を持たせない = その場再生 (types.ts:35-38)
        motion: poseClipId ? { type: "clip", clipId: poseClipId } : null,
      });
    }

    // 小物: 解析 JSON の寸法を params(width/height/depth) と scale の両方で反映する。
    // box/wall は params が直接ジオメトリに効き (scale=1)、それ以外の固定ジオメトリな
    // kind は uniform scale が寸法を運ぶ (r3 追補4。倍率算出は layoutAnalysis 側)。
    // 全要素は床接地 (y=0) 前提 (設計書 §1 論点5)。高さ関係は既存の磁石が引き受ける。
    for (const obj of draft.objects) {
      const kindCount =
        baseEntities.filter((e) => e.kind === obj.kind).length +
        added.filter((e) => e.kind === obj.kind).length +
        1;
      added.push({
        id: `${obj.kind}-${stamp}-${entitySeq++}`,
        kind: obj.kind,
        label: obj.label || `${ENTITY_LABELS[obj.kind]}${kindCount}`,
        position: [obj.floorX, 0, obj.floorZ],
        rotationY: degToRad(obj.rotationYDeg),
        scale: obj.scale,
        params: { width: obj.width, height: obj.height, depth: obj.depth },
      });
    }

    const entities = [...baseEntities, ...added];

    // カメラ: 解析した画角で fixed カメラを1台足し、それを使う新カットを末尾に追加する。
    // 追わせる相手が居なければ人物の立ち位置 (居なければ原点の目線高さ) を見る。
    const camPos = cameraPosFromPolar(
      draft.camera.azimuthDeg,
      draft.camera.distanceM,
      draft.camera.heightM,
    );
    const cameraId = `camera-img-${stamp}-${shotSeq++}`;
    const camera = {
      id: cameraId,
      label: `カメラ${(mode === "replace" ? 0 : project.cameras.length) + 1}`,
      move: {
        ...createDefaultCameraMove(),
        preset: "fixed" as CameraPresetId,
        targetEntityId: personEntityId,
        lookAtPos: personEntityId
          ? undefined
          : ([draft.person?.floorX ?? 0, 1, draft.person?.floorZ ?? 0] as Vec3),
        startPos: camPos,
        endPos: camPos,
        lensMm: draft.camera.lensMm,
        midPos: null,
      },
    };
    const shotId = `shot-img-${stamp}-${shotSeq++}`;
    const shot = createDefaultShot(shotId, "", cameraId);

    const cameras = mode === "replace" ? [camera] : [...project.cameras, camera];
    const shots =
      mode === "replace" ? renumberShots([shot]) : renumberShots([...project.shots, shot]);

    // カメラ枠の比率を入力画像に合わせる (r3 追補)。判定できなければ既存値を維持する。
    const snapped = snapSourceAspect(sourceAspect);
    const next: SceneProject = {
      ...project,
      entities,
      cameras,
      shots,
      aspectRatio: snapped ?? project.aspectRatio,
    };
    set({
      project: next,
      selectedShotId: shotId,
      currentFrame: shotStartFrame(next, shotId),
      selectedEntityId: personEntityId,
      cameraSelected: personEntityId === null,
      playing: false,
      // 追加したカメラのビューを開く (元画像と見比べて直す動線。設計書 §1 論点5)
      cameraView: true,
    });

    return {
      mode,
      personEntityId,
      objectCount: draft.objects.length,
      cameraId,
    };
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
    // 消した shot の絵コンテ記録も落とす(残すと孤児レコードになる。CHAIN-01)
    const { [id]: _removed, ...restOrigins } = get().storyboardOrigins;
    set({
      project: next,
      storyboardOrigins: restOrigins,
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
      // プリセットが中間点を持つ(飛び越え等)ならそれを採用、無ければ直線に戻す
      midPos: placement.midPos ?? null,
      // 動きを選び直したら真珠の道は消す(前の道が新プリセットを乗っ取らないように)
      pathPoints: undefined,
      pathConvertedFrom: undefined,
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
    const { project } = get();
    const shot = getSelectedShot(get());
    // 「追わない」へ切替時: 今見ている点を固定注視点として引き継ぐ(向きが跳ねない)
    const currentLookAt = resolveLookAt(project, shot);
    set({
      project: updateSelectedCameraMove(get(), (m) => ({
        ...m,
        targetEntityId: entityId,
        lookAtPos: entityId == null ? currentLookAt : m.lookAtPos,
      })),
    });
  },

  setCameraLookAtPos: (position: Vec3) => {
    set({ project: updateSelectedCameraMove(get(), (m) => ({ ...m, lookAtPos: position })) });
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

  // ---- 真珠の道(カメラ軌道の通過点) ----
  insertCameraPathPoint: (position) => {
    // 挿入位置: [start, ...真珠, end] の折れ線のうち、一番近い区間に入れる。
    // 返り値は新しい真珠のindex(つかんだ瞬間からドラッグを始めるために使う)
    const shot = getSelectedShot(get());
    const cam = get().project.cameras.find((c) => c.id === shot.cameraId);
    const m = cam?.move;
    if (!m) return 0;
    const pts = m.pathPoints ?? [];
    const chain: Vec3[] = [m.startPos, ...pts, m.endPos];
    let bestSeg = 0;
    let bestD = Infinity;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ap: Vec3 = [position[0] - a[0], position[1] - a[1], position[2] - a[2]];
      const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2));
      const d = Math.hypot(
        position[0] - (a[0] + ab[0] * t),
        position[1] - (a[1] + ab[1] * t),
        position[2] - (a[2] + ab[2] * t),
      );
      if (d < bestD) {
        bestD = d;
        bestSeg = i;
      }
    }
    const next = [...pts];
    next.splice(bestSeg, 0, position);
    set({ project: updateSelectedCameraMove(get(), (mm) => ({ ...mm, pathPoints: next })) });
    return bestSeg;
  },

  convertCameraToFreePath: (startPos, endPos, mids) => {
    set({
      project: updateSelectedCameraMove(get(), (m) => ({
        ...m,
        preset: "path",
        pathConvertedFrom: m.preset === "path" ? m.pathConvertedFrom : m.preset,
        startPos,
        endPos,
        pathPoints: mids,
        midPos: null,
      })),
    });
  },

  pathDrawMode: false,
  setPathDrawMode: (on) => set({ pathDrawMode: on }),

  resetCameraWork: () => {
    // 選択中のカメラワーク(プリセット)のデフォルト配置に戻す。
    // 道つかみで「自由な道」に変換されていた場合は変換前のプリセットのデフォルトへ。
    // setCameraPreset が既定配置・真珠クリア・moveWindowリセットを一括で行う
    const shot = getSelectedShot(get());
    const cam = get().project.cameras.find((c) => c.id === shot.cameraId);
    if (!cam) return;
    const m = cam.move;
    const preset = m.preset === "path" ? (m.pathConvertedFrom ?? "path") : m.preset;
    get().setCameraPreset(preset);
  },

  moveCameraPathPoint: (index, position) => {
    set({
      project: updateSelectedCameraMove(get(), (m) => {
        const pts = [...(m.pathPoints ?? [])];
        if (index < 0 || index >= pts.length) return m;
        pts[index] = position;
        return { ...m, pathPoints: pts };
      }),
    });
  },

  removeCameraPathPoint: (index) => {
    set({
      project: updateSelectedCameraMove(get(), (m) => {
        const pts = [...(m.pathPoints ?? [])];
        if (index < 0 || index >= pts.length) return m;
        pts.splice(index, 1);
        return { ...m, pathPoints: pts.length > 0 ? pts : undefined };
      }),
    });
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
      // シーンを作り直すので絵コンテ由来の記録も破棄する (CHAIN-01)
      storyboardOrigins: {},
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

/* ---------------------------------- 自動保存 ---------------------------------- */
// シーンは **ファイル (scene3d.json) を正本**、localStorage を冗長バックアップとして
// 二重に保存する。
//
// なぜファイル正本にしたか (2026-07-30):
//   localStorage だけだと WebView のビルドID (app.codexframefactory / .dev / .capture)
//   ごとに別領域になり、ビルドを跨ぐと空に見える。presets が同じ理由でキャラクター
//   消失を起こしたため、同じ構造の時限爆弾である 3D シーンも同時に潰す。
//   安全機構は presets.ts (fileWriteUnlocked / 最後勝ちキュー / 空上書きガード /
//   世代バックアップ) をそのまま踏襲する。

const PROJECT_SAVE_KEY = "scene3d.project.v3";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * ファイルへ書いてよいと確定したか。
 * true になるのは「正常に読めた」か「ファイルが存在しないと確認できた」ときだけ。
 * **読み出しに失敗した場合は false のまま**で、ファイルへは一切書かない
 * (読めない正本を localStorage 由来の内容で上書きしない。presets.ts と同じ不変条件)。
 */
let sceneFileWriteUnlocked = false;
/** 解禁前に mutate があったか。解禁時に1回フラッシュして取りこぼしを防ぐ。 */
let scenePendingBeforeUnlock = false;
/** initialize の呼出番号。連続呼び出しで古い結果が store を上書きするのを防ぐ世代印。 */
let sceneInitializeToken = 0;

/** 保存の最後勝ちキュー (presets.ts の writeToFile と同型)。 */
let scenePendingWrite: { data: SceneProject; allowEmpty: boolean } | null = null;
let sceneWriteInFlight: Promise<void> | null = null;

async function writeSceneToFileNow(
  data: SceneProject,
  allowEmpty: boolean,
): Promise<void> {
  try {
    await invoke("scene3d_write", { content: JSON.stringify(data), allowEmpty });
  } catch (err) {
    console.error("[scene3d] ファイル書き込み失敗:", err);
    // 黙って失敗させない。「保存できていないのに保存されたと思う」型のデータ消失を防ぐ
    // (presets.ts / projects.ts と同じ防御。2026-07-30 評価者指摘で追加)。
    try {
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: `3Dシーンの保存に失敗しました。データ保護のため操作が反映されていない可能性があります: ${String(err)}`,
        ttlMs: 8000,
      });
    } catch {
      // トースト取得すら失敗した場合はログのみ (これ以上できることはない)。
    }
  }
}

function writeSceneToFile(data: SceneProject, allowEmpty = false): Promise<void> {
  scenePendingWrite = { data, allowEmpty };
  if (!sceneWriteInFlight) {
    sceneWriteInFlight = (async () => {
      while (scenePendingWrite) {
        const job = scenePendingWrite;
        scenePendingWrite = null;
        await writeSceneToFileNow(job.data, job.allowEmpty);
      }
      sceneWriteInFlight = null;
    })();
  }
  return sceneWriteInFlight;
}

/** ファイル + localStorage の二重保存。localStorage は常に書く (冗長バックアップ)。 */
/** localStorage への即時保存（冗長バックアップ側。ファイル書き込みとは独立に走る）。 */
function persistSceneToLocalStorage(project: SceneProject) {
  try {
    localStorage.setItem(PROJECT_SAVE_KEY, JSON.stringify(project));
  } catch {
    // 容量超過等は握りつぶす(シーンJSONは数KBのため実質起きない)
  }
}

function persistScene(project: SceneProject) {
  persistSceneToLocalStorage(project);
  if (!sceneFileWriteUnlocked) {
    // 解禁前の mutate。localStorage には既に書いたので取りこぼしはない。
    scenePendingBeforeUnlock = true;
    return;
  }
  void writeSceneToFile(project);
}

/**
 * ファイル保存のデバウンス。localStorage は従来どおり即時（体感の速さを落とさない）で、
 * **ファイルへの書き込みだけ**を間引く。
 *
 * 3D は編集のたびに state が変わる（カメラ操作・ドラッグ等）。ファイル書き込みは
 * 1回ごとに世代バックアップ (.bak-*) を作るため、短い間隔で書くと最大10世代が
 * 数秒で埋まり、「戻せる過去」が実質消える（2026-07-30 評価者指摘 H-2）。
 * 5秒に伸ばすと、直近10世代がおよそ1分弱をカバーする。
 * 途中でアプリが落ちても localStorage 側に最新が残るのでデータは失われない。
 */
const SCENE_FILE_SAVE_DEBOUNCE_MS = 5000;

useScene3d.subscribe((state, prevState) => {
  if (state.project === prevState.project) return;
  // localStorage へは即時に書く（アプリが突然落ちても直前の状態が残る）。
  persistSceneToLocalStorage(state.project);
  // ファイルは間引く（世代バックアップを浪費しないため）。
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // デバウンス中に更に変更が来た場合、クロージャが掴んだ state.project は古い。
    // ファイル書き込みでは古いスナップショットの後勝ちが致命的なので取り直す。
    persistScene(useScene3d.getState().project);
  }, SCENE_FILE_SAVE_DEBOUNCE_MS);
});

/**
 * 閉じる直前の保存（Codex検分 2026-07-30）。
 * ファイル保存は5秒デバウンスなので、その途中でウィンドウを閉じると最後の編集が
 * ファイル正本に載らない（localStorage には即時に入っているのでデータ自体は
 * 失われないが、正本が古いままになる）。閉じる直前に保留中のタイマーを畳んで
 * 1回書く。書き込みは非同期なので完了は保証できないが、開始はできる。
 */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (!saveTimer) return; // 保留中の変更なし
    clearTimeout(saveTimer);
    saveTimer = null;
    persistScene(useScene3d.getState().project);
  });
}

/**
 * 起動時の移行フロー (presets.ts の initialize / readPresetsFileIntoStore と同型)。
 * 守るべき不変条件:
 * **「読めなかった」経路では絶対にファイルへ書かない**。書いてよいのは
 * 「ファイルが存在しない」ときと「ファイルを正しく読めた後の変化」だけ。
 */
export async function initializeScene3d(): Promise<void> {
  const myToken = ++sceneInitializeToken;

  let content: string;
  try {
    content = await invoke<string>("scene3d_read");
  } catch (err) {
    // Tauri 外 (Vite 単体プレビュー等)。localStorage 由来の state のまま動く。
    console.error("[scene3d] ファイル読み出し失敗:", err);
    return; // 解禁しない (読めない正本を localStorage で潰さない)
  }

  if (content.trim().length > 0) {
    // ファイル有 = 正本。壊れていたら localStorage 由来の初期値を維持し、
    // ファイルへは何も書かない (壊れた正本を上書きしない。.bak-* も残っている)。
    let parsed: SceneProject;
    try {
      parsed = JSON.parse(content) as SceneProject;
    } catch (err) {
      console.error("[scene3d] scene3d.json のパースに失敗 (localStorage を継続使用):", err);
      return;
    }
    if (
      parsed?.schemaVersion !== 3 ||
      !parsed.shots?.length ||
      !parsed.cameras?.length
    ) {
      console.error("[scene3d] scene3d.json の形が不正 (localStorage を継続使用)");
      return;
    }
    if (myToken !== sceneInitializeToken) return; // 後続の initialize が正
    const project = migrateProject(parsed);
    useScene3d.setState({ project });
    // localStorage の冗長バックアップを最新化する。
    try {
      localStorage.setItem(PROJECT_SAVE_KEY, JSON.stringify(project));
    } catch {
      /* 容量超過等は握りつぶす */
    }
    sceneFileWriteUnlocked = true;
    if (scenePendingBeforeUnlock) {
      scenePendingBeforeUnlock = false;
      void writeSceneToFile(useScene3d.getState().project);
    }
    return;
  }

  // ファイル未作成 = localStorage からの移行 or 新規ユーザー。
  // 現在の in-memory state (localStorage 由来) を正とする。
  if (myToken !== sceneInitializeToken) return;
  sceneFileWriteUnlocked = true;
  scenePendingBeforeUnlock = false;
  const current = useScene3d.getState().project;
  // 既定シーンのまま (= 何も作っていない) なら空ファイルを作らない。
  // localStorage に保存済みのシーンがあったかで判定する
  // (presets.ts の categoriesAreDefault 判定と同じ思想)。
  let hadSaved = false;
  try {
    hadSaved = localStorage.getItem(PROJECT_SAVE_KEY) !== null;
  } catch {
    hadSaved = false;
  }
  if (hadSaved) {
    console.info("[scene3d] localStorage から 3D シーンをファイルへ移行");
    await writeSceneToFile(current);
  }
}

/* ------------------------------ バックアップから復元 ------------------------------ */
// scene3d.json も保存のたびに自動で世代バックアップされている (最大10世代) のに、
// そこへ到達する導線が無く開発者しか戻せなかった。presets 側と同じ形で塞ぐ
// (2026-07-30 独立評価 H-2)。

/**
 * 3Dシーンの世代バックアップ一覧を取得する（新しい順）。
 * 返り値: { path, at(epochミリ秒), shots(カット数) }[]。
 * 「バックアップから復元」UI が選択肢を出すために使う。
 */
export async function listScene3dBackups(): Promise<
  { path: string; at: number; shots: number }[]
> {
  try {
    const { storage } = await import("../ipc");
    const rows = await storage.listScene3dBackups();
    // [path, epochミリ秒, shot数]。Rust 側がミリ秒で返すのでそのまま使う。
    return rows.map(([path, ms, shots]) => ({ path, at: ms, shots }));
  } catch (err) {
    console.error("[scene3d] listScene3dBackups 失敗:", err);
    return [];
  }
}

/**
 * 指定バックアップの内容で現在の3Dシーンを置き換える（復元）。
 * 成功したら復元後のカット数を返す。失敗時は throw。
 *
 * 復元前の現状が失われないこと: 下の persistScene → writeSceneToFile →
 * Rust の scene3d_write が、**書き込み前に必ず** backup_projects_file で
 * 世代バックアップを取る（storage.rs「書き込み前に世代バックアップ」）。
 * よって誤復元してもひとつ前の状態へ戻せる（presets の restoreFromBackup と同じ思想）。
 */
export async function restoreScene3dFromBackup(backupPath: string): Promise<number> {
  // 書き込み解禁前（起動直後の読み込み中、または読み出しに失敗した状態）は復元しない。
  // persistScene がファイルへ書かずに戻るため、「復元しました」と出るのに正本は
  // 変わっていない、という最悪の見え方になる（2026-07-30 評価者指摘 M-3 の scene3d 版）。
  if (!sceneFileWriteUnlocked) {
    throw new Error("まだ読み込み中です。少し待ってからもう一度お試しください。");
  }
  const { storage } = await import("../ipc");
  const raw = await storage.readScene3dBackup(backupPath);
  const parsed = JSON.parse(raw) as SceneProject | null;
  // initializeScene3d のファイル読み出しと同じ有効性判定（壊れた内容で正本を潰さない）。
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 3 ||
    !parsed.shots?.length ||
    !parsed.cameras?.length
  ) {
    throw new Error("バックアップの形式が不正です");
  }
  const project = migrateProject(parsed);
  // デバウンス待ちの古い保存が復元後に後勝ちしないよう、先に取り消す。
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  useScene3d.setState({ project });
  // 即時に永続化する（デバウンスを待たない。復元は明示操作なので取りこぼさない）。
  persistScene(project);
  void pushScene3dToast("success", "3Dシーンを過去の状態に戻しました。");
  return project.shots.length;
}

/**
 * 復元の結果をトーストで知らせる。トースト取得に失敗しても復元自体は成立しているので
 * ログのみに留める（writeSceneToFileNow の失敗トーストと同じ扱い）。
 */
async function pushScene3dToast(kind: "success" | "error", text: string): Promise<void> {
  try {
    const { useToasts } = await import("./toasts");
    useToasts.getState().push({ kind, text, ttlMs: kind === "error" ? 8000 : 3500 });
  } catch {
    console.error("[scene3d]", text);
  }
}

/**
 * UI から呼ぶ復元エントリ。成否をトーストで伝える（文言は本関数が正本）。
 * 復元できたらカット数を返し、失敗したら null を返す（呼び出し側で分岐できる）。
 */
export async function restoreScene3dFromBackupWithToast(
  backupPath: string,
): Promise<number | null> {
  try {
    return await restoreScene3dFromBackup(backupPath);
  } catch (err) {
    await pushScene3dToast("error", `3Dシーンの復元に失敗しました: ${String(err)}`);
    return null;
  }
}

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
