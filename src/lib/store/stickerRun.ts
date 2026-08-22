import { create } from "zustand";

import { onCharacterSheetEvent } from "../character/events";
import type { StickerChromaSample } from "../ipc";
import type { StickerEntry } from "../sticker/catalog";
import { formatStickerGenerationFailure } from "../sticker/referenceSnapshot";
import {
  DEFAULT_STICKER_TEXT,
  type StickerTextSpec,
} from "../sticker/text";
import { humanizeError } from "../humanizeError";
import { useToasts } from "./toasts";

export type StickerPhase = "setup" | "generate" | "pick" | "export";

export type StickerCutState = {
  index: number;
  entry: StickerEntry;
  status: "pending" | "running" | "cuttingOut" | "completed" | "failed";
  imagePath?: string;
  reason?: string;
};

export type StickerEventSubscriptionStatus = "connecting" | "ready" | "failed";
type StateUpdate<T> = T | ((previous: T) => T);

type WaveProgress = {
  expectedCutIds: Set<string>;
  settledCutIds: Set<string>;
  failedCutIds: Set<string>;
  failureReasons: Map<string, string>;
};

type StickerRunState = {
  phase: StickerPhase;
  cuts: StickerCutState[];
  running: boolean;
  eventSubscriptionStatus: StickerEventSubscriptionStatus;
  generationStartedAt: number;
  notClearedPaths: ReadonlySet<string>;
  /** 文字入れ画面を離れても、入力・見た目・文字なし原本を失わない。 */
  stickerTexts: Readonly<Record<number, string>>;
  stickerTextStyle: Omit<StickerTextSpec, "text">;
  stickerTextBasePaths: Readonly<Record<number, string>>;
  setPhase: (update: StateUpdate<StickerPhase>) => void;
  setCuts: (update: StateUpdate<StickerCutState[]>) => void;
  setGenerationStartedAt: (update: StateUpdate<number>) => void;
  setNotClearedPaths: (update: StateUpdate<ReadonlySet<string>>) => void;
  setStickerTexts: (update: StateUpdate<Readonly<Record<number, string>>>) => void;
  setStickerTextStyle: (update: StateUpdate<Omit<StickerTextSpec, "text">>) => void;
  setStickerTextBasePaths: (
    update: StateUpdate<Readonly<Record<number, string>>>,
  ) => void;
  resetStickerTextState: () => void;
};

function resolveUpdate<T>(previous: T, update: StateUpdate<T>): T {
  return typeof update === "function"
    ? (update as (value: T) => T)(previous)
    : update;
}

export const useStickerRun = create<StickerRunState>((set) => ({
  phase: "setup",
  cuts: [],
  running: false,
  eventSubscriptionStatus: "connecting",
  generationStartedAt: Date.now(),
  notClearedPaths: new Set(),
  stickerTexts: {},
  stickerTextStyle: { ...DEFAULT_STICKER_TEXT },
  stickerTextBasePaths: {},
  setPhase: (update) => set((state) => ({ phase: resolveUpdate(state.phase, update) })),
  setCuts: (update) => set((state) => ({ cuts: resolveUpdate(state.cuts, update) })),
  setGenerationStartedAt: (update) =>
    set((state) => ({ generationStartedAt: resolveUpdate(state.generationStartedAt, update) })),
  setNotClearedPaths: (update) =>
    set((state) => ({ notClearedPaths: resolveUpdate(state.notClearedPaths, update) })),
  setStickerTexts: (update) =>
    set((state) => ({ stickerTexts: resolveUpdate(state.stickerTexts, update) })),
  setStickerTextStyle: (update) =>
    set((state) => ({ stickerTextStyle: resolveUpdate(state.stickerTextStyle, update) })),
  setStickerTextBasePaths: (update) =>
    set((state) => ({
      stickerTextBasePaths: resolveUpdate(state.stickerTextBasePaths, update),
    })),
  resetStickerTextState: () =>
    set({
      stickerTexts: {},
      stickerTextStyle: { ...DEFAULT_STICKER_TEXT },
      stickerTextBasePaths: {},
    }),
}));

/** タブを離れても必要な、ディスク保存しない実行中メモリ。 */
export const stickerRunMemory = {
  chromaStats: new Map<string, StickerChromaSample>(),
  fringeWarnPaths: new Set<string>(),
  cutoutMethods: new Map<string, "ai" | "chroma" | "none">(),
};

const runIds = new Set<string>();
const waveWaiters = new Map<string, () => void>();
const waveProgress = new Map<string, WaveProgress>();
const cutoutWaits = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; reject: (reason: Error) => void }
>();
const completedGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

