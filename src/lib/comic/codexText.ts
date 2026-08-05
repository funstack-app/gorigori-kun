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
 *
 * 9qm (2026-08-04): 打ち切りの理由を2種類に分ける。
 *   - "idle"  … 一定時間まったく応答が来ない（＝本当に詰まっている）
 *   - "total" … 応答は来ているが総時間の上限に達した
 * 文言を変えるのは「無言で固まった」と「長考の末に上限へ当たった」で
 * ユーザーの次の行動が違うため（前者は再実行、後者は分量を減らす）。
 */
export class ComicTextTurnTimeoutError extends Error {
  readonly reason: "idle" | "total";

  constructor(label: ComicTextTurnLabel, reason: "idle" | "total" = "idle") {
    const subject = label === "構成" ? "構成" : "ネーム";
    super(
      reason === "total"
        ? `${subject}の生成が長すぎるため打ち切りました。ページ数やコマ数を減らしてお試しください。`
        : `${subject}の生成がタイムアウトしました。もう一度お試しください。`,
    );
    this.name = "ComicTextTurnTimeoutError";
    this.reason = reason;
  }
}

/** 無応答と判定するまでの既定時間。これを超えて「1文字も来ない」と打ち切る。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * 進行状況の通知。呼び出し側は「待たされている実態」をそのまま UI に出す。
 *
 * - `phase: "waiting"` … turn を送ったがまだ1文字も返ってきていない
 * - `phase: "streaming"` … 本文が流れている（`receivedChars` が増えていく）
 */
export type ComicTextTurnProgress = {
  phase: "waiting" | "streaming";
  receivedChars: number;
};

export type RunComicTextTurnOptions = {
  /**
   * 無応答タイムアウト（既定 90 秒）。**受信があるたびにリセットされる**。
   * 「考えている間は待つ / 黙り込んだら切る」を分けるのがこの値の役割。
   */
  idleTimeoutMs?: number;
  /**
   * 総時間の上限（省略時は無制限）。受信が続いていても、この時間で打ち切る。
   * 暴走した turn がいつまでも UI を占有するのを防ぐ最後の天井。
   */
  totalTimeoutMs?: number;
  /** エラー文言に使う工程名（既定「ネーム」）。 */
  label?: ComicTextTurnLabel;
  /** 進行状況のコールバック。UI の正直な待ち表示に使う。 */
  onProgress?: (progress: ComicTextTurnProgress) => void;
};

/**
 * 1ターンだけ codex にテキストを送り、assistant の応答テキスト全文を返す。
 *
 * 9qm (2026-08-04): 打ち切り方式を「送信からの総時間」から
 * **「無応答時間（受信のたびにリセット）＋総時間の天井」**へ変えた。
 *
 * なぜ: 旧実装は 300 秒の一発タイマーで、データが流れていても容赦なく切れた。
 * 長い構成 JSON（20ページ×最大8コマ）は素直に 5 分を超えることがあり、
 * 「あと少しで完成」の turn を毎回捨てていた。一方で本当に詰まった場合
 * （app-server 落ち・上流無応答）は 5 分間まったく無音のまま待たされる。
 * 無応答で切り、受信中は延ばすと、この2つを正しく別扱いできる。
 *
 * 自動リトライはしない（ユーザーの明示再実行のみ）。
 *
 * @param prompt 送信するプロンプト本文
 * @param options 数値を渡した場合は後方互換のため無応答タイムアウトとして扱う
 * @param labelArg 第2引数が数値のときのみ使う工程名（旧シグネチャ互換）
 */
export async function runComicTextTurn(
  prompt: string,
  options: RunComicTextTurnOptions | number = {},
  labelArg?: ComicTextTurnLabel,
): Promise<string> {
  const opts: RunComicTextTurnOptions =
    typeof options === "number"
      ? { idleTimeoutMs: options, label: labelArg }
      : options;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs;
  const label: ComicTextTurnLabel = opts.label ?? "ネーム";
  const onProgress = opts.onProgress;
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
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      unlisten?.();
      fn();
    };

    /**
     * 無応答タイマーを張り直す。**この関数だけがタイマーを設置する**。
     * 「受信のたびに呼ぶ」以外の使い方をしないことで、
     * 「無応答では切れる / 受信中は切れない」の不変条件を1箇所に閉じる。
     */
    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(() => reject(new ComicTextTurnTimeoutError(label, "idle")));
      }, idleTimeoutMs);
    };

    /** 何らかの受信があった。無応答タイマーをリセットし、進捗を通知する。 */
    const noteActivity = () => {
      if (settled) return;
      armIdleTimer();
      const phase: ComicTextTurnProgress["phase"] =
        buffer.length > 0 ? "streaming" : "waiting";
      onProgress?.({ phase, receivedChars: buffer.length });
    };

    armIdleTimer();
    if (totalTimeoutMs !== undefined) {
      totalTimer = setTimeout(() => {
        // 総時間の天井。受信が続いていても打ち切る（暴走 turn の最後の壁）。
        //
        // 理由は**常に "total"**。ここへ到達したという事実そのものが
        // 「無応答ではなかった」の証明になる（無応答なら先に idle タイマーが
        // 切っている。idle < total は呼び出し側の前提）。
        // 本文の有無で分けていた頃は、推論通知だけが流れ続けた turn が
        // 総時間で切れたのに「タイムアウトしました。もう一度お試しください」と
        // 再実行を促す誤案内になっていた（Sol 指摘 2026-08-04）。
        finish(() => reject(new ComicTextTurnTimeoutError(label, "total")));
      }, totalTimeoutMs);
    }

    const handleNotification = (n: RpcNotification) => {
      const params = n.params as any;
      const tid = params?.threadId ?? params?.thread?.id;
      // このスレッド以外の通知（他の生成スレッド）は無視する。
      // ここで return するのが重要: 他スレッドの賑わいで自分の無応答タイマーを
      // リセットすると、「自分は無言なのに切れない」状態になる。
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
        return;
      }

      // 自スレッドの通知が届いた＝上流は生きている。無応答タイマーを張り直す。
      // turn/completed は上で return 済み（既に settled なので張り直さない）。
      noteActivity();
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
