import { create } from "zustand";
import { sessions as sessionsIpc } from "../ipc";
import type {
  Session,
  TurnRow,
  ImageRow,
  TurnWithImages,
  SessionFull,
  TurnRecordArgs,
  ImageRecordArgs,
} from "../ipc";

export type { Session, TurnRow, ImageRow, TurnWithImages, SessionFull };

type SessionsState = {
  /** All sessions, sorted newest first by lastUsedAt. */
  sessions: Session[];
  /** Currently active session id (used for new turns). */
  activeSessionId?: string;
  /** Full data for the currently displayed session (may differ from active). */
  displayedSession?: SessionFull;
  /** Whether we're showing historical (frozen) data. */
  isFrozen: boolean;
  loading: boolean;

  /**
   * Map from codex turnId (used by the threads store) to db turn id.
   * Used by the image watcher bridge to call recordImage.
   */
  codexTurnToDbTurn: Map<string, string>;

  /**
   * Map from batch id (Rust-side) to db turn id, plus a queue of
   * locally-known temp ids waiting for the next `started` event so we
   * can rebind. The single global onImageBatch listener in App.tsx
   * consults this map to record images as workers complete.
   */
  batchToDbTurn: Map<string, string>;
  /** Queue of pending dbTurnIds awaiting a `started` event for binding. */
  pendingBatchDbTurnIds: string[];

  // ── actions ──
  load: () => Promise<void>;
  createNew: (title?: string) => Promise<Session>;
  switchTo: (id: string) => Promise<void>;
  /** Switch back to live mode (no frozen history display). */
  switchToLive: () => void;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportZip: (id: string) => Promise<void>;
  recordTurn: (args: TurnRecordArgs) => Promise<string>;
  recordImage: (args: ImageRecordArgs) => Promise<void>;
  /** Register the mapping codexTurnId → dbTurnId for image attribution. */
  bindCodexTurn: (codexTurnId: string, dbTurnId: string) => void;
  unbindCodexTurn: (codexTurnId: string) => void;
  /** Queue a dbTurnId waiting for the next batch `started` event. */
  enqueueBatchDbTurnId: (dbTurnId: string) => void;
  /** Bind a real batchId to the next queued dbTurnId (called on `started`). */
  bindBatch: (batchId: string) => void;
  /** Clear bookkeeping for a batch when `completed` arrives. */
  unbindBatch: (batchId: string) => void;
  /** Lookup the dbTurnId for a given batchId (returns "" if missing). */
  getBatchDbTurnId: (batchId: string) => string;
};

// Module-scoped lock: shared across simultaneous `recordTurn` callers
// so they don't race to create duplicate sessions.
let pendingCreatePromise: Promise<string> | undefined;