let listenerPromise: Promise<void> | null = null;
let cutOutHandler: ((imagePath: string) => Promise<string>) | null = null;

const CUTOUT_TIMEOUT_MS = 90_000;
const COMPLETED_GRACE_MS = 10_000;

function cutoutTimerKey(runId: string, cutId: string): string {
  return `${runId}\u0000${cutId}`;
}

function isWaveCutPending(runId: string, cutId: string): boolean {
  const progress = waveProgress.get(runId);
  return Boolean(
    progress
    && progress.expectedCutIds.has(cutId)
    && !progress.settledCutIds.has(cutId),
  );
}

function cutOutWithTimeout(
  runId: string,
  cutId: string,
  task: Promise<string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = cutoutTimerKey(runId, cutId);
    const wait = {
      timer: setTimeout(() => {
        if (cutoutWaits.get(key) !== wait) return;
        cutoutWaits.delete(key);
        reject(new Error("背景の切り抜きが90秒以内に終わりませんでした"));
      }, CUTOUT_TIMEOUT_MS),
      reject,
    };
    cutoutWaits.set(key, wait);

    void task.then(
      (path) => {
        if (cutoutWaits.get(key) !== wait) return;
        cutoutWaits.delete(key);
        clearTimeout(wait.timer);
        resolve(path);
      },
      (error) => {
        if (cutoutWaits.get(key) !== wait) return;
        cutoutWaits.delete(key);
        clearTimeout(wait.timer);
        reject(error);
      },
    );
  });
}

function cancelCutoutWait(runId: string, cutId: string): void {
  const key = cutoutTimerKey(runId, cutId);
  const wait = cutoutWaits.get(key);
  if (!wait) return;
  cutoutWaits.delete(key);
  clearTimeout(wait.timer);
  wait.reject(new Error("背景の切り抜き待ちを終了しました"));
}

function releaseWave(runId: string): void {
  const resolve = waveWaiters.get(runId);
  if (!resolve) return;

  const progress = waveProgress.get(runId);
  const graceTimer = completedGraceTimers.get(runId);
  if (graceTimer) clearTimeout(graceTimer);
  completedGraceTimers.delete(runId);
  if (progress) {
    for (const cutId of progress.expectedCutIds) cancelCutoutWait(runId, cutId);
  }
  waveWaiters.delete(runId);
  waveProgress.delete(runId);
  if (progress && progress.failedCutIds.size > 0) {
    useToasts.getState().push({
      kind: "error",
      text: formatStickerGenerationFailure(
        progress.failedCutIds.size,
        Array.from(progress.failureReasons.values()),
      ),
      ttlMs: 6000,
    });
  }
  resolve();
}

function settleWaveCut(runId: string, cutId: string, failed: boolean, reason?: string): void {
  const progress = waveProgress.get(runId);
  if (!progress) return;

  if (progress.expectedCutIds.has(cutId)) {
    progress.settledCutIds.add(cutId);
    if (failed) {
      progress.failedCutIds.add(cutId);
      if (reason) progress.failureReasons.set(cutId, reason);
    }
  } else if (failed) {
    for (const expectedCutId of progress.expectedCutIds) {
      progress.settledCutIds.add(expectedCutId);
      progress.failedCutIds.add(expectedCutId);
      if (reason) progress.failureReasons.set(expectedCutId, reason);
    }
  }

  if (progress.settledCutIds.size >= progress.expectedCutIds.size) {
    releaseWave(runId);
  }
}

