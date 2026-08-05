import { useEffect, useRef, useState } from "react";
import {
  GENERATION_KIND_LABEL,
  WAITING_STUCK_THRESHOLD_MS,
  describeStall,
  deriveEffectiveStall,
  focusGenerationKind,
  globalLastEventAt,
  isCancellableKind,
  jobPercent,
  selectTotals,
  useGenerationStatus,
  type GenerationJob,
} from "../lib/store/generationStatus";
import {
  isStoppableProvider,
  selectBatchProvider,
  useBatches,
} from "../lib/store/batches";
import { cancelGeneration, genCapacity } from "../lib/ipc";
import { cancelDirectRun, isDirectRunParent } from "../lib/store/directRun";
import { useStoryboardRun } from "../lib/store/storyboardRun";
import { useToasts } from "../lib/store/toasts";

/**
 * 右上に常駐する「生成の今」パネル。
 *
 * ## なぜ (2026-07-25 STΛCK指示)
 * 「生成中のまま進まない」と見えたとき、実際には codex exec が4本並列で動いていた。
 * 止まっているのか動いているのかがユーザーから判別できないのが最大の問題だった。
 * そこで次の3点を常時見せる:
 *   - 並列で何枚動いているか
 *   - 認証が切れていないか
 *   - 進まないなら何が原因か (エラーコードを含む)
 * フリーズに見える状態を作らないことが目的。
 */

/** 秒を「1分20秒」形式にする。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

function SpinnerIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.5V12l3 2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 「やめる」の進行状態。
 *
 * 押した瞬間に「やめました」と出さないための状態機械。
 * Rust から CancelReport が返るまでは "stopping" のままにし、
 * 返ってきた実数 (found / terminated) を見てから文言を決める。
 * 押したら止まったことにするのは、このアプリが避けてきた「嘘のUI」そのもの。
 *
 * failed が `reason` を持つのは、表示分岐を**文言の文字列一致でやらないため**。
 * 以前は `message.includes("開始処理中")` で分岐していたが、これは
 * 文言を直すと静かに壊れる暗黙結合だった。
 */
type CancelState =
  | { phase: "idle" }
  | { phase: "stopping" }
  | { phase: "stopped"; terminated: number }
  | {
      phase: "failed";
      /**
       * not-found = Rust が知らない run / not-started = 仮ID / ipc-error = 例外 /
       * partial = 一部の子の中止が失敗した (direct-run 親のみ)
       */
      reason: "not-found" | "not-started" | "ipc-error" | "partial";
      message?: string;
    };

/**
 * 進捗が途絶えたときの自己診断案内 (23g / 2026-08-03)。
 *
 * 実ユーザー報告の「4時間順番待ち」は、アプリ外で Codex を使ったことによる
 * 認証競合が主因だった。自動リカバリはしない (生きている生成を誤殺しないため)。
 * 事実と次にやれることだけを出し、行動はユーザーに委ねる。
 */
function StuckGuidance() {
  return (
    <div className="mt-1.5 rounded-md bg-[#1e1e1e] px-2 py-1.5 text-[11px] leading-snug text-amber-200/90">
      <p>
        アプリの外で Codex（ChatGPT / Codex CLI）を使っていると、認証が競合して止まることがあります。
        設定 → アカウントで Codex を再ログインすると直ることがあります。
        改善しない場合は「中止」してから、もう一度お試しください。
      </p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("gori:open-settings"))}
        className="mt-1.5 rounded-md border border-[#3a3a3a] px-2 py-0.5 text-[10px] font-bold text-neutral-300 transition-colors hover:border-pink-500/60 hover:text-pink-300"
      >
        設定を開く
      </button>
    </div>
  );
}

