import { create } from "zustand";

import type { ComicTextTurnProgress } from "../comic/codexText";
import type {
  ComicPageResult,
  ComicPhase,
  ComicStoryPage,
} from "../comic/types";

type StateUpdate<T> = T | ((previous: T) => T);

function resolveUpdate<T>(previous: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

type ComicRunState = {
  phase: ComicPhase;
  storyPages: ComicStoryPage[];
  pageResults: ComicPageResult[];
  generatingStory: boolean;
  storyStartedAt: number | undefined;
  storyProgress: ComicTextTurnProgress | undefined;
  generatingPages: boolean;
  storyTemplateId: string | null;
  editingPage: number | null;
  recoveringPage: number | null;
  panelReeditSubmitting: boolean;
  panelReeditStartedAt: number | undefined;
  panelReeditRunError: string | null;
  setPhase: (update: StateUpdate<ComicPhase>) => void;
  setStoryPages: (update: StateUpdate<ComicStoryPage[]>) => void;
  setPageResults: (update: StateUpdate<ComicPageResult[]>) => void;
  setGeneratingStory: (update: StateUpdate<boolean>) => void;
  setStoryStartedAt: (update: StateUpdate<number | undefined>) => void;
  setStoryProgress: (update: StateUpdate<ComicTextTurnProgress | undefined>) => void;
  setGeneratingPages: (update: StateUpdate<boolean>) => void;
  setStoryTemplateId: (update: StateUpdate<string | null>) => void;
  setEditingPage: (update: StateUpdate<number | null>) => void;
  tryBeginPageRecovery: (page: number) => boolean;
  endPageRecovery: (page: number) => void;
  setPanelReeditSubmitting: (update: StateUpdate<boolean>) => void;
  setPanelReeditStartedAt: (update: StateUpdate<number | undefined>) => void;
  setPanelReeditRunError: (update: StateUpdate<string | null>) => void;
};

export const useComicRun = create<ComicRunState>((set, get) => ({
  phase: "input",
  storyPages: [],
  pageResults: [],
  generatingStory: false,
  storyStartedAt: undefined,
  storyProgress: undefined,
  generatingPages: false,
  storyTemplateId: null,
  editingPage: null,
  recoveringPage: null,
  panelReeditSubmitting: false,
  panelReeditStartedAt: undefined,
  panelReeditRunError: null,
  setPhase: (update) => set((state) => ({ phase: resolveUpdate(state.phase, update) })),
  setStoryPages: (update) =>
    set((state) => ({ storyPages: resolveUpdate(state.storyPages, update) })),
  setPageResults: (update) =>
    set((state) => ({ pageResults: resolveUpdate(state.pageResults, update) })),
  setGeneratingStory: (update) =>
    set((state) => ({ generatingStory: resolveUpdate(state.generatingStory, update) })),
  setStoryStartedAt: (update) =>
    set((state) => ({ storyStartedAt: resolveUpdate(state.storyStartedAt, update) })),
  setStoryProgress: (update) =>
    set((state) => ({ storyProgress: resolveUpdate(state.storyProgress, update) })),
  setGeneratingPages: (update) =>
    set((state) => ({ generatingPages: resolveUpdate(state.generatingPages, update) })),
  setStoryTemplateId: (update) =>
    set((state) => ({ storyTemplateId: resolveUpdate(state.storyTemplateId, update) })),
  setEditingPage: (update) =>
    set((state) => ({ editingPage: resolveUpdate(state.editingPage, update) })),
  tryBeginPageRecovery: (page) => {
    if (get().recoveringPage !== null) return false;
    set({ recoveringPage: page });
    return true;
  },
  endPageRecovery: (page) => {
    if (get().recoveringPage === page) set({ recoveringPage: null });
  },
  setPanelReeditSubmitting: (update) =>
    set((state) => ({
      panelReeditSubmitting: resolveUpdate(state.panelReeditSubmitting, update),
    })),
  setPanelReeditStartedAt: (update) =>
    set((state) => ({
      panelReeditStartedAt: resolveUpdate(state.panelReeditStartedAt, update),
    })),
  setPanelReeditRunError: (update) =>
    set((state) => ({
      panelReeditRunError: resolveUpdate(state.panelReeditRunError, update),
    })),
}));

let storyAbortController: AbortController | null = null;

export function setComicStoryAbortController(controller: AbortController | null): void {
  storyAbortController = controller;
}

export function clearComicStoryAbortController(controller: AbortController): void {
  if (storyAbortController === controller) storyAbortController = null;
}

export function abortComicStoryGeneration(): void {
  storyAbortController?.abort();
}