const handleEvent: Parameters<typeof onCharacterSheetEvent>[0] = (event) => {
  if (!runIds.has(event.runId)) return;
  const setCuts = useStickerRun.getState().setCuts;

  if (event.kind === "cutStarted") {
    setCuts((previous) =>
      previous.map((cut) =>
        cut.entry.id === event.cutId ? { ...cut, status: "running" } : cut,
      ),
    );
    return;
  }

  if (event.kind === "cutCompleted") {
    const cutId = event.cutId;
    if (!isWaveCutPending(event.runId, cutId)) return;
    if (cutoutWaits.has(cutoutTimerKey(event.runId, cutId))) return;
    if (!cutOutHandler) return;
    setCuts((previous) =>
      previous.map((cut) =>
        cut.entry.id === cutId ? { ...cut, status: "cuttingOut" } : cut,
      ),
    );
    void cutOutWithTimeout(event.runId, cutId, cutOutHandler(event.imagePath))
      .then((cutPath) => {
        if (!isWaveCutPending(event.runId, cutId)) return;
        useStickerRun.getState().setCuts((previous) =>
          previous.map((cut) =>
            cut.entry.id === cutId
              ? { ...cut, status: "completed", imagePath: cutPath }
              : cut,
          ),
        );
        settleWaveCut(event.runId, cutId, false);
      })
      .catch((error) => {
        if (!isWaveCutPending(event.runId, cutId)) return;
        const reason = humanizeError(error);
        useStickerRun.getState().setCuts((previous) =>
          previous.map((cut) =>
            cut.entry.id === cutId
              ? { ...cut, status: "failed", reason: `背景の切り抜き失敗: ${reason}` }
              : cut,
          ),
        );
        settleWaveCut(event.runId, cutId, true, `背景の切り抜き失敗: ${reason}`);
        useToasts.getState().push({
          kind: "error",
          text: `背景の切り抜きに失敗しました。理由: ${reason}。この1枚をもう一度お試しください。`,
          ttlMs: 6000,
        });
      });
    return;
  }

  if (event.kind === "cutFailed") {
    const progress = waveProgress.get(event.runId);
    const failedCutIds =
      progress && !progress.expectedCutIds.has(event.cutId)
        ? progress.expectedCutIds
        : new Set([event.cutId]);
    for (const cutId of failedCutIds) cancelCutoutWait(event.runId, cutId);
    setCuts((previous) =>
      previous.map((cut) =>
        failedCutIds.has(cut.entry.id)
          ? { ...cut, status: "failed", reason: event.reason }
          : cut,
      ),
    );
    settleWaveCut(event.runId, event.cutId, true, event.reason);
    return;
  }

  if (event.kind !== "completed") return;
  const progress = waveProgress.get(event.runId);
  if (!progress || completedGraceTimers.has(event.runId)) return;
  const timer = setTimeout(() => {
    completedGraceTimers.delete(event.runId);
    const current = waveProgress.get(event.runId);
    if (!current) return;
    const unsettledCutIds = Array.from(current.expectedCutIds).filter(
      (cutId) => !current.settledCutIds.has(cutId),
    );
    if (unsettledCutIds.length === 0) {
      releaseWave(event.runId);
      return;
    }
    const unsettled = new Set(unsettledCutIds);
    for (const cutId of unsettled) {
      cancelCutoutWait(event.runId, cutId);
      current.settledCutIds.add(cutId);
      current.failedCutIds.add(cutId);
      current.failureReasons.set(cutId, "全体完了後も処理結果を受け取れませんでした");
    }
    useStickerRun.getState().setCuts((previous) =>
      previous.map((cut) =>
        unsettled.has(cut.entry.id)
          ? {
              ...cut,
              status: "failed",
              reason: "全体完了後も処理結果を受け取れませんでした",
            }
          : cut,
      ),
    );
    releaseWave(event.runId);
  }, COMPLETED_GRACE_MS);
  completedGraceTimers.set(event.runId, timer);
};

export function ensureStickerRunEventListener(
  cutOut: (imagePath: string) => Promise<string>,
): Promise<void> {
  cutOutHandler ??= cutOut;
  if (listenerPromise) return listenerPromise;
  listenerPromise = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await onCharacterSheetEvent(handleEvent);
        useStickerRun.setState({ eventSubscriptionStatus: "ready" });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    useStickerRun.setState({ eventSubscriptionStatus: "failed" });
    useToasts.getState().push({
      kind: "error",
      text: `進捗を受け取れない状態です。アプリを再起動してください。（詳しい内容: ${humanizeError(lastError)}）`,
      ttlMs: 6000,
    });
    throw lastError;
  })();
  return listenerPromise;
}

export function beginStickerWave(runId: string, expectedCutIds: string[]): Promise<void> {
  runIds.add(runId);
  waveProgress.set(runId, {
    expectedCutIds: new Set(expectedCutIds),
    settledCutIds: new Set(),
    failedCutIds: new Set(),
    failureReasons: new Map(),
  });
  return new Promise((resolve) => {
    waveWaiters.set(runId, resolve);
  });
}

export function discardStickerWave(runId: string): void {
  waveWaiters.delete(runId);
  waveProgress.delete(runId);
}

export function tryBeginStickerGeneration(): boolean {
  if (useStickerRun.getState().running) return false;
  useStickerRun.setState({ running: true });
  return true;
}

export function endStickerGeneration(): void {
  useStickerRun.setState({ running: false });
}
