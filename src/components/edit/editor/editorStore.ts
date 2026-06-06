import { create } from "zustand";

export type EditorTool =
  | "select"
  | "bgremove"
  | "clickseg"
  | "text-add"
  | "text-detect"
  | "inpaint"
  | "magic"
  | "redo-decompose";

export type EditorLayerKind = "image" | "text" | "mask";

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
  /** EditorCanvas がマウント中だけ set される path 取り込みハンドラ。 */
  pathIngestor: EditorPathIngestor | null;
  setActiveTool: (tool: EditorTool) => void;
  setSelectedLayerId: (id: string | null) => void;
  setBusyTool: (tool: EditorTool | null) => void;
  setCanvas: (canvas: unknown | null) => void;
  setSourceImagePath: (path: string | null) => void;
  setMessage: (message: string | null) => void;
  setError: (error: string | null) => void;
  bumpRevision: () => void;
  setPathIngestor: (ingestor: EditorPathIngestor | null) => void;
};

export const useEditor = create<EditorState>((set) => ({
  activeTool: "select",
  selectedLayerId: null,
  busyTool: null,
  canvas: null,
  sourceImagePath: null,
  message: null,
  error: null,
  revision: 0,
  pathIngestor: null,
  setActiveTool: (activeTool) => set({ activeTool }),
  setSelectedLayerId: (selectedLayerId) => set({ selectedLayerId }),
  setBusyTool: (busyTool) => set({ busyTool }),
  setCanvas: (canvas) => set({ canvas }),
  setSourceImagePath: (sourceImagePath) => set({ sourceImagePath }),
  setMessage: (message) => set({ message }),
  setError: (error) => set({ error }),
  bumpRevision: () => set((state) => ({ revision: state.revision + 1 })),
  setPathIngestor: (pathIngestor) => set({ pathIngestor }),
}));
