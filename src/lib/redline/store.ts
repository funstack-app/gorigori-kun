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
/** 解釈のタイムアウトタイマー。完了/失敗/reset で必ず解除する。 */
let interpretTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 実行トークン（単調増加）。interpret のたびに採番し、非同期継続（通知ハンドラ・
 * タイムアウト・送信 catch・リスナー登録待ち）は「自分のトークンが現在トークンと
 * 一致するときだけ状態を触る」。連打・reset・タイムアウト後の後着通知が古い実行の
 * 状態を復帰させる競合を塞ぐ（B-Medium 対策）。
 */
let interpretToken = 0;

/** 解釈完了までの上限。超過したら処理中を解除しエラー表示する。 */
const REDLINE_INTERPRET_TIMEOUT_MS = 120_000;

/**
 * 実行を無効化する（完了・失敗・reset・タイムアウト共通）。
 * トークンを進めて古い thread の非同期継続を全て無効化し、listener / timer を片付ける。
 */
function teardownInterpret(): void {
  interpretToken += 1;
  listenerHandle?.();
  listenerHandle = undefined;
  if (interpretTimer !== undefined) {
    clearTimeout(interpretTimer);
    interpretTimer = undefined;
  }
}

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
    // 連打防止(競合1): running 中の再実行は入口で早期 return。running=true を最初の
    // await より前に同期で立てるので、この check と set の間に別の呼び出しは割り込めない。
    if (get().running) return;
    const { originalPath, redlinePath } = get();
    if (!redlinePath) {
      set({ error: "赤入れ画像を選んでください。" });
      return;
    }

    // 直前までの実行を無効化してトークンを採番し、running=true を await より前に立てる。
    // 以降の全非同期継続は myToken の一致を確認してから状態を触る。
    teardownInterpret();
    const myToken = interpretToken;
    streamingText = "";
    set({ running: true, result: null, error: null });

    // 通知 listener を張り直す。threadId で自分の thread、myToken で自分の実行だけ拾う。
    let handle: () => void;
    try {
      handle = await onNotification((n: RpcNotification) => {
        // 登録待ちの間に reset/連打でトークンが進んでいたら、この listener は古い実行の
        // ものなので無視する（登録直後に自分自身を解除もする）。
        if (interpretToken !== myToken) return;

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
            teardownInterpret();
            set({ running: false, error: err });
            useToasts.getState().push({ kind: "error", text: err, ttlMs: 6000 });
            return;
          }
          const parsed = parseRedlineResult(streamingText);
          if (!parsed) {
            // no-silent-gap-filling: 構造化に失敗したら推測で埋めず、失敗として提示。
            const msg =
              "赤入れを構造化できませんでした。画像が鮮明か、赤入れがはっきり写っているかを確認して、もう一度お試しください。";
            teardownInterpret();
            set({ running: false, error: msg });
            useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
            return;
          }
          teardownInterpret();
          set({ running: false, result: parsed, error: null });
        }
      });
    } catch {
      if (interpretToken !== myToken) return;
      teardownInterpret();
      const msg = "通知の準備に失敗しました。もう一度お試しください。";
      set({ running: false, error: msg });
      useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
      return;
    }

    // 登録待ち中(競合2)に reset/連打でトークンが進んでいたら、遅れて登録された listener を
    // 即解除して捨てる。running へ復帰させない。
    if (interpretToken !== myToken) {
      handle();
      return;
    }
    listenerHandle = handle;

    // 完了通知が来ない場合の保険。超過したら処理中を解除しエラー表示する。
    interpretTimer = setTimeout(() => {
      if (interpretToken !== myToken) return;
      // タイムアウト(競合3): 同じ thread を再利用すると、遅れて届いた前回結果を次の
      // interpret が拾い得る。thread を破棄して次回は必ず新しい thread を開始させる。
      teardownInterpret();
      threadId = undefined;
      const msg =
        "赤入れの解釈がタイムアウトしました（120秒）。もう一度お試しください。";
      set({ running: false, error: msg });
      useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
    }, REDLINE_INTERPRET_TIMEOUT_MS);

    try {
      const tid = await ensureThread();
      // ensureThread の await 中に reset/連打/タイムアウトが起きていたら、この実行は
      // 既に無効。thread を使い回して turn を投げない（古い実行の復帰を防ぐ）。
      if (interpretToken !== myToken) return;
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
      // 送信自体に失敗＝完了通知は来ない。ただし既に別実行へ切り替わっていたら触らない。
      if (interpretToken !== myToken) return;
      teardownInterpret();
      const msg = `送信に失敗しました: ${(err as Error)?.message ?? err}`;
      set({ running: false, error: msg });
      useToasts.getState().push({ kind: "error", text: msg, ttlMs: 6000 });
    }
  },

  reset: () => {
    // 購読と保険タイマーを解除してから状態を初期化する（残留 listener 防止）。
    teardownInterpret();
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
