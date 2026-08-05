import { create } from "zustand";
import { useSettings } from "./settings";
import { useToasts } from "./toasts";

/**
 * v29: 作品ごとの「世界観 / コンテキスト」を複数保持し、プルダウンで切り替える。
 *
 * 旧実装は `AppSettings.worldContext` に単一の自由文を持っていた。案件・作品ごとに
 * 使い分けたいという要望 (STΛCK 指示 + ろんきゃん FB 2026-07-31) を受け、名前付き
 * エントリの配列を `world-contexts.json` (plugin-store 系統(1)) に切り出した。
 *
 * - `settings.worldContext` は **レガシーとして残置**。初回ロード時に 1 エントリへ
 *   移行するが、元の値は消さない・書き換えない (移行の非破壊)。
 * - 削除は物理削除せず `archived: true` のソフト削除
 *   (「画像/履歴/プロンプト消さない」原則)。
 * - ひな型は `savedPrompts.ts` (同じ plugin-store + Zustand 構成)。
 */

const STORE_FILE = "world-contexts.json";
const ITEMS_KEY = "items";
const ACTIVE_KEY = "activeId";

export type WorldContextEntry = {
  id: string;
  /** プルダウン表示名 */
  name: string;
  /** 本文 (Markdown 等の自由文) */
  content: string;
  /** ファイル読み込みで作られた場合の元ファイル名 (例 "sekai.md")。手打ちは undefined */
  sourceFile?: string;
  /** ソフト削除フラグ。true はプルダウンに出さない */
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
};

type State = {
  items: WorldContextEntry[];
  activeId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  create: (name: string) => Promise<WorldContextEntry>;
  /** 保存に成功したら true。呼び出し側は false のとき成功トーストを出さない。 */
  update: (
    id: string,
    patch: { name?: string; content?: string },
  ) => Promise<boolean>;
  /** 保存に失敗した場合は entry.persisted:false。UI は成功トーストを抑止する。 */
  importFromFile: (
    fileName: string,
    content: string,
  ) => Promise<WorldContextEntry & { persisted: boolean }>;
  /** 保存に成功したら true。 */
  archive: (id: string) => Promise<boolean>;
  setActive: (id: string | null) => Promise<void>;
  activeContent: () => string | undefined;
};

// Store インスタンスはキャッシュする (savedPrompts と同じ理由: 変更のたびに
// plugin import + load を回すのは無駄で、並行書き込みのレースも招く)。
let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null =
  null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    console.warn("worldContexts loadStore failed", err);
    return null;
  });
  return storePromise;
}

/** 書き込み成功なら true。失敗時は呼び出し側がトーストで知らせる。 */
async function persist(
  items: WorldContextEntry[],
  activeId: string | null,
): Promise<boolean> {
  const store = await loadStore();
  if (!store) return false;
  try {
    await store.set(ITEMS_KEY, items);
    await store.set(ACTIVE_KEY, activeId);
    await store.save();
    return true;
  } catch (err) {
    console.warn("worldContexts persist failed", err);
    return false;
  }
}

/**
 * 保存を試み、失敗ならエラートーストを出す。**成功可否を返す**ので、呼び出し側は
 * 失敗時に「保存しました」の成功トーストを重ねないようにできる
 * (嘘の成功表示はデータ喪失に気づく機会を奪う)。
 */
