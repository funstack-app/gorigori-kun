import { create } from "zustand";

import type { EditModeId } from "../../../lib/edit/modes";
import { EditorHistory, snapshotCanvas } from "./history";

export type EditorTool =
  | "select"
  | "bgremove"
  | "clickseg"
  | "grab"
  | "text-add"
  | "text-detect"
  | "inpaint"
  | "magic"
  | "redo-decompose"
  | "words";

/**
 * マジックグラブのクリックプレビュー状態。SAM2 predict で得たマスクを確定前に一時保持する。
 * base64 は元画像と同寸のマスク PNG。確定 (confirm) 時に writeMask → edit_grab へ渡す。
 */
export type GrabPreview = {
  maskBase64: string;
  width: number;
  height: number;
};

export type EditorLayerKind = "image" | "text" | "mask";

/** 物体分解数プリセット。"auto"=控えめ、"more"=多め。数値は ipc 呼び出し時に解決する。 */
export type ObjectCountMode = "auto" | "more";

/** 分解数プリセット → Rust へ渡す物体数上限。more は Rust 側 MAX_OBJECTS_HARD_CAP と同値。 */
export const OBJECT_COUNT_BY_MODE: Record<ObjectCountMode, number> = {
  auto: 6,
  more: 12,
};

export type EditorLayerMeta = {
  id: string;
  name: string;
  kind: EditorLayerKind;
  visible: boolean;
  locked: boolean;
  thumbnail: string | null;
};

/**
 * 既にローカル PC 上にある画像 path を編集タブに取り込んで Magic Layer を回す
 * ハンドラ。EditorCanvas がマウント時に `useEditorActions` の path 版取り込み
 * 関数を登録する。
 *
 * なぜ store 経由か: 外部 OS ファイル/別モニタからの D&D は Tauri ネイティブの
 * `attachWindowDragDrop` (非 React) が window 全体イベントとして受ける。そこから
 * 編集タブの React hook を直接呼べないため、登録済みハンドラを store に置いて
 * 橋渡しする。未登録 (= 編集タブ未マウント) なら null。
 */
export type EditorPathIngestor = (path: string) => void;

type EditorState = {
  activeTool: EditorTool;
  selectedLayerId: string | null;
  busyTool: EditorTool | null;
  canvas: unknown | null;
  sourceImagePath: string | null;
  message: string | null;
  error: string | null;
  revision: number;
  /**
   * レイヤー分解モード (高速・スタンダード / 低速・高精度)。EditModeSelector が
   * 切り替え、useEditorActions の Magic Layer 実行時に Rust へ渡す。EditWorkspace の
   * ローカル state ではなく store に置く理由: 実処理を持つ useEditorActions から
   * 現在の選択を読めるようにするため (旧構成では選択値がどこにも届いていなかった)。
   */
  editMode: EditModeId;
  /**
   * 物体分解 (SAM2 自動マスク) を有効にするか。standard モードでのみ効く。既定 ON。
   * OFF にするとテキスト+人物+背景の従来分解だけになる。
   */
  objectLayersEnabled: boolean;
  /**
   * 分解数プリセット。"auto"=控えめ(6件)、"more"=多め(12件)。
   * 非エンジニアの認知負荷を避けるため生の数値ではなく2択にする。
   */
  objectCountMode: ObjectCountMode;
  /** EditorCanvas がマウント中だけ set される path 取り込みハンドラ。 */
  pathIngestor: EditorPathIngestor | null;
  /** マジックグラブの確定待ちプレビュー (クリックで生成したマスク)。null=プレビューなし。 */
  grabPreview: GrabPreview | null;
  /**
   * Undo/Redo の履歴インスタンス。zustand の state に置くが reference 同一のまま
   * 内部スタックを更新する (履歴は大きくなり得るので immutable コピーはしない)。
   * ボタンの活性は canUndo/canRedo の boolean フラグで購読する。
   */
  history: EditorHistory;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * 履歴復元 (loadFromJSON) 中に true。復元で発火する canvas イベントで新しい
   * スナップショットを積まないためのガード。EditorCanvas のイベント購読側が読む。
   */
  historySuppressed: boolean;
  setActiveTool: (tool: EditorTool) => void;
  setEditMode: (mode: EditModeId) => void;
  setObjectLayersEnabled: (enabled: boolean) => void;
  setObjectCountMode: (mode: ObjectCountMode) => void;
  setSelectedLayerId: (id: string | null) => void;
  setBusyTool: (tool: EditorTool | null) => void;
  setCanvas: (canvas: unknown | null) => void;
  setSourceImagePath: (path: string | null) => void;
  setMessage: (message: string | null) => void;
  setError: (error: string | null) => void;
  bumpRevision: () => void;
  setPathIngestor: (ingestor: EditorPathIngestor | null) => void;
  setGrabPreview: (preview: GrabPreview | null) => void;
  /** 現在のキャンバス状態を履歴に積む (操作確定時に呼ぶ)。 */
  pushHistory: () => void;
  /** 画像を開いた直後に履歴を現在状態で初期化する (画像単位でリセット)。 */
  resetHistory: () => void;
  /** 1 手戻す。復元するスナップショットを返す (戻せないときは null)。 */
  undo: () => unknown | null;
  /** 1 手やり直す。復元するスナップショットを返す (やり直せないときは null)。 */
  redo: () => unknown | null;
  setHistorySuppressed: (suppressed: boolean) => void;
};

export const useEditor = create<EditorState>((set, get) => ({
  activeTool: "select",
  selectedLayerId: null,
  busyTool: null,
  canvas: null,
  sourceImagePath: null,
  message: null,
  error: null,
  revision: 0,
  editMode: "standard",
  objectLayersEnabled: true,
  objectCountMode: "auto",
  pathIngestor: null,
  grabPreview: null,
  history: new EditorHistory(),
  canUndo: false,
  canRedo: false,
  historySuppressed: false,
  setActiveTool: (activeTool) => set({ activeTool }),
  setEditMode: (editMode) => set({ editMode }),
  setObjectLayersEnabled: (objectLayersEnabled) => set({ objectLayersEnabled }),
  setObjectCountMode: (objectCountMode) => set({ objectCountMode }),
  setSelectedLayerId: (selectedLayerId) => set({ selectedLayerId }),
  setBusyTool: (busyTool) => set({ busyTool }),
  setCanvas: (canvas) => set({ canvas }),
  setSourceImagePath: (sourceImagePath) => set({ sourceImagePath }),
  setMessage: (message) => set({ message }),
  setError: (error) => set({ error }),
  bumpRevision: () => set((state) => ({ revision: state.revision + 1 })),
  setPathIngestor: (pathIngestor) => set({ pathIngestor }),
  setGrabPreview: (grabPreview) => set({ grabPreview }),
  pushHistory: () => {
    // 復元中 (loadFromJSON) の発火では積まない。復元は履歴の消費であって新規操作ではない。
    if (get().historySuppressed) return;
    const snapshot = snapshotCanvas(get().canvas);
    if (snapshot === null) return;
    const history = get().history;
    history.push(snapshot);
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  },
  resetHistory: () => {
    const snapshot = snapshotCanvas(get().canvas);
    const history = get().history;
    history.reset(snapshot);
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  },
  undo: () => {
    const history = get().history;
    const snapshot = history.undo();
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
    return snapshot;
  },
  redo: () => {
    const history = get().history;
    const snapshot = history.redo();
    set({ canUndo: history.canUndo(), canRedo: history.canRedo() });
    return snapshot;
  },
  setHistorySuppressed: (historySuppressed) => set({ historySuppressed }),
}));
