import { create } from "zustand";

/**
 * 漫画「話（あらすじ）」の自動履歴 (B-3 2026-07-30)。
 *
 * savedPrompts.ts (手動プロンプト帳) と同じ plugin-store 方式の別ファイル。
 * 相乗りしない理由: 構成生成のたびに自動で積むため、手動で整えた帳面を
 * 自動エントリで汚す。保存失敗はトーストを出さない (自動保存が作業を
 * 邪魔しない。console.warn のみ)。
 */

const STORE_FILE = "comic-stories.json";
const STORE_KEY = "items";
/** 保持する履歴の上限。超えた分は古い順に落とす。 */
const MAX_ITEMS = 30;

export type ComicStoryHistoryItem = {
  id: string;
  /** 「話（あらすじ）」の全文。 */
  text: string;
  createdAt: number;
};

type State = {
  items: ComicStoryHistoryItem[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 構成生成の開始時に自動で積む。同一文は先頭へ移動 (重複を作らない)。 */
  add: (text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null = null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    console.warn("comicStoryHistory loadStore failed", err);
    return null;
  });
  return storePromise;
}

async function persist(items: ComicStoryHistoryItem[]): Promise<void> {
  const store = await loadStore();
  if (!store) return;
  try {
    await store.set(STORE_KEY, items);
    await store.save();
  } catch (err) {
    console.warn("comicStoryHistory persist failed", err);
  }
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `h_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export const useComicStoryHistory = create<State>((set, get) => ({
  items: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    const store = await loadStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const raw = (await store.get<ComicStoryHistoryItem[]>(STORE_KEY)) ?? [];
      const seen = new Set<string>();
      const items: ComicStoryHistoryItem[] = [];
      for (const it of raw) {
        if (!it || typeof it.id !== "string" || !it.id) continue;
        if (typeof it.text !== "string" || !it.text.trim()) continue;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push({
          id: it.id,
          text: it.text,
          createdAt: typeof it.createdAt === "number" ? it.createdAt : Date.now(),
        });
      }
      set({ items: items.slice(0, MAX_ITEMS), loaded: true });
    } catch (err) {
      console.warn("comicStoryHistory load failed", err);
      set({ loaded: true });
    }
  },

  add: async (text) => {
    // 起動直後 (load 未完了) の追加でディスクの既存履歴を空配列基準で
    // 上書きしないよう、必ず先に読み込む (load は loaded ガード付きで冪等)。
    if (!get().loaded) await get().load();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (get().items[0]?.text === trimmed) return;
    let next: ComicStoryHistoryItem[] = [];
    set((s) => {
      next = [
        { id: uid(), text: trimmed, createdAt: Date.now() },
        ...s.items.filter((i) => i.text !== trimmed),
      ].slice(0, MAX_ITEMS);
      return { items: next };
    });
    await persist(next);
  },

  remove: async (id) => {
    // add と同じ理由。load 前の削除でディスクの履歴を消し飛ばさない。
    if (!get().loaded) await get().load();
    let next: ComicStoryHistoryItem[] = [];
    set((s) => {
      next = s.items.filter((i) => i.id !== id);
      return { items: next };
    });
    await persist(next);
  },
}));