function JobRow({
  job,
  globalLast,
  onFocus,
}: {
  job: GenerationJob;
  /** globalLastEventAt(jobs) の値。待機のみジョブの番犬判定に使う。 */
  globalLast: number | null;
  /** 行本体クリックで、このジョブのスキル画面へ移動する (cne)。 */
  onFocus: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [cancel, setCancel] = useState<CancelState>({ phase: "idle" });
  // provider (文字列 or undefined) を購読する。batch オブジェクトを select すると
  // 参照が毎回変わって不要な再描画になる。
  const provider = useBatches((s) => selectBatchProvider(s, job.id));
  const serverStoppable = isStoppableProvider(provider);

  useEffect(() => {
    if (job.finished) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job.finished]);

  const handleCancel = async () => {
    if (cancel.phase === "stopping") return;

    // direct-run (漫画など) の親ジョブ (2026-07-28 追加)。
    //
    // 親 run ID は Rust に存在しないので `cancel_generation(job.id)` は効かない。
    // 代わりにレジストリが保持している**子 batchId 全部**へ中止を送る。
    // 子は Rust の実行中 run 台帳に実在するので、これは本物の中止になる。
    // 子のカードは作らせていないため cancelBatch は呼ばない (対象が無い)。
    //
    // found:false になるのは「親が台帳から解放済み」のときだけ (2026-07-28 修正)。
    // 発射直後で子の Started がまだ1件も届いていない窓では、cancelDirectRun が
    // 中止要求を立てて遅着した子まで確実に止め、その結果を待って found:true を返す。
    // 以前はこの窓で「見つかりません」と出ていたが、実態は全部止まっており
    // 表示と実態が真逆だった。
    if (isDirectRunParent(job.id)) {
      setCancel({ phase: "stopping" });
      try {
        const report = await cancelDirectRun(job.id);
        if (!report.found) {
          setCancel({ phase: "failed", reason: "not-found" });
          return;
        }
        // 中止に失敗した子がいたら成功表示にしない (2026-07-28)。
        //
        // 以前は子への cancel_generation の reject / found:false を握りつぶして
        // 常に「中止しました」と出し、ジョブも finish していた。止まっていない
        // 生成が残っているのに成功表示になるのは、このアプリが潰そうとしている
        // 「表示と実態の食い違い」そのもの。止まった分 (terminated) だけを
        // running から引き、ジョブは finish せず走行中のまま残す。
        if (report.failedChildren > 0) {
          useToasts.getState().push({
            kind: "error",
            text: "中止に失敗しました。生成が続いている可能性があります。",
            ttlMs: 6000,
          });
          setCancel({ phase: "failed", reason: "partial" });
          return;
        }
        useGenerationStatus.getState().setRunning(job.id, 0);
        setCancel({ phase: "stopped", terminated: report.terminated });
        // "cancelled" を渡す: 止めたジョブに「完成しました」の通知を出さない (cne)。
        useGenerationStatus.getState().finish(job.id, "cancelled");
        window.setTimeout(() => useGenerationStatus.getState().clear(job.id), 6000);
      } catch (error) {
        useToasts.getState().push({
          kind: "error",
          text: "中止に失敗しました。生成が続いている可能性があります。",
          ttlMs: 6000,
        });
        setCancel({ phase: "failed", reason: "ipc-error", message: String(error) });
      }
      return;
    }

    // 開始直後の窓を塞ぐ (2026-07-27 / Fable 5 評価者 blocking#3)。
    //
    // 送信クリックから Rust の Started イベント到達までの数秒は、job.id が
    // フロントの仮 ID (`local-...`) のまま。この状態で Rust へ渡しても
    // 実 run (batch-...) と一致しないので**何も止まらないのに「中止しました」と出る**。
    // 効かないと分かっている呼び出しはしない。
    if (job.id.startsWith("local-")) {
      setCancel({ phase: "failed", reason: "not-started" });
      return;
    }

    setCancel({ phase: "stopping" });
    try {
      const report = await cancelGeneration(job.id);

      // Rust が知らない run だった (すでに終了 / まだ未開始 / 管理外の ID)。
      // 何も止めていないので、カードもパネルも一切触らない。
      // 実態が分からないものを「止まった」表示にしない。
      if (!report.found) {
        setCancel({ phase: "failed", reason: "not-found" });
        return;
      }

      // 生成タイムライン側のカードも止める (2026-07-27 実機で判明した不整合の修正)。
      //
      // ## なぜ要るか
      // パネルが「やめました」と出しても、下のカードは「生成中 17秒」のまま
      // 秒数が増え続けていた。パネルとカードは別ストア (generationStatus /
      // batches) を見ており、キャンセルをパネル側にしか伝えていなかったため。
      // 「やめたのに動いて見える」は、このアプリが潰そうとしている
      // 「表示が実態と食い違う」状態そのもの。
      //
      // job.id は syncBatchStatus (batches.ts:342) が batchId をそのまま使うので、
      // バッチ生成なら同じ ID で引ける。該当が無い経路 (スキル系) では何も起きない。
      await useBatches.getState().cancelBatch(job.id);

      // ストーリーカットの run も 'cancelled' に落とす (S3 issue-7 / 2026-07-28)。
      //
      // ## なぜ要るか
      // Rust は中止した run のイベントを意図的に一切出さない。そのため
      // storyboardRun の status は 'running' のまま残り、Phase 3 の画面が
      // 止めた後も生成中に見え続ける。上の cancelBatch と同じ「パネルと
      // 本体ストアの食い違い」を storyboard 側でも塞ぐ。
      if (job.kind === "storyboard") {
        useStoryboardRun.getState().markCancelled(job.id);
      }

      // パネル側の running も 0 にする。Rust は停止済みでも、
      // 次のイベントが来るまで表示上の running が残るため。
      useGenerationStatus.getState().setRunning(job.id, 0);

      setCancel({ phase: "stopped", terminated: report.terminated });

      // 結果を読める時間だけ残して自動で消す (2026-07-27)。
      // 手動で × を押さないと残り続けると、止めたのに画面に居座って
      // 「まだ何か動いている」ように見える。finish() で終了扱いにしてから
      // 少し置いて片付ける。
      // "cancelled" を渡す: 止めたジョブに「完成しました」の通知を出さない (cne)。
      useGenerationStatus.getState().finish(job.id, "cancelled");
      window.setTimeout(() => {
        useGenerationStatus.getState().clear(job.id);
      }, 6000);
    } catch (error) {
      // 失敗を黙って飲まない。押したのに何も起きないのが一番不安なので、
      // 「効かなかった」ことを明示して、生成は続いていると伝える。
      setCancel({ phase: "failed", reason: "ipc-error", message: String(error) });
    }
  };

  // 無反応の自動検出。理由が未設定でも、黙って固まらせない。
  // 判定本体は generationStatus.deriveEffectiveStall (23g で純関数へ分離)。
  const effectiveStall = deriveEffectiveStall(job, now, globalLast);

  const percent = jobPercent(job, 120);
  const settled = job.completed + job.failed;
  // 「待ち」は異常ではないので赤くしない (仕様上の停止をエラーに見せない)
  const isError =
    effectiveStall?.type === "error" ||
    effectiveStall?.type === "auth-required" ||
    effectiveStall?.type === "stuck";
  const isWaiting =
    effectiveStall?.type === "waiting-user" || effectiveStall?.type === "waiting-slot";

  return (
    /*
      行クリックで当該スキルへ移動する (cne / 2026-08-04)。
      パネル全体がドラッグ可能なので、掴んで動かしただけの操作を遷移にしない
      (親の onPointerDown が押下位置を記録し、動いていなければ click を通す)。
      role="button" は付けない: 中に中止/× の本物のボタンが入るため
      (button の入れ子は不正なマークアップになる)。キーボード操作は
      末尾の「開く」ボタンが担当する。
    */
    <div
      onClick={(event) => {
        // 行内のボタン (中止 / × / 設定を開く) は自分の仕事をする。
        // 個々のボタンに stopPropagation を書くと、ボタンを足すたびに
        // 書き忘れて「押したら画面が飛ぶ」事故が起きるので、入口で1回だけ判定する。
        if ((event.target as HTMLElement).closest("button")) return;
        onFocus();
      }}
      className="cursor-pointer rounded-lg border border-[#2a2a2a] bg-[#141414]/95 px-3 py-2.5 shadow-lg backdrop-blur transition-colors hover:border-pink-500/40"
      title="クリックすると、この生成のスキル画面へ移動します"
    >
      {/* 見出し: 種類 + 並列稼働数。本文より一段大きく太く（情報階層） */}
      <div className="flex items-center gap-2">
        {job.finished ? null : (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-pink-400" />
        )}
        {/*
          行名は job.label があればそれを出す (SQ2 / 2026-08-04)。
          キャラ登録は同じ種別の生成を何本も並べられるので、種別名だけだと
          「キャラクターシート」が3行並んでどれがどのキャラか分からなくなる。
          label を持たない既存の経路は今までどおり種別名で出る。
        */}
        <span
          className="min-w-0 flex-1 truncate text-[13px] font-black leading-tight text-white"
          title={job.label ?? GENERATION_KIND_LABEL[job.kind]}
        >
          {job.label ?? GENERATION_KIND_LABEL[job.kind]}
        </span>
        {/*
          やめる (2026-07-27 追加)。

          以前は「生成そのものは止められない (Rust 側に中断コマンドが無い)」ため
          × の「表示を消す」だけを置いていた。cancel_generation の実装で
          実際に止められるようになったので、本物の中止ボタンを出す。

          × と分けているのは、「もう見なくていいが生成は続けたい」
          (大量生成を裏で回す) という正当な使い方を潰さないため。
          × を中止に置き換えると、その使い方が失われる。

          表示条件は2段のゲート (2026-07-27 追加):
            - kind 軸 (isCancellableKind): その経路が run_id を Rust の台帳へ届けるか
            - provider 軸 (serverStoppable): そのバッチの実行主体をこちらから止められるか
          外部サービス (Higgsfield / Magnific) はサーバ側の生成を止める手段が無いので、
          ボタン自体を出さない。「効かないなら出さない」。説明文も添えない
          (説明すると「では何のためのUIか」になる。ボタンが無いこと＝約束していないこと)。
        */}
        {!job.finished &&
          cancel.phase !== "stopped" &&
          isCancellableKind(job.kind) &&
          serverStoppable && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancel.phase === "stopping"}
              title="この生成を中止します（順番待ちは即中止、実行中のカットも停止します）"
              className="shrink-0 whitespace-nowrap rounded-md border border-[#3a3a3a] px-2 py-0.5 text-[10px] font-bold text-neutral-300 transition-colors hover:border-red-500/60 hover:text-red-300 disabled:opacity-50"
            >
              {cancel.phase === "stopping" ? "中止中…" : "中止"}
            </button>
          )}
        {/* 表示を消す。生成は続行する (中止とは別物)。 */}
        <button
          type="button"
          onClick={() => dismissJob(job.id)}
          title="この表示を消します（生成そのものは続きます）"
          aria-label={`${GENERATION_KIND_LABEL[job.kind]}の表示を消す`}
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:bg-[#2a2a2a] hover:text-pink-300"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/*
        やめた結果。Rust の CancelReport をそのまま文言にする。
        推測で「止まりました」と言わない (no-silent-gap-filling)。

        terminated が 0 でも「実行中のものが無かった」とは書かない (2026-07-27 修正)。
        常駐 app-server 経由の生成は turn/interrupt で止まり exec プロセスを殺さないため、
        実行中でも terminated は 0 になる。プロセス数には言及せず、
        保証できる事実 (新しい生成は始まらない・生成済みは残る) だけを言う。
      */}
      {cancel.phase === "stopped" && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-300">
          {cancel.terminated > 0
            ? `中止しました（実行中だった ${cancel.terminated} 件を停止しました。生成済みの分は残ります）`
            : "中止しました。新しい生成は開始されません（生成済みの分は残ります）"}
        </p>
      )}
      {cancel.phase === "failed" && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300">
          {cancel.reason === "not-started"
            ? "開始処理中です。数秒おいてからもう一度お試しください"
            : cancel.reason === "not-found"
              ? // 終了済みか未開始かを Rust は区別できない。分からないことは断定しない。
                "中止できませんでした。この生成は見つかりません（すでに終了しているか、まだ開始していません）"
              : cancel.reason === "partial"
                ? // 一部の子だけ止まった。止まった数も止まらなかった数も断定できないので、
                  // 「続いている可能性がある」までしか言わない (no-silent-gap-filling)。
                  "中止に失敗しました。生成が続いている可能性があります。"
                : `中止できませんでした。生成は続いています（${cancel.message}）`}
        </p>
      )}

      {/* 本文: 数値の内訳。見出しより小さく、色を落とす */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
        {/*
          並列稼働数 (2026-07-28 に見出し行からここへ移設)。
          見出し行に置くと種類名 (最長「キャラクターシート」) と中止ボタンに挟まれ、
          パネル幅 288px では CJK が文字単位で折れて「同時実/行」になっていた。
        */}
        {job.running > 0 && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-[#2a1f26] px-1.5 py-0.5 text-[10px] font-bold text-pink-300">
            {job.running}枚 同時実行
          </span>
        )}
        <span className="font-mono tabular-nums text-neutral-300">
          {job.total ? `${settled} / ${job.total}` : `${settled} 枚`}
        </span>
        {job.failed > 0 && (
          <span className="font-mono tabular-nums text-red-400">失敗 {job.failed}</span>
        )}
        <span className="ml-auto font-mono tabular-nums text-neutral-500">
          {formatElapsed(now - job.startedAt)}
        </span>
      </div>

      {/* 進捗バー: total があれば実測、無ければ経過時間で補間（90%止め） */}
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-[#2a2a2a]">
        <div
          className={
            "h-full rounded-full transition-[width] duration-700 ease-out " +
            (isError
              ? "bg-red-500"
              : "bg-gradient-to-r from-pink-600 to-pink-400")
          }
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* 進まない理由。ここが空にならないことがこのパネルの存在意義 */}
      {effectiveStall && (
        <div
          className={
            "mt-2 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug " +
            (isError
              ? "bg-[#2a1818] text-red-300"
              : isWaiting
                ? "bg-[#18202a] text-sky-300"
                : "bg-[#1e1e1e] text-amber-300")
          }
        >
          {isWaiting ? (
            <ClockIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          )}
          <span>{describeStall(effectiveStall)}</span>
        </div>
      )}
      {effectiveStall?.type === "stuck" && <StuckGuidance />}
    </div>
  );
}

