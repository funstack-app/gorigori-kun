import { create } from "zustand";

import {
  isSuccessfulRecheckResult,
  type PendingRegulationRecheckSnapshot,
  type RecheckResultStatus,
} from "../regulation/recheck";
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
  ruleSetId: string;
  customRule: string;
  ruleSet: RegulationRuleSetSnapshot;
  results: RegulationImageResult[];
};

export type PendingRegulationRecheck = PendingRegulationRecheckSnapshot;

type RegulationCheckRunState = {
  imagePaths: string[];
  ruleSetId: string;
  running: boolean;
  resultState: RegulationCheckResultsState | null;
  pendingRechecks: PendingRegulationRecheck[];
  runToken: number;
  setImagePaths: (update: StateUpdate<string[]>) => void;
  setRuleSetId: (update: StateUpdate<string>) => void;
  setRunning: (update: StateUpdate<boolean>) => void;
  setResultState: (update: StateUpdate<RegulationCheckResultsState | null>) => void;
  queuePendingRecheck: (pending: PendingRegulationRecheck) => void;
  removePendingRecheck: (imagePath: string) => void;
  removeImage: (imagePath: string) => void;
  clearImages: () => void;
  retargetPendingRecheck: (originalPath: string, revisedPath: string) => void;
  completePendingRecheck: (
    imagePath: string,
    result: RecheckResultStatus | null | undefined,
  ) => void;
  beginRun: () => number;
  invalidateRun: () => void;
  isCurrentRun: (token: number) => boolean;
};

export const useRegulationCheckRun = create<RegulationCheckRunState>((set, get) => ({
  imagePaths: [],
  ruleSetId: DEFAULT_RULE_SETS[0].id,
  running: false,
  resultState: null,
  pendingRechecks: [],
  runToken: 0,
  setImagePaths: (update) =>
    set((state) => ({ imagePaths: resolveUpdate(state.imagePaths, update) })),
  setRuleSetId: (update) =>
    set((state) => ({ ruleSetId: resolveUpdate(state.ruleSetId, update) })),
  setRunning: (update) => set((state) => ({ running: resolveUpdate(state.running, update) })),
  setResultState: (update) =>
    set((state) => ({ resultState: resolveUpdate(state.resultState, update) })),
  queuePendingRecheck: (pending) =>
    set((state) => ({
      pendingRechecks: [
        ...state.pendingRechecks.filter((item) => item.imagePath !== pending.imagePath),
        pending,
      ],
    })),
  removePendingRecheck: (imagePath) =>
    set((state) => ({
      pendingRechecks: state.pendingRechecks.filter((item) => item.imagePath !== imagePath),
    })),
  removeImage: (imagePath) =>
    set((state) => ({
      imagePaths: state.imagePaths.filter((path) => path !== imagePath),
      pendingRechecks: state.pendingRechecks.filter((item) => item.imagePath !== imagePath),
    })),
  clearImages: () => set({ imagePaths: [], pendingRechecks: [] }),
  retargetPendingRecheck: (originalPath, revisedPath) =>
    set((state) => ({
      pendingRechecks: state.pendingRechecks.map((item) =>
        item.imagePath === originalPath ? { ...item, imagePath: revisedPath } : item,
      ),
    })),
  completePendingRecheck: (imagePath, result) =>
    set((state) => ({
      pendingRechecks: isSuccessfulRecheckResult(result, imagePath)
        ? state.pendingRechecks.filter((item) => item.imagePath !== imagePath)
        : state.pendingRechecks,
    })),
  beginRun: () => {
    const token = get().runToken + 1;
    set({ runToken: token });
    return token;
  },
  invalidateRun: () => set((state) => ({ runToken: state.runToken + 1, running: false })),
  isCurrentRun: (token) => get().runToken === token,
}));
