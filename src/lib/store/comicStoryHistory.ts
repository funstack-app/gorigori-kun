import { create } from "zustand";

import { createPersistGuard, describeOutcome } from "./persistGuard";

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

/**
 * 履歴を検証する (persistGuard の parse)。
 *
 * **壊れた要素を黙って捨てない** (2026-08-06 / DL-14)。捨てた状態が次の保存で
 * 正本になると、手編集の事故で消えたあらすじが永久に戻らない。1 件でも壊れて
 * いたら invalid にして書き込みごと封鎖する。
 */
function parseHistory(
  raw: unknown,
): { ok: true; value: ComicStoryHistoryItem[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "配列ではありません" };
  const seen = new Set<string>();
  const items: ComicStoryHistoryItem[] = [];
  for (const it of raw as ComicStoryHistoryItem[]) {
    if (!it || typeof it.id !== "string" || !it.id) {
      return { ok: false, reason: "id を持たない要素があります" };
    }
    if (typeof it.text !== "string") {
      return { ok: false, reason: "text が文字列でない要素があります" };
    }
    // 空文字・重複は「壊れている」とまでは言えないので畳んでよい (痕跡は残す)。
    if (!it.text.trim() || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({
      id: it.id,
      text: it.text,
      createdAt: typeof it.createdAt === "number" ? it.createdAt : Date.now(),
    });
  }
  return { ok: true, value: items };
}

/** 「読めなければ書かない」を担保する共有ガード (W0)。 */
const guard = createPersistGuard<ComicStoryHistoryItem[]>({
  name: "comicStoryHistory",
  file: STORE_FILE,
  key: STORE_KEY,
  parse: parseHistory,
});

/**
 * 保存する。読込が未確定 / 失敗中なら **書かずに false** を返す
 * (自動保存なのでトーストは出さない。console.warn は guard 側で出る)。
 */
async function persist(items: ComicStoryHistoryItem[]): Promise<boolean> {
  return guard.save(items);
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
    const outcome = await guard.load();
    if (outcome.status === "ok") {
      set({ items: outcome.value.slice(0, MAX_ITEMS), loaded: true });
      return;
    }
    if (outcome.status !== "absent") {
      // 読めなかった。画面は空のままだが、guard が書き込みを封鎖しているので
      // この空が次の add で既存履歴を潰すことはない (DL-14 の核心)。
      console.warn(`[comicStoryHistory] ${describeOutcome(outcome)}`);
    }
    set({ loaded: true });
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
