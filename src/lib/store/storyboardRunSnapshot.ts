/**
 * owt: run 状態のディスクスナップショット (読み取り専用の過去 run 復元用)。
 *
 * 走行中の run 状態を out_dir/run-state.json へ定期永続化し、アプリが落ちても
 * 「過去 run」として読み返せるようにする。**active run への復元はしない** —
 * backend の orchestrator は死んでおりイベントは二度と来ないため、復元しても
 * 操作できる状態にはならない (rr2 の restoreAdoptions と同じ設計判断)。
 *
 * ipc.ts は本 Wave で編集禁止のため、invoke は `@tauri-apps/api/core` を直呼びする
 * (motionStore.ts と同じ流儀)。
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  SceneGroup,
  StoryboardChatMessage,
  StoryboardGoal,
  StoryboardPhase,
  StoryboardRunParams,
  StoryboardSketchCut,
  StoryboardSketchVersion,
} from "../storyboard/types";
import {
  useStoryboardRun,
  type CutState,
  type PastRunSummary,
} from "./storyboardRun";

/** チャットログの保存上限。これを超えたら古い順に捨てる (肥大防止)。 */
const CHAT_MESSAGE_LIMIT = 200;

/** 通常書き込みのデバウンス (ms)。 */
const SNAPSHOT_DEBOUNCE_MS = 2000;

/**
 * ディスクに置く run スナップショット。`debugLog` は含めない
 * (肥大源であり、復元して見る価値が無い)。
 * Map は entries 配列に落として直列化する (順序が保存される)。
 */
export type RunSnapshotV1 = {
  version: 1;
  runId: string;
  savedAt: number;
  params: StoryboardRunParams | null;
  phase: StoryboardPhase;
  status: string;
  totalCuts: number;
  startedAt: number | null;
  lastEventAt: number | null;
  manifestPath: string | null;
  goal: StoryboardGoal | null;
  chatMessages: StoryboardChatMessage[];
  sketchVersions: StoryboardSketchVersion[];
  activeSketchVersionId: string | null;
  cuts: [string, CutState][];
  sketchCuts: [string, CutState][];
  sceneGroups: SceneGroup[];
  cutDisplayOrder: string[] | null;
  keyVisualPath: string | null;
  generationCutSketchMeta: Record<string, StoryboardSketchCut>;
};

/** 終端 (これ以上イベントが来ない) とみなす status。即時書き込みの契機。 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function buildSnapshot(runId: string): RunSnapshotV1 {
  const s = useStoryboardRun.getState();
  return {
    version: 1,
    runId,
    savedAt: Date.now(),
    params: s.params,
    phase: s.phase,
    status: s.status,
    totalCuts: s.totalCuts,
    startedAt: s.generationRunStartedAt ?? s.sketchRunStartedAt ?? null,
    lastEventAt: s.lastEventAt,
    manifestPath: s.manifestPath,
    goal: s.goal,
    // 古い順に捨てて直近 CHAT_MESSAGE_LIMIT 件だけ残す。
    chatMessages: s.chatMessages.slice(-CHAT_MESSAGE_LIMIT),
    sketchVersions: s.sketchVersions,
    activeSketchVersionId: s.activeSketchVersionId,
    cuts: Array.from(s.cuts.entries()),
    sketchCuts: Array.from(s.sketchCuts.entries()),
    sceneGroups: s.sceneGroups,
    cutDisplayOrder: s.cutDisplayOrder,
    keyVisualPath: s.keyVisualPath,
    generationCutSketchMeta: s.generationCutSketchMeta,
  };
}

/**
 * best-effort 書き込み。失敗は console.warn のみ。
 *
 * なぜトーストを出さないか: これは保全機能であって、失敗しても生成フロー本体は
 * 正常に続く。ここで騒ぐと「本題と関係ないエラー」でユーザーの注意を奪う。
 */
async function writeSnapshot(runId: string): Promise<void> {
  try {
    const content = JSON.stringify(buildSnapshot(runId));
    await invoke("storyboard_write_run_snapshot", { runId, content });
  } catch (err) {
    console.warn("[owt] run スナップショットの保存に失敗:", err);
  }
}

let writerStarted = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastPhase: StoryboardPhase | null = null;
let lastStatus: string | null = null;

function scheduleWrite(runId: string): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void writeSnapshot(runId);
  }, SNAPSHOT_DEBOUNCE_MS);
}

function flushWrite(runId: string): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  void writeSnapshot(runId);
}

/**
 * run 状態の永続化を開始する。二重購読しない (モジュールレベルの started フラグ)。
 *
 * 通常は 2 秒デバウンス。status が terminal になった時と phase が遷移した時だけ
 * 即時に書く (落ちる直前の状態を確実に残すため)。
 */
