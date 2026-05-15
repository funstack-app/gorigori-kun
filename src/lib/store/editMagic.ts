import { create } from "zustand";

import type { MagicLayerProgress, MagicLayerResult } from "../edit/types";

type EditMagicState = {
  progress: MagicLayerProgress | null;
  result: MagicLayerResult | null;
  running: boolean;
  error: string | null;
  setProgress: (progress: MagicLayerProgress | null) => void;
  setResult: (result: MagicLayerResult | null) => void;
  setRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
};

export const useEditMagic = create<EditMagicState>((set) => ({
  progress: null,
  result: null,
  running: false,
  error: null,
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result }),
  setRunning: (running) => set({ running }),
  setError: (error) => set({ error }),
  reset: () =>
    set({ progress: null, result: null, running: false, error: null }),
}));