async function persistOrToast(
  items: WorldContextEntry[],
  activeId: string | null,
): Promise<boolean> {
  const ok = await persist(items, activeId);
  if (!ok) {
    useToasts.getState().push({
      kind: "error",
      text: "「世界観 / コンテキスト」の保存に失敗しました。アプリを再起動すると元に戻ります。",
      ttlMs: 8000,
    });
  }
  return ok;
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `wc_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/** ファイル名から拡張子を落として表示名にする ("sekai.md" → "sekai")。 */
function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export const useWorldContexts = create<State>((set, get) => ({
  items: [],
  activeId: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    // 移行判定に settings.worldContext が要る。settings.load は冪等。
    await useSettings.getState().load();
    const store = await loadStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const raw = await store.get<WorldContextEntry[]>(ITEMS_KEY);

      // --- 移行: `items` キーが未作成のときだけ 1 回だけ走る ---
      if (raw === undefined) {
        const legacy = useSettings.getState().settings.worldContext ?? "";
        const now = Date.now();
        if (legacy.trim()) {
          const migrated: WorldContextEntry = {
            id: uid(),
            name: "既定のコンテキスト",
            content: legacy,
            createdAt: now,
            updatedAt: now,
          };
          // settings.worldContext は消さない・書き換えない (レガシー残置)。
          set({ items: [migrated], activeId: migrated.id, loaded: true });
          await persistOrToast([migrated], migrated.id);
        } else {
          // 空配列でもキーを書くことで、次回以降の移行判定を止める。
          set({ items: [], activeId: null, loaded: true });
          await persistOrToast([], null);
        }
        return;
      }

      // --- 通常ロード: 手編集で壊れた形を捨てる防御的正規化 ---
      const seen = new Set<string>();
      const items: WorldContextEntry[] = [];
      for (const e of Array.isArray(raw) ? raw : []) {
        if (!e || typeof e.id !== "string" || !e.id) continue;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        items.push({
          id: e.id,
          name: typeof e.name === "string" ? e.name : "",
          content: typeof e.content === "string" ? e.content : "",
          sourceFile: typeof e.sourceFile === "string" ? e.sourceFile : undefined,
          archived: !!e.archived,
          createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
          updatedAt:
            typeof e.updatedAt === "number"
              ? e.updatedAt
              : typeof e.createdAt === "number"
                ? e.createdAt
                : Date.now(),
        });
      }
      const storedActive = await store.get<string | null>(ACTIVE_KEY);
      // 存在しない / archived を指していたら「なし」に落とす。
      const activeId =
        typeof storedActive === "string" &&
        items.some((e) => e.id === storedActive && !e.archived)
          ? storedActive
          : null;
      set({ items, activeId, loaded: true });
    } catch (err) {
      console.warn("worldContexts load failed", err);
      set({ loaded: true });
    }
  },

  create: async (name) => {
    const now = Date.now();
    const entry: WorldContextEntry = {
      id: uid(),
      name,
      content: "",
      createdAt: now,
      updatedAt: now,
    };
    let nextItems: WorldContextEntry[] = [];
    // await をまたいで古い state を読まないよう、更新は set の中で組み立てる。
    set((s) => {
      nextItems = [...s.items, entry];
      return { items: nextItems, activeId: entry.id };
    });
    await persistOrToast(nextItems, entry.id);
    return entry;
  },

  update: async (id, patch) => {
    const now = Date.now();
    let nextItems: WorldContextEntry[] = [];
    let activeId: string | null = null;
    set((s) => {
      nextItems = s.items.map((e) =>
        e.id === id
          ? {
              ...e,
              name: patch.name ?? e.name,
              content: patch.content ?? e.content,
              updatedAt: now,
            }
          : e,
      );
      activeId = s.activeId;
      return { items: nextItems };
    });
    return await persistOrToast(nextItems, activeId);
  },

  importFromFile: async (fileName, content) => {
    const now = Date.now();
    const entry: WorldContextEntry = {
      id: uid(),
      name: stripExtension(fileName),
      content,
      sourceFile: fileName,
      createdAt: now,
      updatedAt: now,
    };
    let nextItems: WorldContextEntry[] = [];
    set((s) => {
      nextItems = [...s.items, entry];
      return { items: nextItems, activeId: entry.id };
    });
    const persisted = await persistOrToast(nextItems, entry.id);
    return { ...entry, persisted };
  },

  archive: async (id) => {
    const now = Date.now();
    let nextItems: WorldContextEntry[] = [];
    let nextActive: string | null = null;
    set((s) => {
      nextItems = s.items.map((e) =>
        e.id === id ? { ...e, archived: true, updatedAt: now } : e,
      );
      nextActive = s.activeId === id ? null : s.activeId;
      return { items: nextItems, activeId: nextActive };
    });
    return await persistOrToast(nextItems, nextActive);
  },

  setActive: async (id) => {
    let nextItems: WorldContextEntry[] = [];
    set((s) => {
      nextItems = s.items;
      return { activeId: id };
    });
    await persistOrToast(nextItems, id);
  },

  /** planChat の注入用。選択が無い / archived なら undefined。 */
  activeContent: () => {
    const { items, activeId } = get();
    if (!activeId) return undefined;
    const entry = items.find((e) => e.id === activeId && !e.archived);
    return entry?.content;
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.worldContexts = useWorldContexts;
}
