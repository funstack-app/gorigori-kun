import { create } from "zustand";

import type { RegulationImageResult } from "../regulationCheck/check";
import { DEFAULT_RULE_SETS, type RegulationRule } from "../regulationCheck/rules";

type StateUpdate<T> = T | ((previous: T) => T);

function resolveUpdate<T>(previous: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

export type RegulationRuleSetSnapshot = {
  id: string;
  name: string;
  rules: RegulationRule[];
};

export type RegulationCheckResultsState = {
  ruleSet: RegulationRuleSetSnapshot;
  results: RegulationImageResult[];
};

type RegulationCheckRunState = {
  imagePaths: string[];
  ruleSetId: string;
  running: boolean;
  resultState: RegulationCheckResultsState | null;
  runToken: number;
  setImagePaths: (update: StateUpdate<string[]>) => void;
  setRuleSetId: (update: StateUpdate<string>) => void;
  setRunning: (update: StateUpdate<boolean>) => void;
  setResultState: (update: StateUpdate<RegulationCheckResultsState | null>) => void;
  beginRun: () => number;
  invalidateRun: () => void;
  isCurrentRun: (token: number) => boolean;
};

export const useRegulationCheckRun = create<RegulationCheckRunState>((set, get) => ({
  imagePaths: [],
  ruleSetId: DEFAULT_RULE_SETS[0].id,
  running: false,
  resultState: null,
  runToken: 0,
  setImagePaths: (update) =>
    set((state) => ({ imagePaths: resolveUpdate(state.imagePaths, update) })),
  setRuleSetId: (update) =>
    set((state) => ({ ruleSetId: resolveUpdate(state.ruleSetId, update) })),
  setRunning: (update) => set((state) => ({ running: resolveUpdate(state.running, update) })),
  setResultState: (update) =>
    set((state) => ({ resultState: resolveUpdate(state.resultState, update) })),
  beginRun: () => {
    const token = get().runToken + 1;
    set({ runToken: token });
    return token;
  },
  invalidateRun: () => set((state) => ({ runToken: state.runToken + 1, running: false })),
  isCurrentRun: (token) => get().runToken === token,
}));