/**
 * 採用ゲートの待機キュー (pendingProductionCuts) の擬似行 (23g / 2026-08-03)。
 *
 * このキューはジョブではないのでパネルに一切出ておらず、走行中 run のイベントが
 * 途絶えると発射契機を失ったまま無期限に沈黙していた。常時見せた上で、
 * 「全体のイベントが途絶えている」ときだけエスカレーションする。
 * **キューの滞留時間では判定しない** — 走行中 run が健全に長いだけのケースを
 * 誤って異常と呼ぶため。
 */
function PendingProductionRow({
  count,
  globalLast,
  onClear,
}: {
  count: number;
  globalLast: number | null;
  onClear: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // globalLast === null は未終了ジョブが1件も無いのにキューだけ残っている状態
  // (イベント喪失後に × で表示を消した等)。発射契機が既に失われているので即エスカレーション。
  const stalled = globalLast === null || now - globalLast > WAITING_STUCK_THRESHOLD_MS;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#141414]/95 px-3 py-2.5 shadow-lg backdrop-blur">
      <div
        className={
          "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug " +
          (stalled ? "bg-[#1e1e1e] text-amber-300" : "bg-[#18202a] text-sky-300")
        }
      >
        {stalled ? (
          <AlertIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        ) : (
          <ClockIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="font-bold">本生成の順番待ち: {count} カット</p>
          <p className="mt-0.5">
            {stalled
              ? "生成の進捗が止まっているため、この順番待ちが開始されない可能性があります。走行中の生成を「中止」すると、この順番待ちは取り消されます。取り消した場合は、絵コンテ画面からもう一度「本生成」を実行してください。"
              : "走行中の生成が終わり次第、自動で開始します"}
          </p>
        </div>
      </div>
      {stalled && (
        <>
          <StuckGuidance />
          {/*
            袋小路の脱出口 (23g)。走行中ジョブの表示を × で消した後にイベントが
            喪失すると、パネルに「中止」ボタンを持つ行が存在せずキューだけが残り、
            上の案内文の「中止」が押せなくなる。破壊的操作なので自動では呼ばない。
          */}
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 rounded-md border border-[#3a3a3a] px-2 py-0.5 text-[10px] font-bold text-neutral-300 transition-colors hover:border-red-500/60 hover:text-red-300"
          >
            順番待ちを取り消す
          </button>
        </>
      )}
    </div>
  );
}

/**
 * 進行表示を消す。
 *
 * バッチ経路では job.id が batchId と同一 (batches.ts の syncBatchStatus が
 * batchId をそのまま job id にしている) なので、残っているバッチカードも
 * 一緒に取り除く。id が一致しない経路 (beginDirectRun 系) では removeBatch は
 * 何にもマッチせず無害に終わる。
 */
function dismissJob(id: string) {
  useGenerationStatus.getState().dismiss(id);
  useBatches.getState().removeBatch(id);
}

/** パネル位置の保存キー。次回起動時も同じ場所に出す。 */
const PANEL_POS_KEY = "gori.generationStatusPanel.pos";
const PANEL_WIDTH = 288; // w-72

/** これ以上動いたらドラッグと見なし、行クリックの遷移を起こさない (cne)。 */
const DRAG_THRESHOLD_PX = 4;

/**
 * 生成枠の使用状況ヘッダ (cne / 2026-08-04)。
 *
 * ## なぜ要るか
 *
 * 複数スキルを並走させられるようにすると、次は「あと何本頼めるのか」が
 * 見えないまま詰まる。バックエンドは全機能共通のセマフォで動いており
 * (gen_queue.rs)、上限に達した分は順番待ちになる。使用中と上限を並べて
 * 出せば、待ちが発生していることが数字で分かる。
 *
 * 上限 (limit) は Rust の現在値。429 を検知すると 9 → 6 へ自動降格するので、
 * その場合は理由も添える。取得できていない間は上限を出さない (推測しない)。
 */
function CapacityHeader({
  running,
  capacity,
}: {
  running: number;
  capacity: { limit: number; degraded: boolean } | null;
}) {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#141414]/95 px-3 py-1.5 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-bold text-neutral-300">生成枠</span>
        <span className="font-mono tabular-nums text-neutral-400">
          使用中 {running}
          {capacity ? ` / ${capacity.limit}` : ""}
        </span>
        {capacity?.degraded && (
          <span
            className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-[#2a2318] px-1.5 py-0.5 text-[10px] font-bold text-amber-300"
            title="短時間に生成が集中したため、同時に走らせる本数を一時的に減らしています"
          >
            混雑のため縮小中
          </span>
        )}
      </div>
    </div>
  );
}

type PanelPos = { x: number; y: number };

function loadPanelPos(): PanelPos | null {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PanelPos>;
    if (typeof p?.x !== "number" || typeof p?.y !== "number") return null;
    return { x: p.x, y: p.y };
  } catch {
    return null;
  }
}

/** 画面内に収める。ウィンドウを小さくした後でもパネルが画面外に消えないように。 */
function clampToViewport(pos: PanelPos): PanelPos {
  const maxX = Math.max(0, window.innerWidth - PANEL_WIDTH - 8);
  const maxY = Math.max(0, window.innerHeight - 80);
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY),
  };
}

