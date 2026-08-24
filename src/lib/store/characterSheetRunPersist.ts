import type { SheetBackground, SheetCutState, SheetPromptMode } from "../character/types";
import {
  INITIAL_DRAFT,
  type CharacterSheetRunMode,
  type RegisterStep,
  type SheetJob,
  type SheetJobInput,
} from "./characterSheetRun";
import { createPersistGuard, type KeyValueStore } from "./persistGuard";

export const CHARACTER_SHEET_RUN_STORE_FILE = "character-sheet-run.json";

export type CharacterSheetRunSnapshot = {
  version: 1;
  mode: CharacterSheetRunMode;
  step: RegisterStep;
  characterName: string;
  characterImagePaths: string[];
  attributes: string;
  aspectRatio: string;
  sheetPromptMode: SheetPromptMode;
  customSheetPrompt: string;
  sheetBackground: SheetBackground;
  regenerateTargetPresetId: string | null;
  jobs: Record<string, SheetJob>;
  jobOrder: string[];
  focusedJobId: string | null;
  savedAt: number;
};

type CharacterSheetRunSnapshotSource = Omit<
  CharacterSheetRunSnapshot,
  "version" | "savedAt"
>;

type CharacterSheetDraftState = Pick<
  CharacterSheetRunSnapshotSource,
  | "jobOrder"
  | "characterName"
  | "characterImagePaths"
  | "attributes"
  | "aspectRatio"
  | "sheetPromptMode"
  | "customSheetPrompt"
  | "sheetBackground"
  | "regenerateTargetPresetId"
>;

const INTERRUPTED_REASON = "アプリ終了により中断されました";

