import { create } from "zustand";
import { applyNotification } from "../codex-events";
import {
  onNotification,
  rpcRequest,
  type RpcNotification,
} from "../ipc";
import { useImages } from "./images";
import { useSessions } from "./sessions";
import { useSettings } from "./settings";
import { useToasts } from "./toasts";
import type {
  InputItem,
  Model,
  ModelList,
  Thread,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";

/** Curated list of models we surface in the picker (ordered: best → mini). */
const MODEL_WHITELIST = ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4"] as const;

/** A historical turn rendered as if completed. */
export type FrozenTurn = {
  id: string;
  /** The user's prompt text. */
  prompt: string;
  /** Image paths associated with this turn. */
  imagePaths: string[];
  createdAt: number;
};

type ThreadsState = {
  threadsById: Record<string, Thread>;
  activeThreadId?: string;
  models: Model[];
  selectedModel?: string;
  selectedEffort?: string;
  cwd?: string;
  attached: boolean;
  starting: boolean;
  sending: boolean;
  /**
   * Historical turns from a previously saved session.  When non-empty,
   * MessageList renders them before the live turns.
   */
  frozenTurns: FrozenTurn[];

  attachListeners: () => Promise<void>;
  ensureThread: (opts?: { model?: string; cwd?: string }) => Promise<string>;
  loadModels: () => Promise<void>;
  setSelectedModel: (id: string) => void;
  setSelectedEffort: (e: string | undefined) => void;
  setCwd: (cwd: string) => void;
  /** Send a turn and resolve with the codex turn id (or "" on timeout). */
  sendUserTurn: (input: InputItem[]) => Promise<string>;
  interruptActiveTurn: () => Promise<void>;
  setFrozenTurns: (turns: FrozenTurn[]) => void;
  clearFrozenTurns: () => void;
  /**
   * Drop the current codex thread + all in-memory turn state. The
   * next sendUserTurn() will call ensureThread() and start a fresh
   * codex thread under the hood. Used when the user creates a new
   * app session — the chat should clear, not carry over the previous
   * session's turns.
   */
  resetThread: () => void;
  /**
   * Internal: FIFO of resolvers awaiting the next turn/started event.
   * Slots are nulled (not removed) on timeout so a delayed turn/started
   * for an earlier submit cannot accidentally bind to a later submit's
   * resolver — the FIFO position is preserved either way.
   */
  pendingTurnIdResolvers: Array<((id: string) => void) | null>;
};

const PROJECT_DIR = "codex-frame-factory";

/**
 * Resolve the working directory codex will use for this thread.
 * This is the cwd codex hands to its sandboxed shell — anything image_gen
 * decides to write outside ~/.codex/generated_images/ ends up here, so we
 * pick a stable location the user can find.
 *
 * Resolution order:
 *   1. ~/Documents/gori-gori-kun/default   (most users)
 *   2. ~/gori-gori-kun                     (no Documents folder)
 * mkdir -p is best-effort; if everything fails we hand back the home dir
 * so codex still has something writable instead of erroring on thread/start.
 */
async function defaultCwd(): Promise<string> {
  const { homeDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
  const home = await homeDir();

  const candidates = [
    await join(home, "Documents", PROJECT_DIR, "default"),
    await join(home, PROJECT_DIR, "default"),
  ];
  for (const dir of candidates) {
    try {
      if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true });
      }
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return home;
}

function cloneThread(t: Thread): Thread {
  return {
    ...t,
    turns: t.turns.map((tn) => ({ ...tn, items: tn.items.map((i) => ({ ...i })) })),
  };
}

let listenerHandle: undefined | (() => void);
// In-flight thread bootstrap promise so concurrent senders share one start.
let threadStartPromise: Promise<string> | undefined;

export const useThreads = create<ThreadsState>((set, get) => ({
  threadsById: {},
  models: [],
  attached: false,
  starting: false,
  sending: false,
  frozenTurns: [],
  pendingTurnIdResolvers: [],

  attachListeners: async () => {
    if (get().attached) return;
    set({ attached: true });
    listenerHandle?.();
    listenerHandle = await onNotification((n: RpcNotification) => {
      const params = n.params as any;
      const before = get();
      const tid = params?.threadId ?? params?.thread?.id ?? before.activeThreadId;

      // Build a draft we own. Top-level map is fresh, and any thread we may
      // touch is deep-cloned so reducer mutations don't reach into prior
      // render snapshots that React still references.
      const draft = {
        threadsById: { ...before.threadsById },
        activeThreadId: before.activeThreadId,
      };
      if (typeof tid === "string" && draft.threadsById[tid]) {
        draft.threadsById[tid] = cloneThread(draft.threadsById[tid]);
      }

      const changed = applyNotification(draft, n.method, params);

      // Bind image_gen outputs to the turn that triggered them so the gallery
      // can show provenance. Stack-based: multiple in-flight turns won't
      // overwrite each other.
      if (n.method === "turn/started" && params?.turn?.id) {
        useImages.getState().pushActiveTurn(params.turn.id);
        // Hand the codex turnId back to the oldest *live* sendUserTurn()
        // caller waiting for it. Skip null slots (those are submits whose
        // 60s timeout already fired) so the FIFO discipline is preserved
        // — a slow turn/started for submit_A that arrives after submit_A's
        // timeout never accidentally binds to submit_B.
        const resolvers = get().pendingTurnIdResolvers;
        const idx = resolvers.findIndex((r) => r !== null);
        if (idx >= 0) {
          const next = resolvers[idx]!;
          set({
            pendingTurnIdResolvers: [
              ...resolvers.slice(0, idx),
              ...resolvers.slice(idx + 1),
            ],
          });
          next(params.turn.id);
        }
      } else if (n.method === "turn/completed" && params?.turn?.id) {
        useImages.getState().popActiveTurn(params.turn.id);
        // Drop the codex→db turn binding so historical sessions don't
        // accidentally adopt images from later (unrelated) turns. Done
        // here (not per-submit) so a single global listener handles it.
        useSessions.getState().unbindCodexTurn(params.turn.id);
        // Surface failures so the user knows why the chat went silent.
        const status = params.turn.status;
        if (status === "failed") {
          const err = params.turn.error?.message ?? "ターンが失敗しました";
          useToasts.getState().push({ kind: "error", text: err, ttlMs: 8000 });
        } else if (status === "interrupted") {
          useToasts
            .getState()
            .push({ kind: "warn", text: "ターンを中断しました", ttlMs: 3000 });
        }
      }
      if (n.method === "configWarning" && params?.summary) {
        useToasts
          .getState()
          .push({ kind: "warn", text: params.summary, ttlMs: 6000 });
      }

      if (!changed) return;
      set({
        threadsById: draft.threadsById,
        activeThreadId: draft.activeThreadId,
      });
    });
  },

  loadModels: async () => {
    try {
      const r = await rpcRequest<ModelList>("model/list", {
        limit: 50,
        includeHidden: false,
      });
      // Trim down to the whitelisted, image-capable models, preserving the
      // whitelist order so "best" comes first in the picker.
      const visible = r.data.filter((m) => !m.hidden);
      const byId = new Map(visible.map((m) => [m.model ?? m.id, m]));
      const filtered = MODEL_WHITELIST.map((id) => byId.get(id)).filter(
        (m): m is Model => Boolean(m),
      );
      const fallback =
        filtered.length > 0
          ? filtered
          : visible.filter((m) => m.inputModalities?.includes("image"));
      const def =
        fallback.find((m) => m.isDefault) ??
        fallback[0] ??
        visible[0];
      set({
        models: fallback,
        selectedModel: get().selectedModel ?? def?.model ?? def?.id,
        selectedEffort:
          get().selectedEffort ?? def?.defaultReasoningEffort ?? undefined,
      });
    } catch (err) {
      console.warn("model/list failed", err);
    }
  },

  setSelectedModel: (id: string) => {
    // When the model changes, snap effort to the new model's default if the
    // current value isn't supported (avoids sending bogus enum values).
    const model = get().models.find((m) => (m.model ?? m.id) === id);
    const supported = new Set(
      (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    );
    const current = get().selectedEffort;
    set({
      selectedModel: id,
      selectedEffort:
        current && supported.has(current)
          ? current
          : model?.defaultReasoningEffort,
    });
  },
  setSelectedEffort: (e) => set({ selectedEffort: e }),
  setCwd: (cwd: string) => set({ cwd }),

  ensureThread: async (opts) => {
    const existing = get().activeThreadId;
    if (existing) return existing;
    if (threadStartPromise) return threadStartPromise;

    threadStartPromise = (async () => {
      set({ starting: true });
      try {
        if (!get().models.length) await get().loadModels();
        const persisted = useSettings.getState().settings;
        const cwd = opts?.cwd ?? get().cwd ?? persisted.defaultCwd ?? (await defaultCwd());
        set({ cwd });
        const params: ThreadStartParams = {
          model: opts?.model ?? get().selectedModel ?? persisted.defaultModel,
          cwd,
          approvalPolicy: persisted.approvalPolicy ?? "on-request",
          sandbox: persisted.sandbox ?? "workspace-write",
        };
        const r = await rpcRequest<ThreadStartResult>("thread/start", params);
        set((s) => ({
          threadsById: {
            ...s.threadsById,
            [r.thread.id]: { id: r.thread.id, turns: [] },
          },
          activeThreadId: r.thread.id,
        }));
        return r.thread.id;
      } finally {
        set({ starting: false });
        threadStartPromise = undefined;
      }
    })();

    return threadStartPromise;
  },

  sendUserTurn: async (input: InputItem[]) => {
    if (input.length === 0) return "";
    const threadId = await get().ensureThread();
    const model = get().selectedModel;
    const effort = get().selectedEffort;
    set({ sending: true });

    // Stage a resolver BEFORE the RPC call so the turn/started
    // notification — which can fire before turn/start's response
    // returns — has a place to land. The slot stays in the array
    // even after timeout (just nulled) so FIFO position is preserved
    // across delayed turn/started events.
    let resolved = false;
    const turnIdPromise = new Promise<string>((resolve) => {
      const resolver = (id: string) => {
        if (resolved) return;
        resolved = true;
        resolve(id);
      };
      set((s) => ({
        pendingTurnIdResolvers: [...s.pendingTurnIdResolvers, resolver],
      }));
      setTimeout(() => {
        if (resolved) return;
        // Null this slot in place — don't shift the array — so that a
        // delayed turn/started for *this* submit doesn't pop a later
        // submit's resolver out of order.
        set((s) => ({
          pendingTurnIdResolvers: s.pendingTurnIdResolvers.map((r) =>
            r === resolver ? null : r,
          ),
        }));
        resolver("");
      }, 60_000);
    });

    try {
      await rpcRequest("turn/start", {
        threadId,
        input,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
    } finally {
      set({ sending: false });
    }
    return turnIdPromise;
  },

  interruptActiveTurn: async () => {
    const tid = get().activeThreadId;
    if (!tid) return;
    const thread = get().threadsById[tid];
    const last = [...(thread?.turns ?? [])]
      .reverse()
      .find((t) => t.status === "inProgress");
    if (!last) return;
    try {
      await rpcRequest("turn/interrupt", { threadId: tid, turnId: last.id });
    } catch (err) {
      console.warn("turn/interrupt failed", err);
    }
  },

  setFrozenTurns: (turns) => set({ frozenTurns: turns }),
  clearFrozenTurns: () => set({ frozenTurns: [] }),

  resetThread: () => {
    threadStartPromise = undefined;
    set((s) => {
      // Resolve any waiting sendUserTurn callers so they don't hang
      // forever, but resolve with an empty id — the binding step in
      // PromptComposer skips when the id is falsy. This stops a
      // stale resolver from a previous chat winning the FIFO slot
      // for the *next* turn (audit finding #17).
      for (const r of s.pendingTurnIdResolvers) r?.("");
      return {
        activeThreadId: undefined,
        threadsById: {},
        frozenTurns: [],
        pendingTurnIdResolvers: [],
        sending: false,
      };
    });
  },
}));

// Vite HMR: drop the old listener so it doesn't double up.
if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    listenerHandle?.();
    listenerHandle = undefined;
    threadStartPromise = undefined;
  });
}

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.threads = useThreads;
}
