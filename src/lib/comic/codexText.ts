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

/**
 * ユーザーが「中止」を押したときのエラー。
 *
 * タイムアウトと区別するのは、UI の扱いが逆だから: タイムアウトは
 * 「失敗した」と伝えるべきだが、中止は**ユーザーが意図してやったこと**なので
 * 赤いエラーで責めない（コマ再生成の中止が既にこの流儀。ComicWorkspace の
 * 「中止は失敗ではない」参照）。
 */
export class ComicTextTurnAbortedError extends Error {
  constructor(label: ComicTextTurnLabel) {
    const subject = label === "構成" ? "構成" : "ネーム";
    super(`${subject}の生成を中止しました。`);
    this.name = "ComicTextTurnAbortedError";
  }
}

/** 無応答と判定するまでの既定時間。これを超えて「1文字も来ない」と打ち切る。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * 進行状況の通知。呼び出し側は「待たされている実態」をそのまま UI に出す。
 *
 * - `phase: "waiting"` … turn を送ったがまだ1文字も返ってきていない
 * - `phase: "streaming"` … 本文が流れている（`receivedChars` が増えていく）
 * - `phase: "stalled"` … 一度は動いていたが、そこから無応答が続いている
 *
 * `stalled` は**打ち切りの予告ではない**（活動観測後は自動で切らない）。
 * 「止まって見えるけど待つべきか、やめるべきか」をユーザーが判断するための
 * 材料として出す。`idleMs` は最後の受信からの経過時間。
 */
export type ComicTextTurnProgress = {
  phase: "waiting" | "streaming" | "stalled";
  receivedChars: number;
  /** 最後の受信からの経過ミリ秒（`stalled` のときだけ入る）。 */
  idleMs?: number;
};

