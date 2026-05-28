import { create } from "zustand";
import { higgsfield, type ImageBatchEvent, type ImageBatchProvider } from "../ipc";

// ──────────── Types ────────────

// P0-1 mediaType 導入 (2026-05-28 動画タブ準備)
export type MediaType = "image" | "video";

export type BatchWorker =
  | {
      idx: number;
      status: "pending" | "running";
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
        modelJobSetType: workerModels?.[i]?.jobSetType,
        modelDisplayName: workerModels?.[i]?.displayName,
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
    set((s) => ({
      batches: s.batches.map((b) =>
        b.batchId === batchId && b.status === "running"
          ? { ...b, status: "cancelling" }
          : b,
      ),
    }));
    try {
      await higgsfield.cancelBatch(batchId);
    } catch (error) {
      set((s) => ({
        batches: s.batches.map((b) =>
          b.batchId === batchId && b.status === "cancelling"
            ? { ...b, status: "running" }
            : b,
        ),
      }));
      throw error;
    }
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
          batch.workers[wi] = {
            idx: e.idx,
            status: "running",
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

      const next = [...batches];
      next[idx] = batch;
      return { batches: next };
    });
  },
}));

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.batches = useBatches;
}
