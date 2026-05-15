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

type EditorState = {
  activeTool: EditorTool;
  selectedLayerId: string | null;
  busyTool: EditorTool | null;
  canvas: unknown | null;
  sourceImagePath: string | null;
  message: string | null;
  error: string | null;
  revision: number;
  setActiveTool: (tool: EditorTool) => void;
  setSelectedLayerId: (id: string | null) => void;
  setBusyTool: (tool: EditorTool | null) => void;
  setCanvas: (canvas: unknown | null) => void;
  setSourceImagePath: (path: string | null) => void;
  setMessage: (message: string | null) => void;
  setError: (error: string | null) => void;
  bumpRevision: () => void;
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
  setActiveTool: (activeTool) => set({ activeTool }),
  setSelectedLayerId: (selectedLayerId) => set({ selectedLayerId }),
  setBusyTool: (busyTool) => set({ busyTool }),
  setCanvas: (canvas) => set({ canvas }),
  setSourceImagePath: (sourceImagePath) => set({ sourceImagePath }),
  setMessage: (message) => set({ message }),
  setError: (error) => set({ error }),
  bumpRevision: () => set((state) => ({ revision: state.revision + 1 })),
}));
