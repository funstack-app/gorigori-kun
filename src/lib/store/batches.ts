import { create } from "zustand";
import {
  type GenPhaseEvent,
  type GenPhaseName,
  type ImageBatchEvent,
  type ImageBatchProvider,
} from "../ipc";
import {
  recordGenerationDuration,
  type GenerationGaugeMode,
} from "../../components/GenerationGauge";
import { stallFromFailure, useGenerationStatus } from "./generationStatus";

// ──────────── Types ────────────

// P0-1 mediaType 導入 (2026-05-28 動画タブ準備)
export type MediaType = "image" | "video";

/**
 * 生成1枚の進み具合 (設計書 S1)。
 *
 * ## なぜ status と別に持つか
 *
 * `status` は「pending / running / completed / failed」の**結果**の軸で、
 * 送信から完成までの数十秒はすべて running の一点にまとまっていた。
 * その間 UI は同じスピナーを回し続けるだけなので、**動いているのか
 * 止まっているのかがユーザーから区別できない**。
 *
 * phase は同じ running の中の**進み具合**の軸。Rust が実イベント
 * (permit取得 / turn/start / item/started) で駆動するので、
 * 経過時間からの推定ではない (generationStatus.ts と同じ「実イベントを正とする」方針)。
 */
export type GenPhase = GenPhaseName;

/** フェーズの進行順。後戻りを弾くために使う。 */
const GEN_PHASE_ORDER: readonly GenPhase[] = ["queued", "thinking", "drawing", "done"];

/**
 * 表示文言。設計書 3-1 の表と一字一句同じにする
 * (文言を変えるとユーザーの学習が無駄になるので、勝手に言い換えない)。
 */
export const GEN_PHASE_LABEL: Record<GenPhase, string> = {
  queued: "順番待ち",
  thinking: "構図を考えています…",
  drawing: "描いています…",
  done: "完成",
};

export type BatchWorker =
  | {
      idx: number;
      status: "pending" | "running";
      /** worker が実際に走り出した時刻 (epoch ms)。running のときだけ入る。
       *  MAX_CONCURRENT=3 で 4 枚目以降は semaphore 待ちで pending のまま
       *  待機するため、バッチ開始時刻でなく worker 個別の開始時刻で経過秒を
       *  数えないと、待機中の worker が実際より長く「生成中」に見える。 */
      runningAt?: number;
      /** いまどのフェーズか。未受信なら undefined (= 従来どおりのスピナー表示)。 */
      phase?: GenPhase;
      /** queued のとき、自分の前に走っている枚数。 */
      queuePosition?: number;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      idx: number;
      status: "completed";
      path: string;
      /** この画面セッション中に完成した枠か (S3 ブラーアップの対象判定)。
       *  履歴から復元した完成済みタイルにまで演出をかけない。 */
      justCompleted?: boolean;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      idx: number;
      status: "failed";
      error: string;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    };

export type Batch = {
  batchId: string;
  prompt: string;
  references: { path: string; name: string }[];
  count: number;
  startedAt: number;
  workers: BatchWorker[];
  status: "running" | "completed" | "cancelling" | "cancelled";
  failedCount: number;
  provider?: ImageBatchProvider;
  modelJobSetType?: string;
  modelDisplayName?: string;
  mediaType?: MediaType;
  compareMode?: boolean;
};

type BatchesState = {
  batches: Batch[];
  /** Create an optimistic batch entry immediately when the user clicks 送信.
   *  Uses a local temp id ("local-<timestamp>") so the pseudo-turn appears
   *  before the Rust side has started. */
  startBatch: (opts: {
    batchId: string;
    prompt: string;
    references: { path: string; name: string }[];
    count: number;
    provider?: ImageBatchProvider;
    modelJobSetType?: string;
    modelDisplayName?: string;
    mediaType?: MediaType;
    compareMode?: boolean;
    workerModels?: { jobSetType: string; displayName: string }[];
  }) => void;
  /** Remove a batch by id. Used to clean up optimistic entries that never
   *  received a `started` event (e.g. when `generateBatch` IPC rejects). */
  removeBatch: (batchId: string) => void;
  /** Route every `codex://image-batch` event through here. */
  applyEvent: (e: ImageBatchEvent) => void;
  /** Route every `codex://gen-phase` event through here (設計書 S1)。 */
  applyPhase: (e: GenPhaseEvent) => void;
  cancelBatch: (batchId: string) => Promise<void>;
};

