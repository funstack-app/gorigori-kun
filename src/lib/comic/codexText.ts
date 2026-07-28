/**
 * 漫画制作スキル用の「一発テキスト生成」ヘルパー。
 *
 * 既存の企画チャット（planChat.ts）は会話ストアで、ネーム生成のような
 * 「1リクエスト → 1レスポンス（JSON）」用途には重い。ここでは同じ codex
 * app-server 経路（thread/start → turn/start → 通知ストリーム）を使いつつ、
 * assistant の agentMessage を集めて turn/completed で resolve する薄い関数だけを提供する。
 *
 * 経路は planChat.ts と同一（rpcRequest + onNotification）。画像生成はしないので
 * approvalPolicy=never / sandbox=read-only の最弱権限で起動する。
 */

import { onNotification, rpcRequest, type RpcNotification } from "../ipc";
import type {
  InputItem,
  ThreadStartParams,
  ThreadStartResult,
} from "../codex-types";

/** ネーム生成に使うモデル（planChat と同じ Sol）。 */
const COMIC_MODEL = "gpt-5.6-sol";

function extractTextDelta(params: any): string | undefined {
  if (typeof params?.delta === "string") return params.delta;
  if (typeof params?.textDelta === "string") return params.textDelta;
  return undefined;
}

/**
 * この関数を呼んでいる工程の名前。エラー文言に使う。
 *
 * 固定文言だと、構成生成のタイムアウトで
 * 「構成の生成に失敗しました: ネーム生成がタイムアウトしました」という
 * 混成トーストになる（2026-07-28 修正）。呼び出し側がラベルを渡す。
 */
export type ComicTextTurnLabel = "ネーム" | "構成";

/**
 * タイムアウト専用のエラー。
 *
 * 呼び出し側は「〜に失敗しました: {message}」でくるまず、message をそのまま
 * 出す（くるむと「構成の生成に失敗しました: 構成の生成がタイムアウトしました」と
 * 二重になる）。判別を instanceof でできるようにクラスで分ける。
 */
export class ComicTextTurnTimeoutError extends Error {
  constructor(label: ComicTextTurnLabel) {
    super(
      label === "構成"
        ? "構成の生成がタイムアウトしました。もう一度お試しください。"
        : "ネームの生成がタイムアウトしました。もう一度お試しください。",
    );
    this.name = "ComicTextTurnTimeoutError";
  }
}

/**
 * 1ターンだけ codex にテキストを送り、assistant の応答テキスト全文を返す。
 *
 * @param prompt 送信するプロンプト本文
 * @param timeoutMs タイムアウト（既定 90 秒）。超過時は reject
 * @param label エラー文言に使う工程名（既定「ネーム」）
 */
export async function runComicTextTurn(
  prompt: string,
  timeoutMs = 90_000,
  label: ComicTextTurnLabel = "ネーム",
): Promise<string> {
  const startParams: ThreadStartParams = {
    model: COMIC_MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
    personality: "pragmatic",
  };
  const started = await rpcRequest<ThreadStartResult>("thread/start", startParams);
  const threadId = started.thread.id;

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let unlisten: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new ComicTextTurnTimeoutError(label)));
    }, timeoutMs);

    const handleNotification = (n: RpcNotification) => {
      const params = n.params as any;
      const tid = params?.threadId ?? params?.thread?.id;
      // このスレッド以外の通知（他の生成スレッド）は無視する
      if (tid !== threadId) return;

      if (n.method === "item/started") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          buffer = item.text;
        }
      } else if (n.method === "item/agentMessage/delta") {
        const delta = extractTextDelta(params);
        if (delta !== undefined) buffer += delta;
      } else if (n.method === "item/completed") {
        const item = params?.item;
        if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) {
          buffer = item.text;
        }
      } else if (n.method === "turn/completed") {
        const status = params?.turn?.status;
        if (status === "failed") {
          const msg = params?.turn?.error?.message ?? `${label}生成でエラーが発生しました`;
          finish(() => reject(new Error(msg)));
        } else {
          finish(() => resolve(buffer));
        }
      }
    };

    void (async () => {
      try {
        const handle = await onNotification(handleNotification);
        if (settled) {
          handle();
          return;
        }
        unlisten = handle;
      } catch {
        finish(() =>
          reject(new Error("通知の準備に失敗しました。もう一度お試しください。")),
        );
        return;
      }

      const input: InputItem[] = [{ type: "text", text: prompt }];
      try {
        await rpcRequest("turn/start", { threadId, input, model: COMIC_MODEL });
      } catch (err) {
        finish(() => reject(err as Error));
      }
    })();
  });
}