/** 復元時に保存済み下書きで置き換えてよい、未編集の初期状態かを判定する。 */
export function isDraftPristine(state: CharacterSheetDraftState): boolean {
  return (
    state.jobOrder.length === 0 &&
    state.characterName === INITIAL_DRAFT.characterName &&
    state.characterImagePaths.length === INITIAL_DRAFT.characterImagePaths.length &&
    state.attributes === INITIAL_DRAFT.attributes &&
    state.aspectRatio === INITIAL_DRAFT.aspectRatio &&
    state.sheetPromptMode === INITIAL_DRAFT.sheetPromptMode &&
    state.customSheetPrompt === INITIAL_DRAFT.customSheetPrompt &&
    state.sheetBackground === INITIAL_DRAFT.sheetBackground &&
    state.regenerateTargetPresetId === INITIAL_DRAFT.regenerateTargetPresetId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMode(value: unknown): value is CharacterSheetRunMode {
  return value === null || value === "character" || value === "expression";
}

function isStep(value: unknown): value is RegisterStep {
  return value === 1 || value === 2 || value === 3;
}

function isPromptMode(value: unknown): value is SheetPromptMode {
  return value === "default" || value === "custom";
}

function isBackground(value: unknown): value is SheetBackground {
  return value === "auto" || value === "white" || value === "green" || value === "blue";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validateJobInput(value: unknown): string | null {
  if (!isRecord(value)) return "ジョブ入力がオブジェクトではありません";
  if (typeof value.characterName !== "string") return "ジョブのキャラ名が文字列ではありません";
  if (!isStringArray(value.characterImagePaths)) {
    return "ジョブの参照画像一覧が文字列配列ではありません";
  }
  if (typeof value.attributes !== "string") return "ジョブの属性が文字列ではありません";
  if (typeof value.aspectRatio !== "string") return "ジョブの縦横比が文字列ではありません";
  if (!isPromptMode(value.sheetPromptMode)) return "ジョブのシート作成モードが不正です";
  if (typeof value.customSheetPrompt !== "string") {
    return "ジョブのカスタム指示が文字列ではありません";
  }
  if (!isBackground(value.sheetBackground)) return "ジョブの背景設定が不正です";
  if (!isNullableString(value.regenerateTargetPresetId)) {
    return "ジョブの作り直し対象が不正です";
  }
  return null;
}

function validateCut(value: unknown): string | null {
  if (!isRecord(value)) return "カットがオブジェクトではありません";
  if (typeof value.cutId !== "string") return "カットIDが文字列ではありません";
  if (typeof value.label !== "string") return "カット名が文字列ではありません";
  if (typeof value.role !== "string") return "カットの役割が文字列ではありません";
  if (
    value.status !== "pending" &&
    value.status !== "running" &&
    value.status !== "completed" &&
    value.status !== "failed"
  ) {
    return "カットの状態が不正です";
  }
  if (value.imagePath !== undefined && typeof value.imagePath !== "string") {
    return "カット画像の保存先が文字列ではありません";
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return "カットの失敗理由が文字列ではありません";
  }
  return null;
}

function validateJob(value: unknown): string | null {
  if (!isRecord(value)) return "ジョブがオブジェクトではありません";
  if (typeof value.jobId !== "string") return "ジョブIDが文字列ではありません";
  if (value.jobMode !== "character" && value.jobMode !== "expression") {
    return "ジョブのモードが不正です";
  }
  if (typeof value.activeRunId !== "string") return "run IDが文字列ではありません";

  const inputReason = validateJobInput(value.input);
  if (inputReason) return inputReason;

  if (!isRecord(value.cuts)) return "ジョブのカット一覧がオブジェクトではありません";
  for (const cut of Object.values(value.cuts)) {
    const cutReason = validateCut(cut);
    if (cutReason) return cutReason;
  }
  if (!isStringArray(value.cutOrder)) return "ジョブのカット順が文字列配列ではありません";
  if (!isRecord(value.cutStartedAt)) return "カット開始時刻がオブジェクトではありません";
  for (const startedAt of Object.values(value.cutStartedAt)) {
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
      return "カット開始時刻が数値ではありません";
    }
  }
  if (
    value.status !== "running" &&
    value.status !== "completed" &&
    value.status !== "failed"
  ) {
    return "ジョブの状態が不正です";
  }
  if (
    value.slotPhase !== "unknown" &&
    value.slotPhase !== "queued" &&
    value.slotPhase !== "active"
  ) {
    return "ジョブの生成枠状態が不正です";
  }
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) {
    return "ジョブ作成時刻が数値ではありません";
  }
  return null;
}

function cloneCut(cut: SheetCutState): SheetCutState {
  return { ...cut };
}

function cloneJobInput(input: SheetJobInput): SheetJobInput {
  return {
    ...input,
    characterImagePaths: [...input.characterImagePaths],
  };
}

function cloneJob(job: SheetJob): SheetJob {
  const cuts: Record<string, SheetCutState> = {};
  for (const [cutId, cut] of Object.entries(job.cuts)) {
    cuts[cutId] = cloneCut(cut);
  }
  return {
    ...job,
    input: cloneJobInput(job.input),
    cuts,
    cutOrder: [...job.cutOrder],
    cutStartedAt: { ...job.cutStartedAt },
  };
}

function cloneJobs(jobs: Record<string, SheetJob>): Record<string, SheetJob> {
  const cloned: Record<string, SheetJob> = {};
  for (const [jobId, job] of Object.entries(jobs)) {
    cloned[jobId] = cloneJob(job);
  }
  return cloned;
}

export function snapshotCharacterSheetRun(
  state: CharacterSheetRunSnapshotSource,
): CharacterSheetRunSnapshot {
  return {
    version: 1,
    mode: state.mode,
    step: state.step,
    characterName: state.characterName,
    characterImagePaths: [...state.characterImagePaths],
    attributes: state.attributes,
    aspectRatio: state.aspectRatio,
    sheetPromptMode: state.sheetPromptMode,
    customSheetPrompt: state.customSheetPrompt,
    sheetBackground: state.sheetBackground,
    regenerateTargetPresetId: state.regenerateTargetPresetId,
    jobs: cloneJobs(state.jobs),
    jobOrder: [...state.jobOrder],
    focusedJobId: state.focusedJobId,
    savedAt: Date.now(),
  };
}

export function parseCharacterSheetRunSnapshot(
  raw: unknown,
): { ok: true; value: CharacterSheetRunSnapshot } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "作業状態がオブジェクトではありません" };
  if (raw.version !== 1) return { ok: false, reason: "作業状態のバージョンが不正です" };
  if (!isMode(raw.mode)) return { ok: false, reason: "作業モードが不正です" };
  if (!isStep(raw.step)) return { ok: false, reason: "作業ステップが不正です" };
  if (typeof raw.characterName !== "string") {
    return { ok: false, reason: "キャラ名が文字列ではありません" };
  }
  if (!isStringArray(raw.characterImagePaths)) {
    return { ok: false, reason: "参照画像一覧が文字列配列ではありません" };
  }
  if (typeof raw.attributes !== "string") {
    return { ok: false, reason: "属性が文字列ではありません" };
  }
  if (typeof raw.aspectRatio !== "string") {
    return { ok: false, reason: "縦横比が文字列ではありません" };
  }
  if (!isPromptMode(raw.sheetPromptMode)) {
    return { ok: false, reason: "シート作成モードが不正です" };
  }
  if (typeof raw.customSheetPrompt !== "string") {
    return { ok: false, reason: "カスタム指示が文字列ではありません" };
  }
  if (!isBackground(raw.sheetBackground)) {
    return { ok: false, reason: "背景設定が不正です" };
  }
  if (!isNullableString(raw.regenerateTargetPresetId)) {
    return { ok: false, reason: "作り直し対象が不正です" };
  }
  if (!isRecord(raw.jobs)) {
    return { ok: false, reason: "ジョブ台帳がオブジェクトではありません" };
  }
  const rawJobs = raw.jobs;
  for (const [jobId, job] of Object.entries(rawJobs)) {
    const jobReason = validateJob(job);
    if (jobReason) return { ok: false, reason: `ジョブ ${jobId}: ${jobReason}` };
    if ((job as Record<string, unknown>).jobId !== jobId) {
      return { ok: false, reason: `ジョブ ${jobId}: 台帳キーとジョブIDが一致しません` };
    }
  }
  if (!isStringArray(raw.jobOrder)) {
    return { ok: false, reason: "ジョブ順が文字列配列ではありません" };
  }
  const jobIds = Object.keys(rawJobs);
  const orderedJobIds = new Set(raw.jobOrder);
  if (
    orderedJobIds.size !== raw.jobOrder.length ||
    jobIds.length !== raw.jobOrder.length ||
    raw.jobOrder.some((jobId) => !(jobId in rawJobs))
  ) {
    return { ok: false, reason: "ジョブ台帳とジョブ順が一致しません" };
  }
  if (!isNullableString(raw.focusedJobId)) {
    return { ok: false, reason: "選択中ジョブIDが不正です" };
  }
  if (raw.focusedJobId !== null && !(raw.focusedJobId in rawJobs)) {
    return { ok: false, reason: "選択中ジョブが台帳にありません" };
  }
  if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) {
    return { ok: false, reason: "保存時刻が数値ではありません" };
  }

  return {
    ok: true,
    value: {
      version: 1,
      mode: raw.mode,
      step: raw.step,
      characterName: raw.characterName,
      characterImagePaths: [...raw.characterImagePaths],
      attributes: raw.attributes,
      aspectRatio: raw.aspectRatio,
      sheetPromptMode: raw.sheetPromptMode,
      customSheetPrompt: raw.customSheetPrompt,
      sheetBackground: raw.sheetBackground,
      regenerateTargetPresetId: raw.regenerateTargetPresetId,
      jobs: cloneJobs(rawJobs as Record<string, SheetJob>),
      jobOrder: [...raw.jobOrder],
      focusedJobId: raw.focusedJobId,
      savedAt: raw.savedAt,
    },
  };
}

