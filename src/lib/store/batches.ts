import { create } from "zustand";
import { type ImageBatchEvent, type ImageBatchProvider } from "../ipc";
import { recordGenerationDuration } from "../../components/GenerationGauge";
import { stallFromFailure, useGenerationStatus } from "./generationStatus";

// ──────────── Types ────────────

// P0-1 mediaType 導入 (2026-05-28 動画タブ準備)
export type MediaType = "image" | "video";

export type BatchWorker =
  | {
      idx: number;
      status: "pending" | "running";
      /** worker が実際に走り出した時刻 (epoch ms)。running のときだけ入る。
       *  MAX_CONCURRENT=3 で 4 枚目以降は semaphore 待ちで pending のまま
       *  待機するため、バッチ開始時刻でなく worker 個別の開始時刻で経過秒を
       *  数えないと、待機中の worker が実際より長く「生成中」に見える。 */
      runningAt?: number;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      idx: number;
      status: "completed";
      path: string;
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

  removeBatch: (batchId) =>
    set((s) => ({ batches: s.batches.filter((b) => b.batchId !== batchId) })),

  cancelBatch: async (batchId) => {
    // 2026-06-10 段階8: Higgsfield は CLI 同梱方式から MCP 接続方式へ移行。MCP 生成は
    // 同期的に完結し、サーバ側に「実行中バッチ」を持たないため、キャンセルできる対象が無い
    // (CLI 版の higgsfield_cancel_batch は廃止)。ここでは楽観カードをローカルで cancelled に
    // するだけにする。実生成 (codex exec) は別プロセスで進むが、結果は破棄されカードには出ない。
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
        for (let i = 0; i < batch.workers.length; i++) {
          const w = batch.workers[i];
          if (w.status !== "completed" && w.status !== "failed") {
            const path = e.generatedPaths[i];
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
}));

/** batch の workers 配列から実際の稼働数・完了数を数えてパネルへ反映する。 */
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
