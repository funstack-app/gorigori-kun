import { create } from "zustand";

import type { EditLayer } from "../edit/types";
import type { SegmentationModel } from "../segmentation/types";

type EditLayersState = {
  sourceImagePath: string | null;
  layers: EditLayer[];
  selectedLayerId: string | null;
  selectedModel: SegmentationModel;
  loading: boolean;
  setSource: (path: string) => void;
  setLayers: (layers: EditLayer[]) => void;
  setSelectedModel: (model: SegmentationModel) => void;
  selectLayer: (id: string | null) => void;
  toggleVisibility: (id: string) => void;
  replaceLayer: (id: string, newImagePath: string) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
};

export const useEditLayers = create<EditLayersState>((set) => ({
  sourceImagePath: null,
  layers: [],
  selectedLayerId: null,
  selectedModel: "u2net",
  loading: false,

  setSource: (sourceImagePath) => set({ sourceImagePath }),

  setLayers: (layers) => {
    const selectedLayerId = layers[0]?.id ?? null;
    set({
      layers: layers.map((layer) => ({
        ...layer,
        selected: layer.id === selectedLayerId,
      })),
      selectedLayerId,
    });
  },

  setSelectedModel: (selectedModel) => set({ selectedModel }),

  selectLayer: (selectedLayerId) =>
    set((state) => ({
      selectedLayerId,
      layers: state.layers.map((layer) => ({
        ...layer,
        selected: layer.id === selectedLayerId,
      })),
    })),

  toggleVisibility: (id) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === id ? { ...layer, visible: !layer.visible } : layer,
      ),
    })),

  replaceLayer: (id, newImagePath) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === id ? { ...layer, imagePath: newImagePath } : layer,
      ),
    })),

  setLoading: (loading) => set({ loading }),

  reset: () =>
    set({
      sourceImagePath: null,
      layers: [],
      selectedLayerId: null,
      selectedModel: "u2net",
      loading: false,
    }),
}));

export type { EditLayer, EditLayersState };

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.editLayers = useEditLayers;
}