export function normalizeSnapshotOnLoad(
  snapshot: CharacterSheetRunSnapshot,
): CharacterSheetRunSnapshot {
  const jobs: Record<string, SheetJob> = {};
  for (const [jobId, job] of Object.entries(snapshot.jobs)) {
    if (job.status !== "running") {
      jobs[jobId] = job;
      continue;
    }

    const cuts: Record<string, SheetCutState> = {};
    for (const [cutId, cut] of Object.entries(job.cuts)) {
      cuts[cutId] =
        cut.status === "pending" || cut.status === "running"
          ? { ...cut, status: "failed", reason: INTERRUPTED_REASON }
          : cut;
    }
    jobs[jobId] = {
      ...job,
      cuts,
      status: "failed",
      slotPhase: "unknown",
    };
  }
  return { ...snapshot, jobs };
}

export function createCharacterSheetRunGuard(
  loadStore?: () => Promise<KeyValueStore | null>,
) {
  return createPersistGuard<CharacterSheetRunSnapshot>({
    name: "characterSheetRun",
    file: CHARACTER_SHEET_RUN_STORE_FILE,
    key: "state",
    parse: parseCharacterSheetRunSnapshot,
    ...(loadStore ? { loadStore } : {}),
  });
}

export const characterSheetRunGuard = createCharacterSheetRunGuard();
