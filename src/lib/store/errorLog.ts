import { create } from "zustand";

/**
 * エラーログセンター。
 *
 * なぜ (STΛCK 要望 2026-07-28):
 *   認証失効などのエラートーストを見逃すと、後から原因を辿る手段が無かった。
 *   並列生成が増えて別タブ作業中にトーストが流れるケースも増えたため、
 *   「トーストは消えてもログは残る」場所を1つ用意する。
 *
 * 設計:
 *   - **エラーの一元集約点**。トースト (useToasts.push) が kind:"error" を
 *     発行したら自動でここへも積む。呼び出し側の書き換えは不要。
 *   - ディスク永続は plugin-store (appData 配下 `error-log.json`)。
 *     projects.json / prompts.json / favorites.json と同じ既存機構であり、
 *     fs スコープ (capabilities) の追加を必要としない。
 *   - **記録はアプリの付帯物**。書き込み・読み込みの失敗はアプリを止めず、
 *     console.warn だけ残す (savedPrompts の persist と同じ思想)。
 */

const STORE_FILE = "error-log.json";
const STORE_KEY = "entries";

/** 保持する上限。超えたぶんは古い順に捨てる。 */
export const ERROR_LOG_LIMIT = 200;

export type ErrorLogEntry = {
  id: string;
  /** 発生時刻 (epoch ms)。 */
  at: number;
  /** 発生元。アクティブタブ名 / スキル名 / 呼び出し元の指定。不明なら "app"。 */
  source: string;
  /** 1行の要約 (トースト本文と同じ文字列)。 */
  message: string;
  /** スタックトレース等の詳細。行クリックで展開する。 */
  detail?: string;
};

type ErrorLogState = {
  entries: ErrorLogEntry[];
  /** パネル未読件数。パネルを開くと 0 に戻る。 */
  unreadCount: number;
  /** 起動時のディスク読み込みが済んだか。 */
  loaded: boolean;
  /**
   * パネルの開閉。サイドバーのボタンと、常設マウントしたパネル本体は
   * 離れた場所にあるので、prop を引き回さず store で繋ぐ
   * (SnsExportModal / ImagePreviewModal と同じ store 駆動の単一マウント)。
   */
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  /** 1件記録する。返り値は付与した id。 */
  log: (input: { source?: string; message: string; detail?: string }) => string;
  /** ディスクから直近 ERROR_LOG_LIMIT 件を読み込む (起動時に1回)。 */
  load: () => Promise<void>;
  /** 未読を既読にする (パネルを開いたとき)。 */
  markRead: () => void;
  /** 全消去 (ディスクも空にする)。 */
  clear: () => Promise<void>;
};

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `e_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/**
 * plugin-store インスタンスは使い回す。毎回 import + load すると
 * 同時書き込みが競合する (savedPrompts と同じ理由)。
 */
let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null =
  null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    // ここで useToasts.push を呼ばないこと。
    // push(kind:"error") → log() → persist() → 失敗 → push(...) の
    // 無限ループになる。エラーログの失敗は console だけに出す。
    console.warn("[errorLog] ストアを開けませんでした", err);
    return null;
  });
  return storePromise;
}

/**
 * 追記後の全件を書き戻す (直近 ERROR_LOG_LIMIT 件のみ)。
 * best-effort: 失敗しても呼び出し元へは伝えない (console.warn のみ)。
 */
async function persist(entries: ErrorLogEntry[]): Promise<void> {
  const store = await loadStore();
  if (!store) return;
  try {
    await store.set(STORE_KEY, entries);
    await store.save();
  } catch (err) {
    // 同上。トーストを出すと無限ループになるので console のみ。
    console.warn("[errorLog] 保存に失敗しました", err);
  }
}

/** 読み込んだ生データを検証して ErrorLogEntry[] にする。壊れた要素は捨てる。 */
function sanitize(raw: unknown): ErrorLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ErrorLogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const message = typeof rec.message === "string" ? rec.message : null;
    if (!message) continue;
    const at = typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : Date.now();
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : uid(),
      at,
      source: typeof rec.source === "string" && rec.source ? rec.source : "app",
      message,
      detail: typeof rec.detail === "string" ? rec.detail : undefined,
    });
  }
  return out.slice(-ERROR_LOG_LIMIT);
}

export const useErrorLog = create<ErrorLogState>((set, get) => ({
  entries: [],
  unreadCount: 0,
  loaded: false,
  panelOpen: false,

  openPanel: () => set({ panelOpen: true, unreadCount: 0 }),
  closePanel: () => set({ panelOpen: false }),

  log: ({ source, message, detail }) => {
    const entry: ErrorLogEntry = {
      id: uid(),
      at: Date.now(),
      source: source && source.trim() ? source.trim() : "app",
      message,
      detail,
    };
    // 上限超過は古い順に破棄する (末尾が最新)。
    const entries = [...get().entries, entry].slice(-ERROR_LOG_LIMIT);
    set({ entries, unreadCount: get().unreadCount + 1 });
    void persist(entries);
    return entry.id;
  },

  load: async () => {
    if (get().loaded) return;
    const store = await loadStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const raw = await store.get(STORE_KEY);
      const restored = sanitize(raw);
      // 読み込み中に発生したエラー (log 呼び出し) を取りこぼさないため、
      // 復元分を「前」に置いて現在の entries と連結する。
      const merged = [...restored, ...get().entries].slice(-ERROR_LOG_LIMIT);
      // 復元分は既読扱い。未読は「今回の起動で出たエラー」だけを指す。
      set({ entries: merged, loaded: true });
    } catch (err) {
      console.warn("[errorLog] 読み込みに失敗しました", err);
      set({ loaded: true });
    }
  },

  markRead: () => set({ unreadCount: 0 }),

  clear: async () => {
    set({ entries: [], unreadCount: 0 });
    await persist([]);
  },
}));

/**
 * 明示 API。トースト経由でないエラー (backend イベント / 非UI経路) から直接呼ぶ。
 *
 * 例: logError("動画生成", "認証が失効しました", String(err))
 */
export function logError(source: string, message: string, detail?: string): string {
  return useErrorLog.getState().log({ source, message, detail });
}