export const useBatches = create<BatchesState>((set, _get) => ({
  batches: [],

  startBatch: ({
    batchId,
    prompt,
    references,
    count,
    provider,
    modelJobSetType,
    modelDisplayName,
    mediaType,
    compareMode,
    workerModels,
  }) => {
    const resolvedMediaType = mediaType ?? "image";
    const batch: Batch = {
      batchId,
      prompt,
      references,
      count,
      startedAt: Date.now(),
      workers: Array.from({ length: count }, (_, i) => ({
        idx: i + 1,
        status: "pending" as const,
        modelJobSetType: workerModels?.[i]?.jobSetType ?? modelJobSetType,
        // 2026-07-26 STΛCK 報告「生成したモデル名が表示されない」への対応。
        //
        // workerModels は**モデル比較のときだけ**渡される (1枚ごとに別モデルなので
        // 枚数分の配列が要る)。通常の生成では渡されないため、各画像の下の
        // キャプション (BatchWorkerCell の caption) が空になり、
        // 「何で作ったか」が画像を見ても分からなかった。
        //
        // 比較でない場合はバッチ全体のモデルが全枚数に等しく効いているので、
        // それをフォールバックとして入れる (推測ではなく、同じ値の再掲)。
        modelDisplayName: workerModels?.[i]?.displayName ?? modelDisplayName,
        mediaType: resolvedMediaType,
      })),
      status: "running",
      failedCount: 0,
      provider,
      modelJobSetType,
      modelDisplayName,
      mediaType: resolvedMediaType,
      compareMode,
    };
    set((s) => ({ batches: [...s.batches, batch] }));
  },

  removeBatch: (batchId) => {
    // カードを消すときは右上パネルのジョブも一緒に終わらせる (2026-07-28)。
    //
    // ## なぜ要るか (実害)
    // 外部 provider (magnific/higgsfield) は workerStarted をフロントで合成する
    // ようになり、その結果 syncBatchStatus がパネル側にもジョブを作る。ところが
    // 失敗経路 (動画の全件失敗 / generateBatch IPC の reject) はカードだけを
    // removeBatch で消していたため、**実体の無いジョブがパネルに残り続けた**。
    // 「生成中・N枚 同時実行」が永久に消えず、6分後には
    // 「N分ほど時間がかかっています（生成は続いています）」という嘘まで出る。
    // さらにバッチが消えると provider が undefined になり、
    // isStoppableProvider が true に倒れて効かない「中止」ボタンが復活する。
    //
    // codex 経路は removeBatch の時点でまだジョブが作られていない
    // (started イベント前) ため、finish/clear は何にもマッチせず無害。
    const status = useGenerationStatus.getState();
    status.finish(batchId); // 先に終了扱いにしてから
    status.clear(batchId); // 消す (失敗で消えたものを4秒間見せる意味は無い)
    set((s) => ({ batches: s.batches.filter((b) => b.batchId !== batchId) }));
  },

  cancelBatch: async (batchId) => {
    // 2026-06-10 段階8: Higgsfield は CLI 同梱方式から MCP 接続方式へ移行。MCP 生成は
    // 同期的に完結し、サーバ側に「実行中バッチ」を持たないため、キャンセルできる対象が無い
    // (CLI 版の higgsfield_cancel_batch は廃止)。ここでやるのは**カードの表示状態を
    // cancelled にすることだけ**で、生成そのものは止めない (止めるのは Rust の
    // cancel_generation 側)。
    //
    // 2026-07-27 訂正: 旧コメントは「結果は破棄されカードには出ない」と書いていたが、
    // これは実態と違った。applyEvent の completed 分岐は status を無条件で "completed" に
    // 上書きするため、cancelled にしたカードが完了表示へ復活しうる。
    // 2026-07-28 追記: 上記「到達しない」は当時から不正確だった。バッチカードの
    // ヘッダーに higgsfield 限定の中止ボタンが残っており、Higgsfield 生成中は
    // 普通に到達できた (押すと復活バグが実際に起きる)。そのボタンは削除したため、
    // 現在この経路に来るのは codex 経路のみ。codex 経路は中止時に Rust が
    // Completed を emit しない (batch_gen.rs) ので復活は起きない。
    set((s) => ({
      batches: s.batches.map((b) =>
        b.batchId === batchId && (b.status === "running" || b.status === "cancelling")
          ? { ...b, status: "cancelled" }
          : b,
      ),
    }));
  },

  applyEvent: (e: ImageBatchEvent) => {
    set((s) => {
      const batches = [...s.batches];

      if (e.kind === "started") {
        // Idempotency guard: a duplicate listener registration (e.g.
        // HMR replaying useEffect before its previous cleanup ran)
        // would cause `applyEvent` to fire twice per event. The first
        // call reconciles the local-id; the second would create a
        // phantom duplicate batch card. Skip if we already have an
        // entry for this real batchId.
        if (batches.some((b) => b.batchId === e.batchId)) {
          return s;
        }
        // Reconcile the most-recent local-id entry with the real batchId.
        const localIdx = batches
          .map((b, i) => ({ b, i }))
          .reverse()
          .find(({ b }) => b.batchId.startsWith("local-"));
        if (localIdx) {
          const updated: Batch = {
            ...localIdx.b,
            batchId: e.batchId,
            count: e.count,
            compareMode:
              localIdx.b.compareMode ||
              (e.provider === "higgsfield" && !e.modelDisplayName && e.count > 1),
            provider: e.provider ?? localIdx.b.provider ?? "codex",
            modelJobSetType: e.modelJobSetType ?? localIdx.b.modelJobSetType,
            modelDisplayName: e.modelDisplayName ?? localIdx.b.modelDisplayName,
            mediaType: e.mediaType ?? localIdx.b.mediaType ?? "image",
          };
          const next = [...batches];
          next[localIdx.i] = updated;
          // 右上パネル側のジョブ ID も本物の batchId へ移す (2026-07-27 修正)。
          //
          // ## なぜ要るか (実機で踏んだ不具合)
          // カード側はここで local-xxx → batch-xxx に差し替わるが、パネル側の
          // ジョブは local-xxx のまま残っていた。その状態で「やめる」を押すと
          // Rust には local-xxx が渡り、Rust 側の run_id (=batch-xxx) と
          // 一致しないため **1件も止まらないのに terminated: 0 が返る**。
          // 結果「やめました（実行中のものは無く…）」と表示しながら、
          // 下のカードは生成中のまま秒数が増え続ける、という嘘の状態になった。
          migrateJobId(localIdx.b.batchId, e.batchId);
          return { batches: next };
        }
        // No local entry found — create one from the event itself.
        const batch: Batch = {
          batchId: e.batchId,
          prompt: "",
          references: [],
          count: e.count,
          startedAt: Date.now(),
          workers: Array.from({ length: e.count }, (_, i) => ({
            idx: i + 1,
            status: "pending" as const,
            mediaType: e.mediaType ?? "image",
          })),
          status: "running",
          failedCount: 0,
          provider: e.provider ?? "codex",
          modelJobSetType: e.modelJobSetType,
          modelDisplayName: e.modelDisplayName,
          mediaType: e.mediaType ?? "image",
          compareMode:
            e.provider === "higgsfield" && !e.modelDisplayName && e.count > 1,
        };
        return { batches: [...batches, batch] };
      }

      // For all other events, find by real batchId.
      const idx = batches.findIndex((b) => b.batchId === e.batchId);
      if (idx === -1) return s;

      const batch = { ...batches[idx], workers: [...batches[idx].workers] };

      if (e.kind === "workerStarted") {
        const wi = batch.workers.findIndex((w) => w.idx === e.idx);
        if (wi !== -1) {
          const prev = batch.workers[wi];
          // workerStarted はこの worker が semaphore permit を取って実際に
          // codex exec を起動した瞬間に来る。ここを経過秒の起点にする
          // (バッチ開始時刻ではなく worker 個別の開始時刻)。
          const prevRunningAt =
            prev.status === "pending" || prev.status === "running"
              ? prev.runningAt
              : undefined;
          batch.workers[wi] = {
            idx: e.idx,
            status: "running",
            runningAt: prevRunningAt ?? Date.now(),
            modelJobSetType: e.modelJobSetType ?? prev.modelJobSetType,
            modelDisplayName: e.modelDisplayName ?? prev.modelDisplayName,
            mediaType: e.mediaType ?? prev.mediaType ?? batch.mediaType ?? "image",
          };
        }
        batch.mediaType = e.mediaType ?? batch.mediaType ?? "image";
        if (e.modelDisplayName && !batch.modelDisplayName) batch.compareMode = true;
      } else if (e.kind === "workerCompleted") {
        const wi = batch.workers.findIndex((w) => w.idx === e.idx);
        if (wi !== -1) {
          const prev = batch.workers[wi];
          // ゲージ学習の実測記録は store 層で行う(画面部品の生死に依存しない。
          // 完成と同時に親レイアウトが切り替わると部品側 effect は遷移を観測
          // できないことがある — 2026-07-17 学習データ0件の実測より)
          if (prev.status === "running" && prev.runningAt != null) {
            recordGenerationDuration(
              "batch",
              Math.max(0, (Date.now() - prev.runningAt) / 1000),
            );
          }
          batch.workers[wi] = {
            idx: e.idx,
            status: "completed",
            path: e.path,
            // いま目の前で完成した枠。S3 のブラーアップはこれが true のときだけ走る。
            justCompleted: true,
            modelJobSetType: e.modelJobSetType ?? prev.modelJobSetType,
            modelDisplayName: e.modelDisplayName ?? prev.modelDisplayName,
            mediaType: e.mediaType ?? prev.mediaType ?? batch.mediaType ?? "image",
          };
        }
        batch.mediaType = e.mediaType ?? batch.mediaType ?? "image";
        if (e.modelDisplayName && !batch.modelDisplayName) batch.compareMode = true;
      } else if (e.kind === "workerFailed") {
        const wi = batch.workers.findIndex((w) => w.idx === e.idx);
        if (wi !== -1) {
          const prev = batch.workers[wi];
          batch.workers[wi] = {
            idx: e.idx,
            status: "failed",
            error: e.error,
            modelJobSetType: e.modelJobSetType ?? prev.modelJobSetType,
            modelDisplayName: e.modelDisplayName ?? prev.modelDisplayName,
            mediaType: e.mediaType ?? prev.mediaType ?? batch.mediaType ?? "image",
          };
        }
        batch.mediaType = e.mediaType ?? batch.mediaType ?? "image";
        if (e.modelDisplayName && !batch.modelDisplayName) batch.compareMode = true;
        batch.failedCount = batch.workers.filter(
          (w) => w.status === "failed",
        ).length;
      } else if (e.kind === "completed") {
        batch.status = "completed";
        batch.failedCount = e.failedCount;
        batch.provider = e.provider ?? batch.provider ?? "codex";
        batch.modelJobSetType = e.modelJobSetType ?? batch.modelJobSetType;
        batch.modelDisplayName = e.modelDisplayName ?? batch.modelDisplayName;
        batch.mediaType = e.mediaType ?? batch.mediaType ?? "image";
        batch.compareMode =
          batch.compareMode ||
          (batch.provider === "higgsfield" && !batch.modelDisplayName && batch.count > 1);
        // Reconcile any workers that are still pending/running as completed
        // using the generatedPaths array (order matches idx - 1).
        // 外部 provider (magnific/higgsfield) はゲージ学習の実測をここで記録する
        // (2026-07-28)。Rust の workerCompleted が流れないため上の分岐を通らない。
        // compare モードは記録しない: completed は全モデル完了後に1回だけ来るので、
        // 早く終わったモデルの実所要が観測できず「発行→バッチ末尾」の過大値になる。
        const externalGaugeMode: GenerationGaugeMode | null =
          batch.compareMode
            ? null
            : batch.provider === "magnific"
              ? "magnific"
              : batch.provider === "higgsfield"
                ? batch.mediaType === "video"
                  ? "higgsfield-video"
                  : "higgsfield"
                : null;
        for (let i = 0; i < batch.workers.length; i++) {
          const w = batch.workers[i];
          if (w.status !== "completed" && w.status !== "failed") {
            const path = e.generatedPaths[i];
            // 非 compare では 1リクエスト=全枚数なので「発行→完了」がタイルの
            // 実所要そのもの (推定でなく実測)。成功枠だけ記録する。
            if (
              externalGaugeMode &&
              path &&
              w.status === "running" &&
              w.runningAt != null
            ) {
              recordGenerationDuration(
                externalGaugeMode,
                Math.max(0, (Date.now() - w.runningAt) / 1000),
              );
            }
            if (path) {
              batch.workers[i] = {
                idx: w.idx,
                status: "completed",
                path,
                modelJobSetType: w.modelJobSetType,
                modelDisplayName: w.modelDisplayName,
                mediaType: w.mediaType ?? batch.mediaType ?? "image",
              };
            } else {
              batch.workers[i] = {
                idx: w.idx,
                status: "failed",
                error: "no path",
                modelJobSetType: w.modelJobSetType,
                modelDisplayName: w.modelDisplayName,
                mediaType: w.mediaType ?? batch.mediaType ?? "image",
              };
            }
          }
        }
      } else if (e.kind === "cancelled") {
        batch.status = "cancelled";
        batch.failedCount = batch.workers.filter(
          (w) => w.status === "failed",
        ).length;
      }

      // 右上の生成状況パネルへ実績を橋渡しする (2026-07-25 STΛCK指示)。
      // workers 配列を毎回集計するので、どのイベント経路でも値が正しくなる。
      // 完了数を実測で持つため、ゲージは経過時間の推定でなく実進捗になる
      // (「50%で生成が終わる」問題への対処)。
      syncBatchStatus(batch);

      const next = [...batches];
      next[idx] = batch;
      return { batches: next };
    });
  },

  applyPhase: (e: GenPhaseEvent) => {
    set((s) => {
      // imageIndex を持たない経路 (絵コンテ / マルチアングル) はタイルに紐付かない。
      // 推測で 1 枚目に付けると**別の絵のフェーズを表示する**ので、何もしない。
      if (e.imageIndex == null) return s;

      const bi = s.batches.findIndex((b) => b.batchId === e.runId);
      if (bi === -1) return s;

      const batch = s.batches[bi];
      const wi = batch.workers.findIndex((w) => w.idx === e.imageIndex);
      if (wi === -1) return s;

      const worker = batch.workers[wi];
      // 完了・失敗が確定した枠にフェーズを書き戻さない。gen-phase と image-batch は
      // 別チャンネルなので到着順が入れ替わりうる (done の直後に drawing が届く等)。
      // 結果の軸 (status) が先に確定したら、そちらを正とする。
      if (worker.status !== "pending" && worker.status !== "running") return s;

      // 後戻りを弾く。並列9枚が同じ app-server を共有するため、
      // 別枠の通知が混じっても表示が巻き戻らないようにする。
      const prevRank = worker.phase ? GEN_PHASE_ORDER.indexOf(worker.phase) : -1;
      const nextRank = GEN_PHASE_ORDER.indexOf(e.phase);
      if (nextRank <= prevRank) return s;

      const workers = [...batch.workers];
      workers[wi] = {
        ...worker,
        phase: e.phase,
        queuePosition: e.phase === "queued" ? e.position : undefined,
      };
      const batches = [...s.batches];
      batches[bi] = { ...batch, workers };
      return { batches };
    });
  },
}));

