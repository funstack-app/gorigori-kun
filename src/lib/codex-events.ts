import type { Item, Thread, Turn } from "./codex-types";

type State = {
  threadsById: Record<string, Thread>;
  activeThreadId?: string;
};

function ensureThread(s: State, threadId: string): Thread {
  if (!s.threadsById[threadId]) {
    s.threadsById[threadId] = { id: threadId, turns: [] };
  }
  return s.threadsById[threadId];
}

function findTurn(thread: Thread, turnId: string): Turn | undefined {
  return thread.turns.find((t) => t.id === turnId);
}

function findItem(thread: Thread, itemId: string): { turn: Turn; item: Item } | undefined {
  for (const turn of thread.turns) {
    const item = turn.items.find((i) => i.id === itemId);
    if (item) return { turn, item };
  }
  return undefined;
}

function appendString(prev: unknown, delta: unknown): string {
  const a = typeof prev === "string" ? prev : "";
  const b = typeof delta === "string" ? delta : "";
  return a + b;
}

/** Codex sometimes sends `delta`, sometimes the legacy `textDelta`. */
function extractTextDelta(params: any): string | undefined {
  return typeof params?.delta === "string"
    ? params.delta
    : typeof params?.textDelta === "string"
      ? params.textDelta
      : undefined;
}

function decodeBase64(input: unknown): string {
  if (typeof input !== "string") return "";
  try {
    return atob(input);
  } catch {
    return input;
  }
}

/**
 * Mutate `state` in-place based on a single notification. Returns true if the
 * state changed (worth re-rendering).
 */
export function applyNotification(
  state: State,
  method: string,
  params: any,
): boolean {
  switch (method) {
    case "thread/started": {
      const tid = params?.thread?.id ?? params?.threadId;
      if (typeof tid !== "string") return false;
      const t = ensureThread(state, tid);
      if (params?.thread?.name) t.name = params.thread.name;
      state.activeThreadId = tid;
      return true;
    }

    case "turn/started": {
      const tid = params?.threadId ?? state.activeThreadId;
      const turn = params?.turn;
      if (typeof tid !== "string" || !turn?.id) return false;
      const thread = ensureThread(state, tid);
      if (!findTurn(thread, turn.id)) {
        thread.turns.push({
          id: turn.id,
          status: turn.status === "completed" ? "completed" : "inProgress",
          items: [],
        });
      }
      return true;
    }

    case "turn/completed": {
      const tid = params?.threadId ?? state.activeThreadId;
      const turn = params?.turn;
      if (typeof tid !== "string" || !turn?.id) return false;
      const thread = ensureThread(state, tid);
      const t = findTurn(thread, turn.id);
      if (t) {
        t.status =
          turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "failed"
              ? "failed"
              : "completed";
      }
      return true;
    }

    case "item/started": {
      const tid = params?.threadId ?? state.activeThreadId;
      const turnId = params?.turnId;
      const item = params?.item;
      if (typeof tid !== "string" || !turnId || !item?.id) return false;
      const thread = ensureThread(state, tid);
      let turn = findTurn(thread, turnId);
      if (!turn) {
        turn = { id: turnId, status: "inProgress", items: [] };
        thread.turns.push(turn);
      }
      if (!turn.items.find((i) => i.id === item.id)) {
        turn.items.push({ ...item });
      }
      return true;
    }

    case "item/completed": {
      const tid = params?.threadId ?? state.activeThreadId;
      const item = params?.item;
      if (typeof tid !== "string" || !item?.id) return false;
      const thread = ensureThread(state, tid);
      const found = findItem(thread, item.id);
      if (found) {
        Object.assign(found.item, item);
      } else if (params.turnId) {
        const turn = findTurn(thread, params.turnId);
        if (turn) turn.items.push({ ...item });
      }
      return true;
    }

    case "item/agentMessage/delta": {
      const tid = params?.threadId ?? state.activeThreadId;
      const itemId = params?.itemId;
      const delta = extractTextDelta(params);
      if (typeof tid !== "string" || !itemId || delta === undefined) return false;
      const thread = state.threadsById[tid];
      if (!thread) return false;
      const found = findItem(thread, itemId);
      if (found) {
        (found.item as any).text = appendString((found.item as any).text, delta);
      }
      return true;
    }

    case "item/reasoning/delta":
    case "item/reasoning/textDelta": {
      const tid = params?.threadId ?? state.activeThreadId;
      const itemId = params?.itemId;
      const delta = extractTextDelta(params);
      if (typeof tid !== "string" || !itemId || delta === undefined) return false;
      const thread = state.threadsById[tid];
      if (!thread) return false;
      const found = findItem(thread, itemId);
      if (found) {
        (found.item as any).content = appendString((found.item as any).content, delta);
      }
      return true;
    }

    case "item/reasoning/summaryDelta":
    case "item/reasoning/summaryTextDelta": {
      const tid = params?.threadId ?? state.activeThreadId;
      const itemId = params?.itemId;
      const delta = extractTextDelta(params);
      if (typeof tid !== "string" || !itemId || delta === undefined) return false;
      const thread = state.threadsById[tid];
      if (!thread) return false;
      const found = findItem(thread, itemId);
      if (found) {
        (found.item as any).summary = appendString((found.item as any).summary, delta);
      }
      return true;
    }

    case "item/commandExecution/outputDelta": {
      const tid = params?.threadId ?? state.activeThreadId;
      const itemId = params?.itemId;
      const raw =
        typeof params?.outputDelta === "string"
          ? params.outputDelta
          : typeof params?.delta === "string"
            ? params.delta
            : undefined;
      if (typeof tid !== "string" || !itemId || raw === undefined) return false;
      const thread = state.threadsById[tid];
      if (!thread) return false;
      const found = findItem(thread, itemId);
      if (found) {
        const decoded = decodeBase64(raw);
        (found.item as any).output = appendString((found.item as any).output, decoded);
      }
      return true;
    }

    case "item/plan/delta": {
      const tid = params?.threadId ?? state.activeThreadId;
      const itemId = params?.itemId;
      const delta = extractTextDelta(params);
      if (typeof tid !== "string" || !itemId || delta === undefined) return false;
      const thread = state.threadsById[tid];
      if (!thread) return false;
      const found = findItem(thread, itemId);
      if (found) {
        (found.item as any).text = appendString((found.item as any).text, delta);
      }
      return true;
    }

    default:
      return false;
  }
}
