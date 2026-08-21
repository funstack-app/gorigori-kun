/** フィルム脚本専用の「1リクエスト → 1テキスト応答」経路。 */
import { onNotification, rpcRequest, type RpcNotification } from "../ipc";
import type {
  InputItem,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";

const FILM_MODEL = "gpt-5.6-sol";

export type FilmTextTurnLabel =
  | "ログライン"
  | "ビートシート"
  | "トリートメント"
  | "シーンリスト"
  | "ブロック脚本";

export type FilmTextTurnProgress = {
  phase: "waiting" | "streaming" | "stalled";
  receivedChars: number;
  idleMs?: number;
};

export type RunFilmTextTurnOptions = {
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  label: FilmTextTurnLabel;
  onProgress?: (progress: FilmTextTurnProgress) => void;
  signal?: AbortSignal;
};

export const DEFAULT_FILM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_FILM_TOTAL_TIMEOUT_MS = 30 * 60_000;

export class FilmTextTurnTimeoutError extends Error {
  readonly reason: "idle" | "total";

  constructor(label: FilmTextTurnLabel, reason: "idle" | "total") {
    super(
      reason === "total"
        ? `${label}の生成が長すぎるため打ち切りました。内容を短くしてお試しください。`
        : `${label}の生成がタイムアウトしました。もう一度お試しください。`,
    );
    this.name = "FilmTextTurnTimeoutError";
    this.reason = reason;
  }
}

export class FilmTextTurnAbortedError extends Error {
  constructor(label: FilmTextTurnLabel) {
    super(`${label}の生成を中止しました。`);
    this.name = "FilmTextTurnAbortedError";
  }
}

function extractTextDelta(params: any): string | undefined {
  if (typeof params?.delta === "string") return params.delta;
  if (typeof params?.textDelta === "string") return params.textDelta;
  return undefined;
}

/**
 * comic の 9qm 契約と同じく、未受信だけを idle で打ち切る。
 * 一度でも活動を観測した後は stalled を通知して待ち、最後の壁だけ30分に置く。
 */
export async function runFilmTextTurn(
  prompt: string,
  options: RunFilmTextTurnOptions,
): Promise<string> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_FILM_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_FILM_TOTAL_TIMEOUT_MS;
  const { label, onProgress, signal } = options;
  if (signal?.aborted) throw new FilmTextTurnAbortedError(label);

  const startParams: ThreadStartParams = {
    model: FILM_MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
    personality: "pragmatic",
  };
  const started = await rpcRequest<ThreadStartResult>("thread/start", startParams);
  const threadId = started.thread.id;

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let sawActivity = false;
    let turnId: string | undefined;
    let unlisten: (() => void) | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const interruptServerTurn = () => {
      if (turnId === undefined) return;
      void rpcRequest("turn/interrupt", { threadId, turnId }).catch((error) => {
        console.warn("turn/interrupt failed", error);
      });
    };

    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      unlisten?.();
      done();
    };

    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      const armedAt = Date.now();
      idleTimer = setTimeout(function onIdle() {
        if (settled) return;
        if (!sawActivity) {
          finish(() => reject(new FilmTextTurnTimeoutError(label, "idle")));
          return;
        }
        onProgress?.({
          phase: "stalled",
          receivedChars: buffer.length,
          idleMs: Date.now() - armedAt,
        });
        idleTimer = setTimeout(onIdle, idleTimeoutMs);
      }, idleTimeoutMs);
    };

    const noteActivity = () => {
      if (settled) return;
      sawActivity = true;
      armIdleTimer();
      onProgress?.({
        phase: buffer.length > 0 ? "streaming" : "waiting",
        receivedChars: buffer.length,
      });
    };

    if (signal) {
      onAbort = () => {
        interruptServerTurn();
        finish(() => reject(new FilmTextTurnAbortedError(label)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    armIdleTimer();
    totalTimer = setTimeout(() => {
      interruptServerTurn();
      finish(() => reject(new FilmTextTurnTimeoutError(label, "total")));
    }, totalTimeoutMs);

    const handleNotification = (notification: RpcNotification) => {
      const params = notification.params as any;
      const notificationThreadId = params?.threadId ?? params?.thread?.id;

      // threadId が無い推論通知は生存だけ数え、本文には混ぜない。
      if (notificationThreadId === undefined) {
        noteActivity();
        return;
      }
      if (notificationThreadId !== threadId) return;

      if (notification.method === "turn/started") {
        const id = params?.turn?.id;
        if (typeof id === "string") turnId = id;
      } else if (notification.method === "item/started") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          buffer = item.text;
        }
      } else if (notification.method === "item/agentMessage/delta") {
        const delta = extractTextDelta(params);
        if (delta !== undefined) buffer += delta;
      } else if (notification.method === "item/completed") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string" && item.text) {
          buffer = item.text;
        }
      } else if (notification.method === "turn/completed") {
        if (params?.turn?.status === "failed") {
          const message = params?.turn?.error?.message ?? `${label}生成でエラーが発生しました`;
          finish(() => reject(new Error(message)));
        } else {
          finish(() => resolve(buffer));
        }
        return;
      }
      noteActivity();
    };

    void (async () => {
      try {
        const stopListening = await onNotification(handleNotification);
        if (settled) {
          stopListening();
          return;
        }
        unlisten = stopListening;
      } catch {
        finish(() =>
          reject(new Error("通知の準備に失敗しました。もう一度お試しください。")),
        );
        return;
      }

      const input: InputItem[] = [{ type: "text", text: prompt }];
      try {
        await rpcRequest("turn/start", { threadId, input, model: FILM_MODEL });
      } catch (error) {
        finish(() => reject(error as Error));
      }
    })();
  });
}