/**
 * この batch の実行主体をこちらから止められるか。
 *
 * ## なぜ kind 軸 (CANCELLABLE_KINDS) だけでは足りないか
 *
 * kind 軸は「その**経路**が run_id を Rust の台帳へ届けるか」を静的に判定する。
 * だが syncBatchStatus は provider を問わず kind="batch" で登録するため、
 * 「batch という経路は中止可能だが、その中の外部 provider バッチは不可能」を
 * kind だけでは表現できない。provider 軸はバッチごとに動的に判定する。
 *
 * バッチ実体が無い job (multiangle / storyboard / characterSheet 等の cut-run 系) は
 * すべて codex exec のローカル実行なので、止められる側に倒す。
 *
 * 再レンダー抑制のため、Zustand の selector には provider (文字列) を返させて
 * primitive 比較にする。batch オブジェクトを返すと参照が毎回変わって不要再描画になる。
 */
export function isStoppableProvider(provider: ImageBatchProvider | undefined): boolean {
  // allow-list で書く (2026-07-27 評価指摘で deny-list から変更)。
  //
  // deny-list (「止められない provider の集合に無ければ true」) だと、
  // **provider を新しく足したとき既定で「止められる」に倒れる**。
  // その provider が実際には止められなかった場合、
  // 「押せるのに効かないボタン」が復活する — このアプリの方針と真逆の倒れ方。
  //
  // allow-list なら、新 provider は既定で「止められない」に倒れ、
  // ボタンが出ない (= 何も約束しない) 側から始まる。安全側。
  // 止められると確認できた時点でここに足す。
  if (provider === undefined) return true; // バッチ実体が無い cut-run 系 = codex ローカル実行
  return provider === "codex";
}

