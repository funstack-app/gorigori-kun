import { create } from "zustand";
import { createPersistGuard, describeOutcome } from "./persistGuard";
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

/**
 * 保存済みプロンプトを正規化する (persistGuard の parse)。
 *
 * **壊れた要素を黙って捨てない** (2026-08-06 / DL-13)。以前は id 欠落等を
 * その場で filter して残りを返していたが、それだと「捨てたあとの状態」が次の
 * 保存で正本になり、手編集の事故で消えたプロンプトが永久に戻らなくなる。
 * 1 件でも壊れていたら invalid にして、persistGuard 側で書き込みごと封鎖する。
 */
function parsePrompts(
  raw: unknown,
): { ok: true; value: SavedPrompt[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "配列ではありません" };
  const seen = new Set<string>();
  const items: SavedPrompt[] = [];
  for (const p of raw as SavedPrompt[]) {
    if (!p || typeof p.id !== "string" || !p.id) {
      return { ok: false, reason: "id を持たない要素があります" };
    }
    // 重複 id は「壊れている」とまでは言えない (旧バージョンの複製バグの痕跡)。
    // 先勝ちで畳んでよいが、捨てた事実はログに残す。
    if (seen.has(p.id)) {
      console.warn("[savedPrompts] 重複 id を畳みました:", p.id);
      continue;
    }
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
  return { ok: true, value: items };
}

/**
 * 「読めなければ書かない」を担保する共有ガード (W0)。
 * 読込が invalid / ioError の間、`guard.save` は 1 バイトも書かずに false を返す。
 */
const guard = createPersistGuard<SavedPrompt[]>({
  name: "savedPrompts",
  file: STORE_FILE,
  key: STORE_KEY,
  parse: parsePrompts,
});

/** Returns true on success, false if the write failed or is blocked. */
async function persist(items: SavedPrompt[]): Promise<boolean> {
  return guard.save(items);
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
    // 封鎖 (読めていない) と書き込み失敗を区別して伝える。前者は「保存先が
    // 読めないので、上書きを防ぐために保存を止めた」であって、単なる失敗ではない。
    const blocked = !guard.canWrite();
    useToasts.getState().push({
      kind: "error",
      text: blocked
        ? `${action}を保存できませんでした。保存先のプロンプト帳を読み取れないため、既存データを壊さないよう保存を中止しています。アプリを再起動すると再試行します。`
        : `${action}の保存に失敗しました。アプリを再起動すると元に戻ります。`,
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

  /**
   * 起動時に 1 回読む。
   *
   * **読めなかった場合も `loaded: true` にする** (「まだ読み込み中」と
   * 「読めなかった」を UI では区別しない = 従来どおりの見え方)。ただし
   * persistGuard 側で書き込みが封鎖されるので、その空表示が保存でディスクへ
   * 焼き付くことはない (DL-13 の核心)。
   */
  load: async () => {
    if (get().loaded) return;
    const outcome = await guard.load();
    if (outcome.status === "ok") {
      set({ items: outcome.value, loaded: true });
      return;
    }
    if (outcome.status !== "absent") {
      console.warn(`[savedPrompts] ${describeOutcome(outcome)}`);
    }
    // absent = 新規ユーザー。invalid / ioError = 読めない (書き込みは封鎖済み)。
    set({ loaded: true });
  },

  save: async (draft) => {
    // 起動直後 (load 未完了) の保存でディスクの既存台帳を空基準で上書きしない。
    // load は loaded ガード付きで冪等 (comicStoryHistory / unsavedPlanChats と同型)。
    if (!get().loaded) await get().load();
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
    if (!get().loaded) await get().load();
    let nextItems: SavedPrompt[] = [];
    set((s) => {
      nextItems = s.items.filter((p) => p.id !== id);
      return { items: nextItems };
    });
    await persistOrToast(nextItems, "プロンプト削除");
  },

  togglePin: async (id) => {
    if (!get().loaded) await get().load();
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
    if (!get().loaded) await get().load();
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
    if (!get().loaded) await get().load();
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