export function GenerationStatusPanel() {
  const jobs = useGenerationStatus((s) => s.jobs);
  const active = Object.values(jobs).filter((job) => !job.finished);
  // 待機のみジョブ・待機キューの番犬はここを共通の入力にする (23g)。
  const globalLast = globalLastEventAt(jobs);
  const pendingCuts = useStoryboardRun((s) => s.pendingProductionCuts);
  const clearPendingProduction = useStoryboardRun((s) => s.clearPendingProduction);

  // 2026-07-27: パネルをドラッグで動かせるようにした (STΛCK 指摘)。
  // 以前は right-4 top-32 の固定で、生成中は右上のボタン (Magnific / 生成準備OK /
  // プロジェクト選択) が隠れて押せなかった。全スキル画面で同じ場所に出るため、
  // どの画面でも同じ問題が起きていた。
  const [pos, setPos] = useState<PanelPos | null>(() => loadPanelPos());
  const dragRef = useRef<{
    dx: number;
    dy: number;
    startX: number;
    startY: number;
  } | null>(null);
  /**
   * このポインタ操作でパネルを実際に動かしたか (cne / 2026-08-04)。
   *
   * 行クリックで画面遷移するようにしたので、**掴んで動かしただけの操作が
   * 遷移になってはいけない**。ドラッグ終了時に click も飛ぶため、
   * 移動が起きたかを覚えておいて遷移側で弾く。
   */
  const draggedRef = useRef(false);

  // 生成枠の上限 (cne)。Rust の現在値を取る。定数をここにミラーすると
  // 429 で 9 → 6 へ降格したときに UI だけが 9 と言い続ける (嘘の上限)。
  const [capacity, setCapacity] = useState<{ limit: number; degraded: boolean } | null>(null);

  // ウィンドウリサイズで画面外に出たら引き戻す
  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos((prev) => (prev ? clampToViewport(prev) : prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos));
    } catch {
      // 保存できなくても動作には影響しない (次回また既定位置に出るだけ)
    }
  }, [pos]);

  /*
    生成枠の上限を取り直す (cne)。
    走行中ジョブがある間だけ、少し間を置いて取り直す: 429 による降格は
    生成中にしか起きず、上限が変わったのに 9 と言い続けるのを避けたい。
    生成が無いときは問い合わせない (常時ポーリングしない)。
  */
  const hasActive = active.length > 0;
  useEffect(() => {
    if (!hasActive) return;
    let alive = true;
    const load = () => {
      genCapacity()
        .then((value) => {
          if (alive) setCapacity(value);
        })
        .catch(() => {
          // 取れなければヘッダの上限表示を出さないだけ (推測値を出さない)。
        });
    };
    load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hasActive]);

  if (active.length === 0 && pendingCuts.length === 0) return null;

  // ヘッダに出す「使用中 k」。k は実イベント由来の running 合計 (推定しない)。
  const totals = selectTotals(jobs);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // ボタン類の上では掴まない (中止ボタンが押せなくなる)
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
    };
    // 新しい操作の始まり。まだ動かしていない (cne)。
    draggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 押した位置から DRAG_THRESHOLD_PX 以上離れたら「動かした」と見なす (cne)。
    // 1px でも動いたら遷移を止める作りにすると、クリック時の手の微動で
    // 「押しても何も起きない」ようになる。逆に閾値が無いと、動かした後に
    // 意図しない画面遷移が起きる。
    if (
      Math.abs(event.clientX - d.startX) > DRAG_THRESHOLD_PX ||
      Math.abs(event.clientY - d.startY) > DRAG_THRESHOLD_PX
    ) {
      draggedRef.current = true;
    }
    setPos(clampToViewport({ x: event.clientX - d.dx, y: event.clientY - d.dy }));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    // pointer-events-auto が要る: 親が pointer-events-none のままだと
    // 中止ボタンがクリックできず「押せるのに効かない」状態になる。
    <div
      className={[
        "pointer-events-auto fixed z-30 flex w-72 cursor-grab flex-col gap-2 active:cursor-grabbing",
        pos ? "" : "right-4 top-32",
      ].join(" ")}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title="ドラッグで移動できます"
    >
      {active.length > 0 && (
        <CapacityHeader running={totals.running} capacity={capacity} />
      )}
      {pendingCuts.length > 0 && (
        <PendingProductionRow
          count={pendingCuts.length}
          globalLast={globalLast}
          onClear={clearPendingProduction}
        />
      )}
      {active.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          globalLast={globalLast}
          onFocus={() => {
            // 掴んで動かしただけの操作は遷移にしない (cne)。
            if (draggedRef.current) return;
            focusGenerationKind(job.kind);
          }}
        />
      ))}
    </div>
  );
}