export function startRunSnapshotWriter(): void {
  if (writerStarted) return;
  writerStarted = true;

  useStoryboardRun.subscribe((state) => {
    const runId = state.activeRunId;
    if (!runId) return;

    const phaseChanged = lastPhase !== null && lastPhase !== state.phase;
    const statusChanged = lastStatus !== null && lastStatus !== state.status;
    lastPhase = state.phase;
    lastStatus = state.status;

    if (phaseChanged || (statusChanged && TERMINAL_STATUSES.has(state.status))) {
      flushWrite(runId);
      return;
    }
    scheduleWrite(runId);
  });
}

/** version が想定外のスナップショットを判別する。 */
function parseSnapshot(raw: string): RunSnapshotV1 | "unsupported" | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<RunSnapshotV1>;
  if (candidate.version !== 1) return "unsupported";
  if (typeof candidate.runId !== "string" || !candidate.runId) return null;
  return candidate as RunSnapshotV1;
}

/** ビューア用のフル取得。無ければ null。 */
export async function readRunSnapshot(
  runId: string,
): Promise<RunSnapshotV1 | null> {
  try {
    const raw = await invoke<string>("storyboard_read_run_snapshot", { runId });
    const parsed = parseSnapshot(raw);
    if (parsed === null) return null;
    if (parsed === "unsupported") {
      console.warn(`[owt] 未対応バージョンの run スナップショット: ${runId}`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn("[owt] run スナップショットの読み込みに失敗:", err);
    return null;
  }
}

type RunSnapshotMeta = { runId: string; modifiedEpochMs: number };

/** ディスク由来のスナップショットが存在する runId 集合 (ビューアを開けるかの判定用)。 */
const snapshotRunIds = new Set<string>();

export function hasDiskSnapshot(runId: string): boolean {
  return snapshotRunIds.has(runId);
}

function summarize(snapshot: RunSnapshotV1): PastRunSummary {
  const cuts = snapshot.cuts ?? [];
  const confirmedCuts = cuts.filter(
    ([, cut]) => cut?.status === "confirmed",
  ).length;
  return {
    runId: snapshot.runId,
    startedAt: snapshot.startedAt ?? snapshot.savedAt ?? 0,
    finishedAt: TERMINAL_STATUSES.has(snapshot.status)
      ? (snapshot.savedAt ?? null)
      : null,
    status: snapshot.status as PastRunSummary["status"],
    totalCuts: snapshot.totalCuts ?? cuts.length,
    confirmedCuts,
    manifestPath: snapshot.manifestPath ?? null,
    storyDigest:
      snapshot.goal?.summary?.slice(0, 80) ??
      snapshot.params?.storyPrompt?.slice(0, 80) ??
      "(概要なし)",
  };
}

let hydrated = false;

/**
 * ディスク上のスナップショットを既存 `pastRuns` へマージする。
 *
 * 重複は runId で排除し、**セッション内のエントリを優先**する
 * (メモリ上の方が新しく、採用数などが正確なため)。
 */
export async function hydratePastRunsFromDisk(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  let metas: RunSnapshotMeta[] = [];
  try {
    metas = await invoke<RunSnapshotMeta[]>("storyboard_list_run_snapshots");
  } catch (err) {
    console.warn("[owt] run スナップショット一覧の取得に失敗:", err);
    return;
  }

  const summaries: PastRunSummary[] = [];
  let unsupported = 0;
  for (const meta of metas) {
    let raw: string;
    try {
      raw = await invoke<string>("storyboard_read_run_snapshot", {
        runId: meta.runId,
      });
    } catch (err) {
      console.warn(`[owt] run スナップショット読込失敗 (${meta.runId}):`, err);
      continue;
    }
    const parsed = parseSnapshot(raw);
    if (parsed === null) continue;
    if (parsed === "unsupported") {
      unsupported += 1;
      continue;
    }
    snapshotRunIds.add(parsed.runId);
    summaries.push(summarize(parsed));
  }
  if (unsupported > 0) {
    console.warn(
      `[owt] 未対応バージョンの run スナップショットを ${unsupported} 件スキップしました`,
    );
  }
  if (summaries.length === 0) return;

  useStoryboardRun.setState((s) => {
    const seen = new Set(s.pastRuns.map((p) => p.runId));
    // 走行中の run はまだ「過去」ではないので混ぜない。
    if (s.activeRunId) seen.add(s.activeRunId);
    const merged = [
      ...s.pastRuns,
      ...summaries.filter((p) => !seen.has(p.runId)),
    ];
    return { pastRuns: merged };
  });
}
