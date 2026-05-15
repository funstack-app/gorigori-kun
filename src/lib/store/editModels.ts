import { create } from "zustand";

import { editModels } from "../ipc";
import type {
  EditModelCategory,
  EditModelProgress,
  ModelStatus,
} from "../edit/types";

type DownloadState = {
  downloaded: number;
  total: number;
  error?: string;
};

type EditModelsState = {
  models: ModelStatus[];
  downloading: Map<string, DownloadState>;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  download: (modelIds: string[]) => Promise<void>;
  applyProgress: (progress: EditModelProgress) => void;
  isCategoryReady: (category: EditModelCategory) => boolean;
};

export const useEditModels = create<EditModelsState>((set, get) => ({
  models: [],
  downloading: new Map<string, DownloadState>(),
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const models = await editModels.list();
      set({ models, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  download: async (modelIds) => {
    set((state) => {
      const downloading = new Map(state.downloading);
      for (const modelId of modelIds) {
        const model = state.models.find((item) => item.id === modelId);
        downloading.set(modelId, {
          downloaded: 0,
          total: model?.sizeBytes ?? 0,
        });
      }
      return { downloading, error: null };
    });
    await editModels.download(modelIds);
  },

  applyProgress: (progress) => {
    set((state) => {
      const downloading = new Map(state.downloading);
      if (progress.kind === "started") {
        downloading.set(progress.modelId, {
          downloaded: 0,
          total: progress.totalBytes,
        });
      } else if (progress.kind === "progress") {
        downloading.set(progress.modelId, {
          downloaded: progress.downloadedBytes,
          total: progress.totalBytes,
        });
      } else if (progress.kind === "completed") {
        downloading.delete(progress.modelId);
      } else if (progress.kind === "failed") {
        const existing = downloading.get(progress.modelId);
        downloading.set(progress.modelId, {
          downloaded: existing?.downloaded ?? 0,
          total: existing?.total ?? 0,
          error: progress.reason,
        });
      }
      return { downloading };
    });

    if (progress.kind === "completed") {
      void get().load();
    }
    if (progress.kind === "failed") {
      set({ error: progress.reason });
    }
  },

  isCategoryReady: (category) => {
    const targets = get().models.filter((model) => model.category === category);
    return targets.length > 0 && targets.every((model) => model.downloaded);
  },
}));
