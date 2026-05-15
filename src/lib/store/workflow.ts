import { create } from "zustand";

export type PrimaryMode = "image" | "video";
export type VideoMode = "story" | "multiAngle";
export type ImageMode = "generate" | "edit" | "layers";
export type LayerKind = "text" | "person" | "background" | "object" | "adjustment";

export type LockedReference = {
  path: string;
  name: string;
};

export type LayerItem = {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number;
};

type WorkflowState = {
  primaryMode: PrimaryMode;
  videoMode: VideoMode;
  imageMode: ImageMode;
  lockedReference?: LockedReference;
  layers: LayerItem[];
  setPrimaryMode: (mode: PrimaryMode) => void;
  setVideoMode: (mode: VideoMode) => void;
  setImageMode: (mode: ImageMode) => void;
  lockReference: (ref: LockedReference) => void;
  clearReference: () => void;
  addLayer: (kind: LayerKind) => void;
  toggleLayer: (id: string) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  removeLayer: (id: string) => void;
};

function labelForKind(kind: LayerKind): string {
  switch (kind) {
    case "text":
      return "テキスト";
    case "person":
      return "人物";
    case "background":
      return "背景";
    case "object":
      return "素材";
    case "adjustment":
      return "色調補正";
  }
}

function createLayer(kind: LayerKind): LayerItem {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: labelForKind(kind),
    kind,
    visible: true,
    opacity: 100,
  };
}

export const useWorkflow = create<WorkflowState>((set) => ({
  primaryMode: "video",
  videoMode: "story",
  imageMode: "generate",
  layers: [
    createLayer("text"),
    createLayer("person"),
    createLayer("background"),
    createLayer("adjustment"),
  ],
  setPrimaryMode: (primaryMode) => set({ primaryMode }),
  setVideoMode: (videoMode) => set({ videoMode }),
  setImageMode: (imageMode) => set({ imageMode }),
  lockReference: (lockedReference) => set({ lockedReference }),
  clearReference: () => set({ lockedReference: undefined }),
  addLayer: (kind) => set((s) => ({ layers: [createLayer(kind), ...s.layers] })),
  toggleLayer: (id) =>
    set((s) => ({
      layers: s.layers.map((layer) =>
        layer.id === id ? { ...layer, visible: !layer.visible } : layer,
      ),
    })),
  setLayerOpacity: (id, opacity) =>
    set((s) => ({
      layers: s.layers.map((layer) =>
        layer.id === id ? { ...layer, opacity } : layer,
      ),
    })),
  removeLayer: (id) =>
    set((s) => ({ layers: s.layers.filter((layer) => layer.id !== id) })),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.workflow = useWorkflow;
}
