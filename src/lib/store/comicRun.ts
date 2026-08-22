import { create } from "zustand";

import type { ComicTextTurnProgress } from "../comic/codexText";
import type {
  ComicColorMode,
  ComicPageResult,
  ComicPhase,
  ComicStoryPage,
} from "../comic/types";
import { createPersistGuard, describeOutcome } from "./persistGuard";

/** 既存の `comic-stories.json/items` は変更せず、作品ラン用の別キー領域へ追加する。 */
export const COMIC_WORK_STYLE_STORE_FILE = "comic-run.json";
export const COMIC_WORK_STYLE_STORE_KEY = "workStyle";

export type ComicWorkStyle = {
  colorMode: ComicColorMode;
  styleText: string;
  styleAnchorImagePath: string | null;
};

export const DEFAULT_COMIC_WORK_STYLE: ComicWorkStyle = {
  colorMode: "mono",
  styleText: "",
  styleAnchorImagePath: null,
};

/**
 * 旧保存データは3項目が無くても既定値で開く。存在する項目の型が壊れている場合だけ
 * invalid にし、読めない正本を空値で上書きしない。
 */
export function parseComicWorkStyle(
  raw: unknown,
): { ok: true; value: ComicWorkStyle } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "作品の画風設定がオブジェクトではありません" };
  }
  const data = raw as Record<string, unknown>;
  const colorMode = data.colorMode;
  if (
    colorMode !== undefined &&
    colorMode !== "mono" &&
    colorMode !== "color" &&
    colorMode !== "faithful"
  ) {
    return { ok: false, reason: "画風モードが不正です" };
  }
  if (data.styleText !== undefined && typeof data.styleText !== "string") {
    return { ok: false, reason: "絵柄の指定が文字列ではありません" };
  }
  if (
    data.styleAnchorImagePath !== undefined &&
    data.styleAnchorImagePath !== null &&
    typeof data.styleAnchorImagePath !== "string"
  ) {
    return { ok: false, reason: "画風のお手本の保存先が不正です" };
  }
  const anchor =
    typeof data.styleAnchorImagePath === "string"
      ? data.styleAnchorImagePath.trim()
      : "";
  return {
    ok: true,
    value: {
      colorMode: (colorMode as ComicColorMode | undefined) ?? "mono",
      styleText: typeof data.styleText === "string" ? data.styleText : "",
      styleAnchorImagePath: anchor || null,
    },
  };
}

const workStyleGuard = createPersistGuard<ComicWorkStyle>({
  name: "comicWorkStyle",
  file: COMIC_WORK_STYLE_STORE_FILE,
  key: COMIC_WORK_STYLE_STORE_KEY,
  parse: parseComicWorkStyle,
});

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
  /** 作品単位の画風設定。タブ移動とアプリ再起動をまたいで保持する。 */
  colorMode: ComicColorMode;
  styleText: string;
  styleAnchorImagePath: string | null;
  workStyleLoaded: boolean;
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
  loadWorkStyle: () => Promise<void>;
  setColorMode: (update: StateUpdate<ComicColorMode>) => Promise<void>;
  setStyleText: (update: StateUpdate<string>) => Promise<void>;
  setStyleAnchorImagePath: (update: StateUpdate<string | null>) => Promise<void>;
  setEditingPage: (update: StateUpdate<number | null>) => void;
  tryBeginPageRecovery: (page: number) => boolean;
  endPageRecovery: (page: number) => void;
  setPanelReeditSubmitting: (update: StateUpdate<boolean>) => void;
  setPanelReeditStartedAt: (update: StateUpdate<number | undefined>) => void;
  setPanelReeditRunError: (update: StateUpdate<string | null>) => void;
};

function currentWorkStyle(state: ComicRunState): ComicWorkStyle {
  return {
    colorMode: state.colorMode,
    styleText: state.styleText,
    styleAnchorImagePath: state.styleAnchorImagePath,
  };
}

let workStyleLoadInFlight: Promise<void> | null = null;
let workStylePersistRevision = 0;

export const useComicRun = create<ComicRunState>((set, get) => ({
  phase: "input",
  storyPages: [],
  pageResults: [],
  generatingStory: false,
  storyStartedAt: undefined,
  storyProgress: undefined,
  generatingPages: false,
  storyTemplateId: null,
  ...DEFAULT_COMIC_WORK_STYLE,
  workStyleLoaded: false,
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
  loadWorkStyle: () => {
    if (get().workStyleLoaded) return Promise.resolve();
    if (workStyleLoadInFlight) return workStyleLoadInFlight;
    workStyleLoadInFlight = (async () => {
      const outcome = await workStyleGuard.load();
      if (outcome.status === "ok") {
        set({ ...outcome.value, workStyleLoaded: true });
      } else {
        if (outcome.status !== "absent") {
          console.warn(`[comicWorkStyle] ${describeOutcome(outcome)}`);
        }
        // absent は新規。invalid/ioError はメモリ上で使えても guard が保存を封鎖する。
        set({ workStyleLoaded: true });
      }
    })().finally(() => {
      workStyleLoadInFlight = null;
    });
    return workStyleLoadInFlight;
  },
  setColorMode: async (update) => {
    const next = resolveUpdate(get().colorMode, update);
    const revision = ++workStylePersistRevision;
    set({ colorMode: next });
    await get().loadWorkStyle();
    // 読込が先に返して古い値を入れても、利用者が今選んだ値を最後に戻す。
    set({ colorMode: next });
    if (revision === workStylePersistRevision) {
      await workStyleGuard.save(currentWorkStyle(get()));
    }
  },
  setStyleText: async (update) => {
    const next = resolveUpdate(get().styleText, update);
    const revision = ++workStylePersistRevision;
    set({ styleText: next });
    await get().loadWorkStyle();
    set({ styleText: next });
    if (revision === workStylePersistRevision) {
      await workStyleGuard.save(currentWorkStyle(get()));
    }
  },
  setStyleAnchorImagePath: async (update) => {
    const next = resolveUpdate(get().styleAnchorImagePath, update);
    const revision = ++workStylePersistRevision;
    set({ styleAnchorImagePath: next });
    await get().loadWorkStyle();
    set({ styleAnchorImagePath: next });
    if (revision === workStylePersistRevision) {
      await workStyleGuard.save(currentWorkStyle(get()));
    }
  },
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