/** selector 用。該当バッチが無ければ undefined (= cut-run 系 job) を返す。 */
export function selectBatchProvider(
  state: BatchesState,
  batchId: string,
): ImageBatchProvider | undefined {
  return state.batches.find((b) => b.batchId === batchId)?.provider;
}

/** batch の workers 配列から実際の稼働数・完了数を数えてパネルへ反映する。 */
/**
 * 仮 ID (`local-...`) で作られた右上パネルのジョブを、Rust から届いた
 * 本物の batchId へ移す。
 *
 * これをしないと「やめる」が Rust に届かない (仮 ID は Rust 側に存在しない)。
 * 詳細は applyEvent の started 分岐のコメント参照。
 */
function migrateJobId(fromId: string, toId: string): void {
  useGenerationStatus.getState().migrateId(fromId, toId);
}

function syncBatchStatus(batch: {
  batchId: string;
  status: string;
  workers: { status: string; error?: string }[];
  mediaType?: string;
}) {
  const status = useGenerationStatus.getState();
  const id = batch.batchId;
  const running = batch.workers.filter((w) => w.status === "running").length;
  const completed = batch.workers.filter((w) => w.status === "completed").length;
  const failed = batch.workers.filter((w) => w.status === "failed").length;

  const job = status.jobs[id];
  if (!job) {
    status.start({
      id,
      kind: batch.mediaType === "video" ? "video" : "batch",
      total: batch.workers.length || undefined,
    });
  }

  status.setRunning(id, running);
  // 差分だけ加算する (addCompleted は累積するため、実測との差を埋める)
  const current = useGenerationStatus.getState().jobs[id];
  if (current) {
    if (completed > current.completed) {
      status.addCompleted(id, completed - current.completed);
    }
    if (failed > current.failed) {
      status.addFailed(id, failed - current.failed);
      const firstError = batch.workers.find((w) => w.status === "failed" && w.error)?.error;
      if (firstError) status.setStall(id, stallFromFailure(firstError));
    }
  }

  if (batch.status === "completed" || batch.status === "cancelled") {
    status.finish(id);
    setTimeout(() => useGenerationStatus.getState().clear(id), 4000);
  }
}

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.batches = useBatches;
}