export type RunComicTextTurnOptions = {
  /**
   * 無応答と見なすまでの時間（既定 90 秒）。**受信があるたびにリセットされる**。
   *
   * ⚠️ **この時間で打ち切るのは「一度も受信がないまま」超えたときだけ**。
   * 一度でも受信した turn は、無応答が続いても**自動では切らず** `phase: "stalled"`
   * として可視化する（下の runComicTextTurn 本体のコメント参照）。
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
  /**
   * ユーザーによる中止用のシグナル。abort すると
   * `ComicTextTurnAbortedError` で reject し、サーバー側の turn へも
   * `turn/interrupt` を best-effort で送る。
   */
  signal?: AbortSignal;
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
 * ## 実装契約M (2026-08-05): 活動観測後は自動で切らない
 *
 * STΛCK 実機FB「漫画の構成で時間かかるとタイムアウトみたいになるのやめて」。
 * 上の 9qm でも足りていなかった。受信が**途切れた**turn は idle で切れるが、
 * そこまでに書けていた本文はユーザーの成果物になり得るのに捨てていた。
 *
 * 規範: **ユーザーの成果物になり得るターンを、システムの都合で自動的に捨てない。**
 *
 * だから打ち切り条件を、活動を観測したかどうかで非対称にした:
 *
 * | 状況 | 挙動 | 理由 |
 * |---|---|---|
 * | 1文字も受信しないまま idleTimeoutMs 超過 | **切る**（reason=idle） | サーバー死・起動失敗の疑い。捨てるものが無い |
 * | 一度でも受信した後の無応答 | **切らない**。`phase: "stalled"` で可視化 | 成果物になり得る。やめる判断はユーザーがする |
 * | totalTimeoutMs 超過 | **切る**（reason=total） | 暴走の最後の壁。天井そのものは残す |
 * | signal の abort | **切る**（Aborted） | ユーザーの明示操作 |
 *
 * 「切らずに可視化する」ため、活動観測後の idle タイマーは**打ち切りでなく
 * 進捗通知**に化ける（`stalledTimer`）。切る側の唯一の自動天井は総時間になる。
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
  const signal = opts.signal;
  // turn を送る前に中止されていたら、サーバーを起こさずに抜ける。
  if (signal?.aborted) throw new ComicTextTurnAbortedError(label);
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
    /**
     * この turn で一度でも自スレッドの通知を受けたか。
     *
     * **これが打ち切り方針を切り替える唯一のスイッチ**（実装契約M）。
     * false のあいだだけ idle タイマーが「切る」働きをする。
     */
    let sawActivity = false;
    /**
     * サーバー側の turn ID（`turn/started` で届く）。
     * 中止・天井到達のときに `turn/interrupt` を送るのに要る。
     * 届く前に中止された場合は undefined のままで、interrupt は送れない。
     */
    let turnId: string | undefined;
    let onAbort: (() => void) | undefined;

    /**
     * サーバー側の turn を止めにいく (best-effort)。
     *
     * `turn/interrupt` は実在するメソッド（`src/lib/store/threads.ts` の
     * interruptActiveTurn と `src-tauri/src/codex/gen_server.rs` の
     * interrupt_and_confirm が同じ `{threadId, turnId}` で使っている）。
     * ここで送らないと、フロントが待つのをやめてもサーバー側の turn は
     * 走り残る（bd codex-frame-factory-ppw）。
     *
     * 送りっぱなしで完了確認はしない: 待つと中止の体感が遅れるうえ、
     * このヘルパーは1リクエスト1レスポンスの薄い経路で、gen_server のような
     * app-server 交代の仕組みを持たない。失敗しても UI 側の中止は成立させる。
     */
    const interruptServerTurn = () => {
      if (turnId === undefined) return;
      void rpcRequest("turn/interrupt", { threadId, turnId }).catch((err) => {
        console.warn("turn/interrupt failed", err);
      });
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      unlisten?.();
      fn();
    };

    /**
     * 無応答タイマーを張り直す。**この関数だけがタイマーを設置する**。
     * 「受信のたびに呼ぶ」以外の使い方をしないことで不変条件を1箇所に閉じる。
     *
     * 発火時の挙動は sawActivity で非対称に分かれる（実装契約M）:
     *   - 未活動 → **切る**（サーバー死の疑い。捨てる成果物が無い）
     *   - 活動後 → **切らない**。`stalled` を通知して、また張り直す
     *
     * 活動後も張り直すのは、UI に「N秒止まっています」を出し続けるため。
     */
    const armIdleTimer = () => {
      if (settled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      const armedAt = Date.now();
      idleTimer = setTimeout(function onIdle() {
        if (settled) return;
        if (!sawActivity) {
          finish(() => reject(new ComicTextTurnTimeoutError(label, "idle")));
          return;
        }
        // 一度でも動いた turn は自動で捨てない。止まっていることだけ伝える。
        onProgress?.({
          phase: "stalled",
          receivedChars: buffer.length,
          idleMs: Date.now() - armedAt,
        });
        idleTimer = setTimeout(onIdle, idleTimeoutMs);
      }, idleTimeoutMs);
    };

    /** 何らかの受信があった。無応答タイマーをリセットし、進捗を通知する。 */
    const noteActivity = () => {
      if (settled) return;
      sawActivity = true;
      armIdleTimer();
      const phase: ComicTextTurnProgress["phase"] =
        buffer.length > 0 ? "streaming" : "waiting";
      onProgress?.({ phase, receivedChars: buffer.length });
    };

    if (signal) {
      onAbort = () => {
        // 中止はユーザーの明示操作。サーバー側の turn も止めにいく。
        interruptServerTurn();
        finish(() => reject(new ComicTextTurnAbortedError(label)));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    armIdleTimer();
    if (totalTimeoutMs !== undefined) {
      totalTimer = setTimeout(() => {
        // 総時間の天井。受信が続いていても打ち切る（暴走 turn の最後の壁）。
        //
        // 理由は**常に "total"**。ここへ到達したという事実そのものが
        // 「一度も動かなかったのではない」の証明になる（1文字も来ない turn は
        // 先に idle タイマーが切っている。idle < total は呼び出し側の前提）。
        // 本文の有無で分けていた頃は、推論通知だけが流れ続けた turn が
        // 総時間で切れたのに「タイムアウトしました。もう一度お試しください」と
        // 再実行を促す誤案内になっていた（Sol 指摘 2026-08-04）。
        //
        // 天井で捨てる以上、サーバー側の turn も止めにいく（走り残り対策・ppw）。
        interruptServerTurn();
        finish(() => reject(new ComicTextTurnTimeoutError(label, "total")));
      }, totalTimeoutMs);
    }

    const handleNotification = (n: RpcNotification) => {
      const params = n.params as any;
      const tid = params?.threadId ?? params?.thread?.id;

      /**
       * 実装契約O (2026-08-05): **threadId を持たない通知は「生存の証拠」として扱う**。
       *
       * 機序（STΛCK 実機で v2.4.1 から再発したタイムアウト退行の真因）:
       * 推論中の通知（`item/reasoning/delta` 等）は `params.threadId` を
       * **持たないことがある**。証拠は `src/lib/codex-events.ts:150,165` で、
       * これらの handler は `params?.threadId ?? state.activeThreadId` と
       * フォールバックしている＝threadId 無し通知の実在が前提になっている。
       *
       * 旧実装はここで `tid !== threadId` により **tid === undefined の通知も
       * 一律に捨てて**いた。結果、モデルが長考している（＝推論通知だけが流れる）
       * あいだ、このヘルパーからは完全な無音に見え、まだ1文字も本文が来ていない
       * turn は idle タイマーで「無応答」と誤判定されて切られていた。
       *
       * 対処は非対称にする:
       *   - tid 明示の**別**スレッド → 従来どおり完全に無視（他スレッドの賑わいで
       *     自分のタイマーをリセットすると「自分は無言なのに切れない」）
       *   - tid 無し → **noteActivity だけする**。本文バッファには取り込まない
       *     （どのターンの本文か決められないものを混ぜると他ターンの文字列が
       *     成果物に紛れる）
       *
       * トレードオフ: 誤って他ターンの無印通知を生存と数える可能性は残る。
       * だが実害は**待ちが延びるだけ**で、出口は中止ボタンと総時間の天井（契約M）。
       * 逆に無視した場合の実害は**長考中の正当なターンを捨てる**ことで、これは
       * v2.4.1 からの退行として実機で観測済み。非対称なので生存側に倒す。
       */
      if (tid === undefined) {
        noteActivity();
        return;
      }
      // このスレッド以外の通知（他の生成スレッド）は無視する。
      // ここで return するのが重要: 他スレッドの賑わいで自分の無応答タイマーを
      // リセットすると、「自分は無言なのに切れない」状態になる。
      if (tid !== threadId) return;

      if (n.method === "turn/started") {
        // 中止・天井到達で turn/interrupt を送るのに要る ID。ここでしか手に入らない。
        const id = params?.turn?.id;
        if (typeof id === "string") turnId = id;
      } else if (n.method === "item/started") {
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
