import { create } from "zustand";

import { onNotification, rpcRequest, type RpcNotification } from "../ipc";
import type {
  InputItem,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";
import { useToasts } from "../store/toasts";
import { REDLINE_INTERPRET_PROMPT, parseRedlineResult } from "./prompts";
import type { RedlineResult } from "./types";

/**
 * 赤入れ反映スキルの状態。
 *
 * planChat と同じく、画像生成 thread とは別の独立した codex thread を起こして
 * 赤入れ画像を解釈させる（sandbox=read-only / approvalPolicy=never。画像生成しない）。
 * 通知 listener は threadId で振り分けるので画像生成 thread と混ざらない。
 */

const REDLINE_MODEL = "gpt-5.6-sol";

type RedlineState = {
  /** 元画像（修正前）のパス。任意（赤入れ画像だけでも解釈できる）。 */
  originalPath: string | null;
  /** 赤入れ画像（注釈入り）のパス。必須。 */
  redlinePath: string | null;
  /** 解釈中フラグ。 */
  running: boolean;
  /** 解釈結果（読む→指す の出力）。 */
  result: RedlineResult | null;
  /** エラーメッセージ（解釈失敗時）。 */
  error: string | null;

  setOriginalPath: (path: string | null) => void;
  setRedlinePath: (path: string | null) => void;
  /** 元画像 + 赤入れ画像を AI に渡して解釈を実行する。 */
  interpret: () => Promise<void>;
  /** 入力・結果をすべて初期化する。 */
  reset: () => void;
};

let threadId: string | undefined;
let listenerHandle: undefined | (() => void);
let threadStartPromise: Promise<string> | undefined;
/** 現在解釈中の thread が積み上げているストリーミング本文。 */
let streamingText = "";

async function ensureThread(): Promise<string> {
  if (threadId) return threadId;
  if (threadStartPromise) return threadStartPromise;
  threadStartPromise = (async () => {
    const params: ThreadStartParams = {
      model: REDLINE_MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
      personality: "pragmatic",
    };
    const r = await rpcRequest<ThreadStartResult>("thread/start", params);
    threadId = r.thread.id;
    return r.thread.id;
  })();
  try {
    return await threadStartPromise;
  } finally {
    threadStartPromise = undefined;
  }
}

export const useRedline = create<RedlineState>((set, get) => ({
  originalPath: null,
  redlinePath: null,
  running: false,
  result: null,
  error: null,

  setOriginalPath: (originalPath) => set({ originalPath }),
  setRedlinePath: (redlinePath) => set({ redlinePath }),

  interpret: async () => {
    if (get().running) return;
    const { originalPath, redlinePath } = get();
    if (!redlinePath) {
      set({ error: "赤入れ画像を選んでください。" });
      return;
    }

    // 通知 listener を（冪等に）張り直す。threadId で自分の thread だけ拾う。
    listenerHandle?.();
    streamingText = "";
    listenerHandle = await onNotification((n: RpcNotification) => {
      const params = n.params as any;
      const tid = params?.threadId ?? params?.thread?.id;
      if (!threadId || tid !== threadId) return;

      if (n.method === "item/agentMessage/delta") {
        const delta =
          typeof params?.delta === "string"
            ? params.delta
            : typeof params?.textDelta === "string"
              ? params.textDelta
              : undefined;
        if (delta) streamingText += delta;
      } else if (n.method === "item/completed") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) {
          // 完了 item の全文があればストリーミング蓄積より優先する。
          streamingText = item.text;
        }
      } else if (n.method === "turn/completed") {
        const status = params?.turn?.status;
        if (status === "failed") {
          const err =
            params?.turn?.error?.message ?? "赤入れの解釈でエラーが発生しました";
          set({ running: false, error: err });
          useToasts.getState().push({ kind: "error", text: err, ttlMs: 6000 });
          return;
        }
        const parsed = parseRedlineResult(streamingText);
        if (!parsed) {
          // no-silent-gap-filling: 構造化に失敗したら推測で埋めず、失敗として提示。
          const msg =
            "赤入れを構造化できませんでした。画像が鮮明か、赤入れがはっきり写っているかを確認して、もう一度お試しください。";
          set({ running: false, error: msg });
          useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
          return;
        }
        set({ running: false, result: parsed, error: null });
      }
    });

    set({ running: true, result: null, error: null });
    try {
      const tid = await ensureThread();
      // 1 枚目 = 元画像（あれば）、2 枚目 = 赤入れ画像。プロンプトはこの順を前提。
      const imagePaths = [originalPath, redlinePath].filter(
        (p): p is string => Boolean(p),
      );
      const input: InputItem[] = [
        { type: "text", text: REDLINE_INTERPRET_PROMPT },
        ...imagePaths.map((path) => ({ type: "localImage" as const, path })),
      ];
      await rpcRequest("turn/start", { threadId: tid, input, model: REDLINE_MODEL });
      // running=false は turn/completed 通知で下ろす。
    } catch (err) {
      const msg = `送信に失敗しました: ${(err as Error)?.message ?? err}`;
      set({ running: false, error: msg });
      useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
    }
  },

  reset: () => {
    // thread は会話内容と一対なので破棄して次回作り直す。
    threadId = undefined;
    streamingText = "";
    set({
      originalPath: null,
      redlinePath: null,
      running: false,
      result: null,
      error: null,
    });
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.redline = useRedline;
}
