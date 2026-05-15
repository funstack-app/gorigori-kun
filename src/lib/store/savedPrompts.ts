import { create } from "zustand";
import { useToasts } from "./toasts";

const STORE_FILE = "prompts.json";
const STORE_KEY = "items";

export type SavedPrompt = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  /** Incremented every time the user inserts the prompt — used to sort
   *  by "most used" and to surface oft-reused prompts. */
  useCount: number;
  createdAt: number;
  updatedAt: number;
};

export type PromptDraft = Omit<SavedPrompt, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export type PromptSort = "recent" | "used" | "title";

type State = {
  items: SavedPrompt[];
  loaded: boolean;
  sort: PromptSort;
  query: string;
  /** Active tag filter; null means no filter. */
  tag: string | null;
  load: () => Promise<void>;
  save: (draft: PromptDraft) => Promise<SavedPrompt>;
  remove: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  bumpUseCount: (id: string) => Promise<void>;
  setSort: (s: PromptSort) => void;
  setQuery: (q: string) => void;
  setTag: (t: string | null) => void;
};

// Cache the Store instance — re-running plugin import + load on every
// mutation is wasteful and risks racing concurrent writes.
let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null = null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    console.warn("savedPrompts loadStore failed", err);
    return null;
  });
  return storePromise;
}

/** Returns true on success, false if the write failed. Callers can
 *  surface a toast so the user knows the change won't survive restart. */
async function persist(items: SavedPrompt[]): Promise<boolean> {
  const store = await loadStore();
  if (!store) return false;
  try {
    await store.set(STORE_KEY, items);
    await store.save();
    return true;
  } catch (err) {
    console.warn("savedPrompts persist failed", err);
    return false;
  }
}

function uid(): string {
  // crypto.randomUUID is available in every Tauri-supported webview;
  // we keep a defensive fallback but it's effectively dead in production.
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

async function persistOrToast(items: SavedPrompt[], action: string) {
  const ok = await persist(items);
  if (!ok) {
    useToasts.getState().push({
      kind: "error",
      text: `${action}の保存に失敗しました。アプリを再起動すると元に戻ります。`,
      ttlMs: 8000,
    });
  }
}

/**
 * Comparator for the canonical visible order:
 *   1. pinned items first (pinned > unpinned)
 *   2. then user-chosen sort key
 *   3. ties broken by updatedAt desc
 */
export function comparePrompts(
  a: SavedPrompt,
  b: SavedPrompt,
  sort: PromptSort,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (sort === "title") return a.title.localeCompare(b.title, "ja");
  if (sort === "used") return (b.useCount ?? 0) - (a.useCount ?? 0);
  // recent
  return b.updatedAt - a.updatedAt;
}

export const useSavedPrompts = create<State>((set, get) => ({
  items: [],
  loaded: false,
  sort: "recent",
  query: "",
  tag: null,

  load: async () => {
    if (get().loaded) return;
    const store = await loadStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const raw = (await store.get<SavedPrompt[]>(STORE_KEY)) ?? [];
      // Normalize legacy shapes + drop entries that survived a
      // hand-edit gone wrong (missing/duplicate id, non-string title…).
      const seen = new Set<string>();
      const items: SavedPrompt[] = [];
      for (const p of raw) {
        if (!p || typeof p.id !== "string" || !p.id) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        items.push({
          id: p.id,
          title: typeof p.title === "string" ? p.title : "",
          body: typeof p.body === "string" ? p.body : "",
          tags: Array.isArray(p.tags)
            ? p.tags.filter((t): t is string => typeof t === "string")
            : [],
          pinned: !!p.pinned,
          useCount: typeof p.useCount === "number" ? p.useCount : 0,
          createdAt: p.createdAt ?? Date.now(),
          updatedAt: p.updatedAt ?? p.createdAt ?? Date.now(),
        });
      }
      set({ items, loaded: true });
    } catch (err) {
      console.warn("savedPrompts load failed", err);
      set({ loaded: true });
    }
  },

  save: async (draft) => {
    const now = Date.now();
    let saved!: SavedPrompt;
    let nextItems: SavedPrompt[] = [];
    // Build the next array atomically inside the updater so two rapid
    // saves don't read stale state across the await boundary.
    set((s) => {
      const idx = draft.id ? s.items.findIndex((p) => p.id === draft.id) : -1;
      if (idx >= 0) {
        const existing = s.items[idx];
        saved = {
          ...existing,
          title: draft.title.trim(),
          body: draft.body,
          tags: draft.tags,
          pinned: draft.pinned,
          useCount: draft.useCount,
          updatedAt: now,
        };
        nextItems = [...s.items];
        nextItems[idx] = saved;
      } else {
        saved = {
          id: draft.id ?? uid(),
          title: draft.title.trim(),
          body: draft.body,
          tags: draft.tags,
          pinned: draft.pinned,
          useCount: draft.useCount,
          createdAt: now,
          updatedAt: now,
        };
        nextItems = [...s.items, saved];
      }
      return { items: nextItems };
    });
    await persistOrToast(nextItems, "プロンプト");
    return saved;
  },

  remove: async (id) => {
    let nextItems: SavedPrompt[] = [];
    set((s) => {
      nextItems = s.items.filter((p) => p.id !== id);
      return { items: nextItems };
    });
    await persistOrToast(nextItems, "プロンプト削除");
  },

  togglePin: async (id) => {
    const now = Date.now();
    let nextItems: SavedPrompt[] = [];
    set((s) => {
      nextItems = s.items.map((p) =>
        p.id === id ? { ...p, pinned: !p.pinned, updatedAt: now } : p,
      );
      return { items: nextItems };
    });
    await persistOrToast(nextItems, "ピン");
  },

  duplicate: async (id) => {
    const src = get().items.find((p) => p.id === id);
    if (!src) return;
    const now = Date.now();
    const copy: SavedPrompt = {
      ...src,
      id: uid(),
      title: `${src.title} (コピー)`,
      pinned: false,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    let nextItems: SavedPrompt[] = [];
    set((s) => {
      nextItems = [...s.items, copy];
      return { items: nextItems };
    });
    await persistOrToast(nextItems, "複製");
  },

  bumpUseCount: async (id) => {
    let nextItems: SavedPrompt[] = [];
    set((s) => {
      nextItems = s.items.map((p) =>
        p.id === id ? { ...p, useCount: (p.useCount ?? 0) + 1 } : p,
      );
      return { items: nextItems };
    });
    // Fire-and-forget on disk: insertion shouldn't block on persistence.
    persistOrToast(nextItems, "使用回数").catch(() => {});
  },

  setSort: (sort) => set({ sort }),
  setQuery: (query) => set({ query }),
  setTag: (tag) => set({ tag }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.savedPrompts = useSavedPrompts;
}
