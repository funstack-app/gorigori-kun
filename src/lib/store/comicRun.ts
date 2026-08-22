import { create } from "zustand";

import type { ComicTextTurnProgress } from "../comic/codexText";
import type {
  ComicColorMode,
  ComicPageResult,
  ComicPhase,
  ComicStoryPage,
} from "../comic/types";
import { COMIC_STYLE_ANCHOR_DRAFT_STORY_ID } from "../comic/styleAnchor";
import { createPersistGuard, describeOutcome } from "./persistGuard";

/** 既存の `comic-stories.json/items` は変更せず、作品ラン用の別キー領域へ追加する。 */
export const COMIC_WORK_STYLE_STORE_FILE = "comic-run.json";
export const COMIC_WORK_STYLE_STORE_KEY = "workStyle";
export const COMIC_WORK_STYLE_ANCHORS_KEY = "styleAnchorImagePathsByStory";

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

export type ComicWorkStyleStorage = ComicWorkStyle & {
  /** 新形式。画風のお手本だけを作品IDごとに分けて保存する。 */
  styleAnchorImagePathsByStory: Record<string, string>;
};

export const DEFAULT_COMIC_WORK_STYLE_STORAGE: ComicWorkStyleStorage = {
  ...DEFAULT_COMIC_WORK_STYLE,
  styleAnchorImagePathsByStory: {},
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

/** 新形式を読み、旧形式の共有1件も移行用に残す。 */
export function parseComicWorkStyleStorage(
  raw: unknown,
): { ok: true; value: ComicWorkStyleStorage } | { ok: false; reason: string } {
  const base = parseComicWorkStyle(raw);
  if (!base.ok) return base;
  const data = raw as Record<string, unknown>;
  const savedAnchors = data[COMIC_WORK_STYLE_ANCHORS_KEY];
  if (
    savedAnchors !== undefined &&
    (!savedAnchors || typeof savedAnchors !== "object" || Array.isArray(savedAnchors))
  ) {
    return { ok: false, reason: "作品別の画風のお手本がオブジェクトではありません" };
  }
  const styleAnchorImagePathsByStory: Record<string, string> = {};
  for (const [storyId, value] of Object.entries(
    (savedAnchors ?? {}) as Record<string, unknown>,
  )) {
    if (!storyId.trim() || typeof value !== "string" || !value.trim()) {
      return { ok: false, reason: "作品別の画風のお手本に不正な項目があります" };
    }
    styleAnchorImagePathsByStory[storyId] = value.trim();
  }
  return {
    ok: true,
    value: {
      ...base.value,
      styleAnchorImagePathsByStory,
    },
  };
}

/**
 * 表示する作品を切り替える。旧共有値と下書き値は、最初の実作品へ一度だけ移す。
 * 返した storage を次の保存へ使えば、別作品へ同じお手本が漏れない。
 */
export function activateComicStyleAnchorStory(
  storage: ComicWorkStyleStorage,
  storyId: string,
): {
  storage: ComicWorkStyleStorage;
  styleAnchorImagePath: string | null;
  migrated: boolean;
} {
  const normalizedStoryId = storyId.trim() || COMIC_STYLE_ANCHOR_DRAFT_STORY_ID;
  const anchors = { ...storage.styleAnchorImagePathsByStory };
  let legacy = storage.styleAnchorImagePath;
  let nextAnchor = anchors[normalizedStoryId] ?? null;
  let migrated = false;

  if (!nextAnchor && normalizedStoryId !== COMIC_STYLE_ANCHOR_DRAFT_STORY_ID) {
    const fallback = anchors[COMIC_STYLE_ANCHOR_DRAFT_STORY_ID] ?? legacy;
    if (fallback) {
      nextAnchor = fallback;
      anchors[normalizedStoryId] = fallback;
      delete anchors[COMIC_STYLE_ANCHOR_DRAFT_STORY_ID];
      legacy = null;
      migrated = true;
    }
  }
  if (normalizedStoryId === COMIC_STYLE_ANCHOR_DRAFT_STORY_ID) {
    nextAnchor = anchors[normalizedStoryId] ?? legacy;
  }

  return {
    storage: {
      ...storage,
      styleAnchorImagePath: legacy,
      styleAnchorImagePathsByStory: anchors,
    },
    styleAnchorImagePath: nextAnchor,
    migrated,
  };
}

const workStyleGuard = createPersistGuard<ComicWorkStyleStorage>({
  name: "comicWorkStyle",
  file: COMIC_WORK_STYLE_STORE_FILE,
  key: COMIC_WORK_STYLE_STORE_KEY,
  parse: parseComicWorkStyleStorage,
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
  styleAnchorImagePathsByStory: Record<string, string>;
  styleAnchorLegacyImagePath: string | null;
  styleAnchorStoryId: string;
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
  setStyleAnchorStoryId: (storyId: string) => Promise<void>;
  setStyleAnchorImagePath: (update: StateUpdate<string | null>) => Promise<void>;
  setEditingPage: (update: StateUpdate<number | null>) => void;
  tryBeginPageRecovery: (page: number) => boolean;
  endPageRecovery: (page: number) => void;
  setPanelReeditSubmitting: (update: StateUpdate<boolean>) => void;
  setPanelReeditStartedAt: (update: StateUpdate<number | undefined>) => void;
  setPanelReeditRunError: (update: StateUpdate<string | null>) => void;
};

function currentWorkStyle(state: ComicRunState): ComicWorkStyleStorage {
  return {
    colorMode: state.colorMode,
    styleText: state.styleText,
    // 旧形式の値は、作品へ移行し終えるまでだけ残す。新しい選択は作品別mapへ保存する。
    styleAnchorImagePath: state.styleAnchorLegacyImagePath,
    styleAnchorImagePathsByStory: state.styleAnchorImagePathsByStory,
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
  styleAnchorImagePathsByStory: {},
  styleAnchorLegacyImagePath: null,
  styleAnchorStoryId: COMIC_STYLE_ANCHOR_DRAFT_STORY_ID,
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
        const currentStoryId = get().styleAnchorStoryId;
        const currentAnchor =
          outcome.value.styleAnchorImagePathsByStory[currentStoryId] ??
          (currentStoryId === COMIC_STYLE_ANCHOR_DRAFT_STORY_ID
            ? outcome.value.styleAnchorImagePath
            : null);
        set({
          colorMode: outcome.value.colorMode,
          styleText: outcome.value.styleText,
          styleAnchorImagePath: currentAnchor,
          styleAnchorImagePathsByStory:
            outcome.value.styleAnchorImagePathsByStory,
          styleAnchorLegacyImagePath: outcome.value.styleAnchorImagePath,
          workStyleLoaded: true,
        });
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
  setStyleAnchorStoryId: async (storyId) => {
    const normalizedStoryId = storyId.trim() || COMIC_STYLE_ANCHOR_DRAFT_STORY_ID;
    await get().loadWorkStyle();
    if (get().styleAnchorStoryId === normalizedStoryId) return;
    const revision = ++workStylePersistRevision;
    const current = get();
    const activated = activateComicStyleAnchorStory(
      currentWorkStyle(current),
      normalizedStoryId,
    );

    set({
      styleAnchorStoryId: normalizedStoryId,
      styleAnchorImagePath: activated.styleAnchorImagePath,
      styleAnchorImagePathsByStory:
        activated.storage.styleAnchorImagePathsByStory,
      styleAnchorLegacyImagePath: activated.storage.styleAnchorImagePath,
    });
    if (activated.migrated && revision === workStylePersistRevision) {
      await workStyleGuard.save(currentWorkStyle(get()));
    }
  },
  setStyleAnchorImagePath: async (update) => {
    const revision = ++workStylePersistRevision;
    await get().loadWorkStyle();
    if (revision !== workStylePersistRevision) return;
    const current = get();
    const rawNext = resolveUpdate(current.styleAnchorImagePath, update);
    const next = rawNext?.trim() || null;
    const anchors = { ...current.styleAnchorImagePathsByStory };
    if (next) anchors[current.styleAnchorStoryId] = next;
    else delete anchors[current.styleAnchorStoryId];
    set({
      styleAnchorImagePath: next,
      styleAnchorImagePathsByStory: anchors,
      // 手動変更後に旧共有値が別作品へ再移行しないよう、ここで役目を終える。
      styleAnchorLegacyImagePath: null,
    });
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
