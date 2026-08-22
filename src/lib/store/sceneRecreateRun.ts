import { create } from "zustand";

import type {
  AnalyzeStatus,
  Keyframe,
  SceneAnalysis,
} from "../sceneRecreate/types";

type StateUpdate<T> = T | ((previous: T) => T);

function resolveUpdate<T>(previous: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

type SceneRecreateRunState = {
  keyframes: Keyframe[];
  status: AnalyzeStatus;
  describeDone: number;
  analysis: SceneAnalysis | null;
  startedAt: number | null;
  extractMsg: string | null;
  runToken: number;
  setKeyframes: (update: StateUpdate<Keyframe[]>) => void;
  setStatus: (update: StateUpdate<AnalyzeStatus>) => void;
  setDescribeDone: (update: StateUpdate<number>) => void;
  setAnalysis: (update: StateUpdate<SceneAnalysis | null>) => void;
  setStartedAt: (update: StateUpdate<number | null>) => void;
  setExtractMsg: (update: StateUpdate<string | null>) => void;
  beginRun: () => number;
  isCurrentRun: (token: number) => boolean;
};

export const useSceneRecreateRun = create<SceneRecreateRunState>((set, get) => ({
  keyframes: [],
  status: "idle",
  describeDone: 0,
  analysis: null,
  startedAt: null,
  extractMsg: null,
  runToken: 0,
  setKeyframes: (update) =>
    set((state) => ({ keyframes: resolveUpdate(state.keyframes, update) })),
  setStatus: (update) => set((state) => ({ status: resolveUpdate(state.status, update) })),
  setDescribeDone: (update) =>
    set((state) => ({ describeDone: resolveUpdate(state.describeDone, update) })),
  setAnalysis: (update) =>
    set((state) => ({ analysis: resolveUpdate(state.analysis, update) })),
  setStartedAt: (update) =>
    set((state) => ({ startedAt: resolveUpdate(state.startedAt, update) })),
  setExtractMsg: (update) =>
    set((state) => ({ extractMsg: resolveUpdate(state.extractMsg, update) })),
  beginRun: () => {
    const token = get().runToken + 1;
    set({ runToken: token });
    return token;
  },
  isCurrentRun: (token) => get().runToken === token,
}));