async function ensureActiveSession(): Promise<string> {
  const existing = useSessions.getState().activeSessionId;
  if (existing) return existing;
  if (pendingCreatePromise) return pendingCreatePromise;
  pendingCreatePromise = (async () => {
    try {
      const created = await sessionsIpc.create();
      useSessions.setState((state) => ({
        sessions: [created, ...state.sessions],
        activeSessionId: created.id,
      }));
      return created.id;
    } catch (err) {
      console.warn("auto-create session failed", err);
      return "";
    } finally {
      pendingCreatePromise = undefined;
    }
  })();
  return pendingCreatePromise;
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  isFrozen: false,
  loading: false,
  codexTurnToDbTurn: new Map(),
  batchToDbTurn: new Map(),
  pendingBatchDbTurnIds: [],

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      // The Rust setup hook initializes the SQLite pool synchronously
      // at app start, so `sessions_list` / `session_create` are ready
      // by the time React mounts. No frontend-side DB.load needed.
      const raw = await sessionsIpc.list().catch((err) => {
        console.error("sessions_list failed", err);
        return null;
      });
      let list: Session[] = Array.isArray(raw) ? raw : [];
      // Defense in depth: Rust already returns DESC by last_used_at,
      // but pinning the sort here means a bug in either side won't
      // flip the visible order in the sidebar.
      list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      if (list.length === 0) {
        // Pass undefined so Rust generates the default
        // 「新規セッション:<8-char-id-prefix>」 — distinguishable in
        // the sidebar without manual rename.
        const s = await sessionsIpc.create().catch((err) => {
          console.error("session_create failed", err);
          return null;
        });
        if (s && typeof s === "object" && s.id) list = [s];
      }
      const activeSessionId = list[0]?.id;
      set({ sessions: list, activeSessionId, loading: false });
    } catch (err) {
      console.error("sessions.load failed", err);
      const { useToasts } = await import("./toasts");
      // 誤診防止 (2026-07-30): React の "Maximum update depth" はグローバル
      // カウンタ制で、他コンポーネントの更新ストーム由来の throw をここの set()
      // が拾うことがある。セッションDBの故障と誤認させない文言に分岐する。
      // 元スタックは直上の console.error が保存している。
      // 本番ビルドでは React エラーは "Minified React error #185" に短縮され
      // "Maximum update depth" を含まないため、エラー番号 (errors/185) も見る。
      const errText = String(err);
      const isUpdateDepth =
        errText.includes("Maximum update depth") || errText.includes("errors/185");
      useToasts.getState().push({
        kind: "error",
        text: isUpdateDepth
          ? "画面の再描画ループを検出しました(セッションのデータは無事です)。表示が乱れる場合はアプリを再起動してください。"
          : `セッション読み込みに失敗: ${String(err)}`,
        ttlMs: 8000,
      });
      set({ loading: false });
    }
  },

  createNew: async (title?: string) => {
    // Pass undefined to let Rust generate the hash-suffixed default.
    const s = await sessionsIpc.create(title);
    // Clear the codex thread + chat state so the new session starts
    // empty. Otherwise the previous session's turns keep showing in
    // the chat (the user reported that as 「過去のトークが映ってきもい」)
    // because the codex thread itself is process-scoped, not per-app
    // -session. Dynamic import avoids the threads ↔ sessions cycle.
    const { useThreads } = await import("./threads");
    useThreads.getState().resetThread();
    set((state) => ({
      sessions: [s, ...state.sessions],
      activeSessionId: s.id,
      isFrozen: false,
      displayedSession: undefined,
    }));
    return s;
  },

  switchTo: async (id: string) => {
    // Check if switching to the active live session
    const { activeSessionId } = get();
    if (id === activeSessionId) {
      set({ isFrozen: false, displayedSession: undefined });
      return;
    }
    try {
      const full = await sessionsIpc.getFull(id);
      set({ displayedSession: full, isFrozen: true });
    } catch (err) {
      console.warn("session_get_full failed", err);
      // 件1修正 (2026-07-30): 失敗が console.warn だけだと「開くを押しても
      // 何も起きない」ように見える。1行で伝える (dynamic import は load() の
      // 既存パターン sessions.ts:130 と同じ。threads との循環 import 回避)。
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: "チャット履歴を開けませんでした。もう一度お試しください。",
        ttlMs: 5000,
      });
    }
  },

  switchToLive: () => {
    set({ isFrozen: false, displayedSession: undefined });
  },

  rename: async (id, title) => {
    await sessionsIpc.rename(id, title);
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
      displayedSession:
        state.displayedSession?.session.id === id
          ? {
              ...state.displayedSession,
              session: { ...state.displayedSession.session, title },
            }
          : state.displayedSession,
    }));
  },

  remove: async (id) => {
    await sessionsIpc.delete(id);
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      let activeSessionId = state.activeSessionId;
      let displayedSession = state.displayedSession;
      let isFrozen = state.isFrozen;

      if (activeSessionId === id) {
        activeSessionId = sessions[0]?.id;
        displayedSession = undefined;
        isFrozen = false;
      } else if (displayedSession?.session.id === id) {
        displayedSession = undefined;
        isFrozen = false;
      }
      return { sessions, activeSessionId, displayedSession, isFrozen };
    });
  },

  exportZip: async (id) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const session = get().sessions.find((s) => s.id === id);
      const suggestedName = `session-${session?.title ?? id}.zip`;
      const dest = await save({
        defaultPath: suggestedName,
        filters: [{ name: "ZIP アーカイブ", extensions: ["zip"] }],
      });
      if (typeof dest !== "string") return;
      await sessionsIpc.exportZip(id, dest);
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "success",
        text: `エクスポート完了: ${dest.split("/").pop()}`,
        ttlMs: 4000,
      });
    } catch (err) {
      console.error("exportZip failed", err);
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: `エクスポート失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    }
  },

  recordTurn: async (args) => {
    // Resolve sessionId — covers the boot race where the user may
    // submit before `load()` has finished. If we still have no
    // session at all, create one synchronously and adopt it as
    // active so subsequent turns also get attributed.
    //
    // Locking: two simultaneous recordTurn calls would each see
    // activeSessionId=undefined and each call sessionsIpc.create(),
    // ending up with two empty default-titled sessions and turns
    // split between them (audit finding #3). Cache the in-flight
    // create promise on the module so concurrent callers all await
    // the same one.
    let sessionId = args.sessionId || get().activeSessionId;
    if (!sessionId) {
      sessionId = await ensureActiveSession();
      if (!sessionId) return "";
    }
    try {
      const turn = await sessionsIpc.recordTurn({ ...args, sessionId });
      // Bump lastUsedAt and re-sort the sidebar so the active
      // session bubbles to the top right away.
      set((state) => {
        const updated = state.sessions.map((s) =>
          s.id === sessionId ? { ...s, lastUsedAt: turn.createdAt } : s,
        );
        updated.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        return { sessions: updated };
      });
      // Mirror the new turn into the prompt history sidebar so it
      // updates without waiting for a refetch.
      const { usePromptHistory } = await import("./promptHistory");
      usePromptHistory.getState().prepend({
        id: turn.id,
        prompt: turn.prompt,
        count: turn.count,
        kind: turn.kind as "app-server" | "batch",
        createdAt: turn.createdAt,
      });
      return turn.id;
    } catch (err) {
      console.warn("recordTurn failed (non-fatal)", err);
      return "";
    }
  },

  recordImage: async (args) => {
    try {
      await sessionsIpc.recordImage(args);
      // Surface the new image as a thumbnail next to its prompt in
      // the history sidebar (only the first one wins per turn).
      const { usePromptHistory } = await import("./promptHistory");
      usePromptHistory.getState().attachThumbToTurn(args.turnId, args.path);
    } catch (err) {
      console.warn("recordImage failed (non-fatal)", err);
    }
  },

  bindCodexTurn: (codexTurnId, dbTurnId) =>
    set((s) => {
      const next = new Map(s.codexTurnToDbTurn);
      next.set(codexTurnId, dbTurnId);
      return { codexTurnToDbTurn: next };
    }),

  unbindCodexTurn: (codexTurnId) =>
    set((s) => {
      const next = new Map(s.codexTurnToDbTurn);
      next.delete(codexTurnId);
      return { codexTurnToDbTurn: next };
    }),

  enqueueBatchDbTurnId: (dbTurnId) =>
    set((s) => ({
      pendingBatchDbTurnIds: [...s.pendingBatchDbTurnIds, dbTurnId],
    })),

  bindBatch: (batchId) =>
    set((s) => {
      const queue = s.pendingBatchDbTurnIds;
      if (queue.length === 0) return s;
      const [dbTurnId, ...rest] = queue;
      const next = new Map(s.batchToDbTurn);
      next.set(batchId, dbTurnId);
      return { batchToDbTurn: next, pendingBatchDbTurnIds: rest };
    }),

  unbindBatch: (batchId) =>
    set((s) => {
      const next = new Map(s.batchToDbTurn);
      next.delete(batchId);
      return { batchToDbTurn: next };
    }),

  getBatchDbTurnId: (batchId) => get().batchToDbTurn.get(batchId) ?? "",
}));

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.sessions = useSessions;
}
