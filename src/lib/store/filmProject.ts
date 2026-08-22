import { create } from "zustand";

import { filmProjects } from "../ipc";
import {
  normalizeFilmAsset,
  recoverInterruptedFilmAsset,
} from "../film/assetFactory";
import { validateAssetLedger } from "../film/assetParse";
import { DEFAULT_VIDEO_SERVICE_ID } from "../film/serviceProfiles";
import type {
  AssetLedgerEntry,
  AssetType,
  FilmBlock,
  FilmChatMessage,
  ForeshadowEntry,
  FilmPhase,
  FilmProject,
  FilmScene,
  FilmScript,
} from "../film/types";

export type FilmProjectsFileData = {
  version: 1;
  projects: FilmProject[];
  /** premise確定前の会話も、モードを閉じた後に再開するための退避欄。 */
  planningChatMessages?: FilmChatMessage[];
  /** 保存済み企画ではなく、premise確定前の相談を表示していた印。 */
  planningActive?: true;
};

export type FilmProjectsFileState = "ok" | "missing" | "corrupted" | "unreadable";

export type FilmScriptApprovalStage =
  | "logline"
  | "beatsheet"
  | "treatment"
  | "scenelist"
  | "blocks";

export type FilmScriptSettings = {
  targetDurationSeconds: number;
  topicMemo: string;
  characterNames: string[];
};

export type CreateFilmProjectOptions = {
  chatMessages?: FilmChatMessage[];
  postingTarget?: string;
  scriptSettings?: FilmScriptSettings;
  startInScript?: boolean;
};

export type FilmProjectBackup = {
  path: string;
  at: number;
  count: number;
};

export type FilmProjectBackupListResult =
  | { ok: true; items: FilmProjectBackup[] }
  | { ok: false; error: string };

type FilmProjectState = {
  projects: FilmProject[];
  activeProjectId: string | null;
  planningChatMessages: FilmChatMessage[];
  filmProjectsFileState: FilmProjectsFileState;
  /** null 以外なら、画面内の最新状態がまだ正本へ保存できていない。 */
  filmProjectsSaveError: string | null;
  initialize: () => Promise<void>;
  retrySave: () => Promise<boolean>;
  listBackups: () => Promise<FilmProjectBackupListResult>;
  restoreFromBackup: (backupPath: string) => Promise<number>;
  createProject: (
    title: string,
    theme: string,
    videoServiceId: string,
    options?: CreateFilmProjectOptions,
  ) => FilmProject;
  setActiveProjectId: (projectId: string | null) => void;
  appendPlanningChatMessage: (message: FilmChatMessage) => void;
  resetPlanningChat: (messages?: FilmChatMessage[]) => void;
  appendChatMessage: (message: FilmChatMessage) => void;
  setPhase: (phase: FilmPhase) => void;
  saveScriptSettings: (settings: FilmScriptSettings) => void;
  saveLogline: (logline: string) => void;
  saveBeatsheet: (beatsheet: string) => void;
  saveTreatment: (treatment: string) => void;
  saveScenelist: (scenelistText: string, scenes: FilmScene[]) => void;
  saveSceneList: (scenelistText: string, scenes: FilmScene[]) => void;
  saveBlocks: (blockScriptText: string, blocks: FilmBlock[]) => void;
  approveStage: (stage: FilmScriptApprovalStage) => boolean;
  revokeStageApproval: (stage: FilmScriptApprovalStage) => boolean;
  saveAssets: (assets: AssetLedgerEntry[]) => void;
  updateAssetFactoryAsset: (
    assetId: string,
    update: (asset: AssetLedgerEntry) => AssetLedgerEntry,
  ) => void;
  saveForeshadow: (entries: ForeshadowEntry[]) => void;
  saveLookMaster: (path: string | null, description?: string) => void;
  saveStylePrefix: (stylePrefix: string) => void;
  approveLook: () => boolean;
};

const SCRIPT_STAGE_ORDER: FilmScriptApprovalStage[] = [
  "logline",
  "beatsheet",
  "treatment",
  "scenelist",
  "blocks",
];

function emptyScript(): FilmScript {
  return {
    logline: "",
    beatsheet: "",
    treatment: "",
    scenes: [],
    blocks: [],
    scenelistText: "",
    blockScriptText: "",
    targetDurationSeconds: 90,
    topicMemo: "",
    characterNames: [],
  };
}

function normalizeChatMessages(value: unknown): FilmChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is FilmChatMessage => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as Partial<FilmChatMessage>;
    return (
      typeof candidate.id === "string" &&
      (candidate.role === "assistant" || candidate.role === "user") &&
      typeof candidate.text === "string" &&
      typeof candidate.createdAt === "string"
    );
  });
}

function touchProject(project: FilmProject): FilmProject {
  return { ...project, updatedAt: new Date().toISOString() };
}

function scriptOf(project: FilmProject): FilmScript {
  return Array.isArray(project.script) ? emptyScript() : project.script;
}

function assetTypeFromId(id: string): AssetType {
  if (id.startsWith("CH-")) return "character";
  if (id.startsWith("LO-")) return "location";
  if (id.startsWith("TX-")) return "text";
  return "prop";
}

type StoredFilmProject = Omit<FilmProject, "assetServiceId" | "videoServiceId"> & {
  assetServiceId?: "gpt-image-2";
  videoServiceId?: string;
  /** S1で保存された旧フィールド。読み込み時だけ参照する。 */
  service?: string;
};

export function normalizeFilmProject(
  project: StoredFilmProject,
  recoverInterruptedRuns = false,
): FilmProject {
  const { service: legacyService, ...currentProject } = project;
  const videoServiceId =
    project.videoServiceId?.trim() || legacyService?.trim() || DEFAULT_VIDEO_SERVICE_ID;
  const chatMessages = normalizeChatMessages(project.chatMessages);
  return {
    ...currentProject,
    assetServiceId: "gpt-image-2",
    videoServiceId,
    // ⑤⑥は未実装。過去版の偽導線で進んだ保存データも④へ安全に戻す。
    phase: project.phase >= 5 ? 4 : project.phase,
    approvals: {
      ...project.approvals,
      blocks: project.approvals.blocks ?? null,
      look: project.approvals.look ?? null,
    },
    assets: (project.assets ?? []).map((asset) => {
      const normalizedSource = {
        ...asset,
        type: asset.type ?? assetTypeFromId(asset.id),
        status: asset.status ?? "unplanned",
        pairKey: asset.pairKey ?? null,
        pairSide: asset.pairSide ?? null,
      };
      return recoverInterruptedRuns
        ? recoverInterruptedFilmAsset(normalizedSource)
        : normalizeFilmAsset(normalizedSource);
    }),
    foreshadow: (project.foreshadow ?? []).map((entry) => ({
      ...entry,
      initialMeaning: entry.initialMeaning ?? "",
      trueMeaning: entry.trueMeaning ?? "",
    })),
    stylePrefix: project.stylePrefix ?? "",
    lookMasterPath: project.lookMasterPath ?? null,
    lookMasterDescription: project.lookMasterDescription ?? "",
    chatMessages,
    postingTarget: project.postingTarget ?? "",
    updatedAt:
      project.updatedAt ?? chatMessages[chatMessages.length - 1]?.createdAt,
  };
}

function invalidateApprovalsFrom(
  project: FilmProject,
  stage: FilmScriptApprovalStage,
): FilmProject["approvals"] {
  const startIndex = SCRIPT_STAGE_ORDER.indexOf(stage);
  const approvals = { ...project.approvals, blocks: project.approvals.blocks ?? null };
  for (const stageToClear of SCRIPT_STAGE_ORDER.slice(startIndex)) {
    approvals[stageToClear] = null;
  }
  // ③設計の見た目承認も脚本の上に建つため、脚本変更時は無効にする。
  approvals.look = null;
  return approvals;
}

async function writeToFileNow(
  data: FilmProjectsFileData,
  allowEmpty: boolean,
): Promise<void> {
  await filmProjects.write(JSON.stringify(data), allowEmpty);
}

/** 全量スナップショットを直列化する、最後勝ちの保存キュー。 */
let pendingWrite: { data: FilmProjectsFileData; allowEmpty: boolean } | null = null;
let writeInFlight: Promise<boolean> | null = null;
let reportSaveError: (error: string | null) => void = () => {};

function writeToFile(
  data: FilmProjectsFileData,
  allowEmpty = false,
): Promise<boolean> {
  pendingWrite = { data, allowEmpty };
  if (!writeInFlight) {
    const run = (async (): Promise<boolean> => {
      let lastOk = true;
      while (pendingWrite) {
        const job = pendingWrite;
        pendingWrite = null;
        try {
          await writeToFileNow(job.data, job.allowEmpty);
          reportSaveError(null);
          lastOk = true;
        } catch (error) {
          console.error("[film-projects] ファイル書き込み失敗:", error);
          reportSaveError(String(error));
          // ストア上の最新内容は消さない。後続ジョブがあれば処理を続け、
          // 無ければ画面内の「再試行」から現在の全量をもう一度保存する。
          lastOk = false;
        }
      }
      writeInFlight = null;
      return lastOk;
    })();
    writeInFlight = run;
    return run;
  }
  return writeInFlight;
}

let fileWriteUnlocked = false;
let fileReadDecided = false;
let pendingBeforeUnlock = false;
let initializeToken = 0;
let fileErrorToastShown = false;

function hasTauriInvoke(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function showFileErrorToast(reason: string): Promise<void> {
  if (fileErrorToastShown) return;
  fileErrorToastShown = true;
  try {
    const { useToasts } = await import("./toasts");
    useToasts.getState().push({
      kind: "error",
      text: `フィルムの保存ファイルが読み込めません（${reason}）。この状態では正本ファイルへ書き込みません。`,
      ttlMs: 0,
    });
  } catch (err) {
    console.error("[film-projects] 読み込み異常の通知に失敗:", err);
  }
}

function makeFileData(
  projects: FilmProject[],
  planningChatMessages: FilmChatMessage[],
  planningActive = false,
): FilmProjectsFileData {
  if (planningChatMessages.length === 0) return { version: 1, projects };
  return {
    version: 1,
    projects,
    planningChatMessages,
    ...(planningActive ? { planningActive: true as const } : {}),
  };
}

function projectNeedsHydrationRepair(project: StoredFilmProject): boolean {
  if (project.phase >= 5) return true;
  return (project.assets ?? []).some((asset) => {
    if (
      asset.status === "generating"
      && (!Array.isArray(asset.generatedImagePaths) || asset.generatedImagePaths.length === 0)
    ) {
      return true;
    }
    return asset.stressTest?.primaryRound.status === "generating"
      || asset.stressTest?.extraRound?.status === "generating";
  });
}

function persistProjects(
  projects: FilmProject[],
  planningChatMessages: FilmChatMessage[] = [],
  allowEmpty = false,
  planningActive = false,
): void {
  if (!fileWriteUnlocked) {
    pendingBeforeUnlock = true;
    return;
  }
  void writeToFile(
    makeFileData(projects, planningChatMessages, planningActive),
    allowEmpty,
  );
}

function unlockFileWrite(
  projects: FilmProject[],
  planningChatMessages: FilmChatMessage[],
  planningActive: boolean,
): void {
  fileWriteUnlocked = true;
  if (!pendingBeforeUnlock) return;
  pendingBeforeUnlock = false;
  void writeToFile(
    makeFileData(projects, planningChatMessages, planningActive),
    projects.length === 0,
  );
}

function generateProjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeProject(
  title: string,
  theme: string,
  videoServiceId: string,
  options: CreateFilmProjectOptions = {},
): FilmProject {
  const trimmedTitle = title.trim();
  const trimmedTheme = theme.trim();
  const trimmedVideoServiceId = videoServiceId.trim();
  if (!trimmedTitle || !trimmedTheme || !trimmedVideoServiceId) {
    throw new Error("タイトル・伝えたいこと・生成サービスは必須です");
  }

  const now = new Date().toISOString();
  const settings = options.scriptSettings;
  const initialScript: [] | FilmScript = settings
    ? {
        ...emptyScript(),
        targetDurationSeconds: Math.max(1, Math.round(settings.targetDurationSeconds)),
        topicMemo: settings.topicMemo.trim(),
        characterNames: settings.characterNames.map((name) => name.trim()).filter(Boolean),
      }
    : [];
  return {
    id: generateProjectId(),
    title: trimmedTitle,
    theme: trimmedTheme,
    mode: "film",
    assetServiceId: "gpt-image-2",
    videoServiceId: trimmedVideoServiceId,
    phase: options.startInScript ? 2 : 1,
    approvals: {
      logline: null,
      beatsheet: null,
      treatment: null,
      scenelist: null,
      blocks: null,
      look: null,
    },
    script: initialScript,
    assets: [],
    foreshadow: [],
    stylePrefix: "",
    lookMasterPath: null,
    lookMasterDescription: "",
    takes: [],
    chatMessages: options.chatMessages ?? [],
    postingTarget: options.postingTarget?.trim() ?? "",
    updatedAt: now,
  };
}

async function readFilmProjectsFileIntoStore(
  set: (partial: Partial<FilmProjectState>) => void,
  get: () => FilmProjectState,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!hasTauriInvoke()) return false;

  let content: string;
  try {
    content = await filmProjects.read();
  } catch (err) {
    console.error("[film-projects] ファイル読み出し失敗:", err);
    if (isCurrent()) {
      set({ filmProjectsFileState: "unreadable" });
      void showFileErrorToast("ファイルを開けません");
    }
    return false;
  }

  if (content.trim().length > 0) {
    let file: unknown;
    try {
      file = JSON.parse(content);
    } catch (err) {
      console.error("[film-projects] film-projects.json のパースに失敗:", err);
      if (isCurrent()) {
        set({ filmProjectsFileState: "corrupted" });
        void showFileErrorToast("内容が壊れています");
      }
      return false;
    }

    const parsed = file as Partial<FilmProjectsFileData> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.projects)
    ) {
      console.error("[film-projects] film-projects.json の形が不正");
      if (isCurrent()) {
        set({ filmProjectsFileState: "corrupted" });
        void showFileErrorToast("形式が正しくありません");
      }
      return false;
    }

    if (!isCurrent()) return false;
    set({ filmProjectsFileState: "ok" });

    // 読み込み中の入力を、到着した古いスナップショットで消さない。
    if (pendingBeforeUnlock) return true;

    const storedProjects = parsed.projects as StoredFilmProject[];
    const needsHydrationRepair = storedProjects.some(projectNeedsHydrationRepair);
    const projects = storedProjects.map((project) => normalizeFilmProject(project, true));
    const planningChatMessages = normalizeChatMessages(parsed.planningChatMessages);
    const currentActiveId = get().activeProjectId;
    const activeProjectId = parsed.planningActive && planningChatMessages.length > 0
      ? null
      : projects.some((project) => project.id === currentActiveId)
        ? currentActiveId
        : (projects[0]?.id ?? null);
    set({ projects, activeProjectId, planningChatMessages });
    // 走行中のまま残った状態と、過去版で⑤⑥へ進んだ状態は、④の再試行可能な
    // スナップショットへ直して正本にも反映する。
    if (needsHydrationRepair) pendingBeforeUnlock = true;
    return true;
  }

  if (!isCurrent()) return false;
  set({ filmProjectsFileState: "missing" });
  const projects = get().projects;
  const planningChatMessages = get().planningChatMessages;
  if (projects.length > 0 || planningChatMessages.length > 0) {
    const ok = await writeToFile(
      makeFileData(
        projects,
        planningChatMessages,
        get().activeProjectId === null,
      ),
      projects.length === 0,
    );
    if (!ok) return false;
  }
  return true;
}

export const useFilmProjectStore = create<FilmProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  planningChatMessages: [],
  filmProjectsFileState: "missing",
  filmProjectsSaveError: null,

  initialize: async () => {
    const myToken = ++initializeToken;
    fileWriteUnlocked = false;
    const readable = await readFilmProjectsFileIntoStore(
      set,
      get,
      () => myToken === initializeToken,
    );
    if (myToken !== initializeToken) return;
    fileReadDecided = true;
    if (readable) {
      unlockFileWrite(
        get().projects,
        get().planningChatMessages,
        get().activeProjectId === null,
      );
    }
  },

  retrySave: async () => {
    const state = get();
    const ok = await writeToFile(
      makeFileData(
        state.projects,
        state.planningChatMessages,
        state.activeProjectId === null && state.planningChatMessages.length > 0,
      ),
      state.projects.length === 0,
    );
    if (ok) {
      fileWriteUnlocked = true;
      set({ filmProjectsFileState: "ok" });
    }
    return ok;
  },

  listBackups: async () => {
    try {
      const rows = await filmProjects.listBackups();
      return {
        ok: true,
        items: rows.map(([path, at, count]) => ({ path, at, count })),
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  },

  restoreFromBackup: async (backupPath) => {
    const content = await filmProjects.readBackup(backupPath);
    let parsed: Partial<FilmProjectsFileData> | null;
    try {
      parsed = JSON.parse(content) as Partial<FilmProjectsFileData> | null;
    } catch {
      throw new Error("バックアップの内容を読み取れませんでした");
    }
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.version !== 1
      || !Array.isArray(parsed.projects)
    ) {
      throw new Error("バックアップの形式が正しくありません");
    }

    let projects: FilmProject[];
    try {
      projects = (parsed.projects as StoredFilmProject[]).map((project) =>
        normalizeFilmProject(project, true));
    } catch {
      throw new Error("バックアップ内のプロジェクトを読み取れませんでした");
    }
    if (projects.length === 0) {
      throw new Error("復元できるプロジェクトが入っていません");
    }
    const planningChatMessages = normalizeChatMessages(parsed.planningChatMessages);
    const planningActive = parsed.planningActive === true && planningChatMessages.length > 0;
    const ok = await writeToFile(
      makeFileData(projects, planningChatMessages, planningActive),
      // 過去の少ない件数へ戻す操作は意図的なので、激減ガードだけ明示解除する。
      true,
    );
    if (!ok) throw new Error("バックアップを保存先へ書き戻せませんでした");

    fileWriteUnlocked = true;
    fileReadDecided = true;
    pendingBeforeUnlock = false;
    fileErrorToastShown = false;
    set({
      projects,
      activeProjectId: planningActive ? null : (projects[0]?.id ?? null),
      planningChatMessages,
      filmProjectsFileState: "ok",
      filmProjectsSaveError: null,
    });
    return projects.length;
  },

  createProject: (title, theme, videoServiceId, options) => {
    const project = makeProject(title, theme, videoServiceId, options);
    const projects = [...get().projects, project];
    const planningChatMessages = options?.chatMessages
      ? []
      : get().planningChatMessages;
    persistProjects(projects, planningChatMessages);
    set({ projects, activeProjectId: project.id, planningChatMessages });
    return project;
  },

  setActiveProjectId: (projectId) => {
    if (projectId !== null && !get().projects.some((project) => project.id === projectId)) {
      return;
    }
    persistProjects(
      get().projects,
      get().planningChatMessages,
      get().projects.length === 0,
      projectId === null && get().planningChatMessages.length > 0,
    );
    set({ activeProjectId: projectId });
  },

  appendPlanningChatMessage: (message) => {
    const planningChatMessages = [...get().planningChatMessages, message];
    persistProjects(
      get().projects,
      planningChatMessages,
      get().projects.length === 0,
      get().activeProjectId === null,
    );
    set({ planningChatMessages });
  },

  resetPlanningChat: (messages = []) => {
    const planningChatMessages = normalizeChatMessages(messages);
    persistProjects(
      get().projects,
      planningChatMessages,
      get().projects.length === 0,
      get().activeProjectId === null,
    );
    set({ planningChatMessages });
  },

  appendChatMessage: (message) => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return;
    let changed = false;
    const projects = get().projects.map((sourceProject) => {
      if (sourceProject.id !== activeProjectId) return sourceProject;
      changed = true;
      const project = normalizeFilmProject(sourceProject);
      return touchProject({
        ...project,
        chatMessages: [...(project.chatMessages ?? []), message],
      });
    });
    if (!changed) return;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
  },

  setPhase: (phase) => {
    // ⑤⑥は近日対応。未実装画面へ状態だけ進める経路も閉じておく。
    if (!Number.isInteger(phase) || phase < 1 || phase > 4) return;
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return;
    let changed = false;
    const projects = get().projects.map((project) => {
      if (project.id !== activeProjectId || project.phase === phase) return project;
      changed = true;
      return touchProject({ ...project, phase });
    });
    if (!changed) return;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
  },

  saveScriptSettings: (settings) => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return;
    const targetDurationSeconds = Math.max(1, Math.round(settings.targetDurationSeconds));
    const topicMemo = settings.topicMemo.trim();
    const characterNames = settings.characterNames.map((name) => name.trim()).filter(Boolean);
    let changed = false;
    const projects = get().projects.map((sourceProject) => {
      if (sourceProject.id !== activeProjectId) return sourceProject;
      const project = normalizeFilmProject(sourceProject);
      const script = scriptOf(project);
      const targetChanged = (script.targetDurationSeconds ?? 90) !== targetDurationSeconds;
      const topicChanged = (script.topicMemo ?? "") !== topicMemo;
      const namesChanged = JSON.stringify(script.characterNames ?? []) !== JSON.stringify(characterNames);
      if (!targetChanged && !topicChanged && !namesChanged) return sourceProject;
      changed = true;
      const earliestStage: FilmScriptApprovalStage = topicChanged
        ? "logline"
        : targetChanged
          ? "beatsheet"
          : "treatment";
      return touchProject({
        ...project,
        approvals: invalidateApprovalsFrom(project, earliestStage),
        script: {
          ...script,
          targetDurationSeconds,
          topicMemo,
          characterNames,
        },
      });
    });
    if (!changed) return;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
  },

  saveLogline: (logline) => {
    updateActiveScript(get, set, "logline", (script) => ({ ...script, logline }));
  },

  saveBeatsheet: (beatsheet) => {
    updateActiveScript(get, set, "beatsheet", (script) => ({ ...script, beatsheet }));
  },

  saveTreatment: (treatment) => {
    updateActiveScript(get, set, "treatment", (script) => ({ ...script, treatment }));
  },

  saveScenelist: (scenelistText, scenes) => {
    updateActiveScript(get, set, "scenelist", (script) => ({
      ...script,
      scenelistText,
      scenes,
    }));
  },

  saveSceneList: (scenelistText, scenes) => {
    updateActiveScript(get, set, "scenelist", (script) => ({
      ...script,
      scenelistText,
      scenes,
    }));
  },

  saveBlocks: (blockScriptText, blocks) => {
    updateActiveScript(get, set, "blocks", (script) => ({
      ...script,
      blockScriptText,
      blocks,
    }));
  },

  approveStage: (stage) => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return false;
    let approved = false;
    const projects = get().projects.map((sourceProject) => {
      if (sourceProject.id !== activeProjectId) return sourceProject;
      const project = normalizeFilmProject(sourceProject);
      const script = scriptOf(project);
      const stageIndex = SCRIPT_STAGE_ORDER.indexOf(stage);
      const previousStage = SCRIPT_STAGE_ORDER[stageIndex - 1];
      if (previousStage && !project.approvals[previousStage]) return sourceProject;
      const hasContent = stage === "logline"
        ? Boolean(script.logline.trim())
        : stage === "beatsheet"
          ? Boolean(script.beatsheet.trim())
          : stage === "treatment"
            ? Boolean(script.treatment.trim())
            : stage === "scenelist"
              ? Boolean(script.scenelistText?.trim()) && script.scenes.length > 0
              : Boolean(script.blockScriptText?.trim()) && script.blocks.length > 0;
      if (!hasContent) return sourceProject;
      approved = true;
      return touchProject({
        ...project,
        approvals: {
          ...project.approvals,
          [stage]: { approvedAt: new Date().toISOString() },
        },
      });
    });
    if (!approved) return false;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
    return true;
  },

  revokeStageApproval: (stage) => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return false;
    let revoked = false;
    const projects = get().projects.map((sourceProject) => {
      if (sourceProject.id !== activeProjectId) return sourceProject;
      const project = normalizeFilmProject(sourceProject);
      if (!project.approvals[stage]) return sourceProject;
      revoked = true;
      return touchProject({
        ...project,
        // 脚本工程の承認を外した後は②へ戻す。成果物本文は消さない。
        phase: 2,
        approvals: invalidateApprovalsFrom(project, stage),
      });
    });
    if (!revoked) return false;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
    return true;
  },

  saveAssets: (assets) => {
    updateActiveDesign(get, set, (project) => {
      const currentById = new Map(project.assets.map((asset) => [asset.id, normalizeFilmAsset(asset)]));
      const nextAssets = assets.map((asset) => {
        const current = currentById.get(asset.id);
        return current?.locked ? current : asset;
      });
      // ③へ戻って台帳から消そうとしても、正典ロック済みのアセットは残す。
      for (const current of currentById.values()) {
        if (current.locked && !nextAssets.some((asset) => asset.id === current.id)) {
          nextAssets.push(current);
        }
      }
      return { ...project, assets: nextAssets };
    });
  },

  updateAssetFactoryAsset: (assetId, update) => {
    updateActiveFactory(get, set, (project) => ({
      ...project,
      assets: project.assets.map((asset) =>
        asset.id === assetId ? normalizeFilmAsset(update(normalizeFilmAsset(asset))) : asset,
      ),
    }));
  },

  saveForeshadow: (foreshadow) => {
    updateActiveDesign(get, set, (project) => ({ ...project, foreshadow }));
  },

  saveLookMaster: (lookMasterPath, description = "") => {
    updateActiveDesign(get, set, (project) => {
      const lookChanged = project.lookMasterPath !== lookMasterPath;
      return {
        ...project,
        lookMasterPath,
        lookMasterDescription: description,
        // 固定文は決定ルックの上に建つ。画像を替えた時だけ、旧ルック用の文を残さない。
        stylePrefix: lookChanged ? "" : project.stylePrefix,
      };
    });
  },

  saveStylePrefix: (stylePrefix) => {
    updateActiveDesign(get, set, (project) => ({ ...project, stylePrefix }));
  },

  approveLook: () => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return false;
    let approved = false;
    const projects = get().projects.map((sourceProject) => {
      if (sourceProject.id !== activeProjectId) return sourceProject;
      const project = normalizeFilmProject(sourceProject);
      const script = scriptOf(project);
      const assetIssues = validateAssetLedger(
        project.assets,
        script.blocks.map((block) => block.id),
      );
      if (
        !project.approvals.blocks ||
        !project.lookMasterPath?.trim() ||
        !project.stylePrefix.trim() ||
        project.assets.length === 0 ||
        assetIssues.length > 0
      ) {
        return sourceProject;
      }
      approved = true;
      return touchProject({
        ...project,
        phase: 4 as const,
        approvals: {
          ...project.approvals,
          look: { approvedAt: new Date().toISOString() },
        },
      });
    });
    if (!approved) return false;
    persistProjects(projects, get().planningChatMessages);
    set({ projects });
    return true;
  },
}));

reportSaveError = (error) => {
  useFilmProjectStore.setState({ filmProjectsSaveError: error });
};

function updateActiveDesign(
  get: () => FilmProjectState,
  set: (partial: Partial<FilmProjectState>) => void,
  update: (project: FilmProject) => FilmProject,
): void {
  const activeProjectId = get().activeProjectId;
  if (!activeProjectId) return;
  let changed = false;
  const projects = get().projects.map((sourceProject) => {
    if (sourceProject.id !== activeProjectId) return sourceProject;
    const project = normalizeFilmProject(sourceProject);
    const nextProject = update(project);
    if (JSON.stringify(project) === JSON.stringify(nextProject)) return sourceProject;
    changed = true;
    return touchProject({
      ...nextProject,
      approvals: { ...nextProject.approvals, look: null },
    });
  });
  if (!changed) return;
  persistProjects(projects, get().planningChatMessages);
  set({ projects });
}

/** S4の検品状態は③の承認済み設計の上に積むため、look承認を消さずに保存する。 */
function updateActiveFactory(
  get: () => FilmProjectState,
  set: (partial: Partial<FilmProjectState>) => void,
  update: (project: FilmProject) => FilmProject,
): void {
  const activeProjectId = get().activeProjectId;
  if (!activeProjectId) return;
  let changed = false;
  const projects = get().projects.map((sourceProject) => {
    if (sourceProject.id !== activeProjectId) return sourceProject;
    const project = normalizeFilmProject(sourceProject);
    const nextProject = update(project);
    if (JSON.stringify(project) === JSON.stringify(nextProject)) return sourceProject;
    changed = true;
    return touchProject(nextProject);
  });
  if (!changed) return;
  persistProjects(projects, get().planningChatMessages);
  set({ projects });
}

function updateActiveScript(
  get: () => FilmProjectState,
  set: (partial: Partial<FilmProjectState>) => void,
  stage: FilmScriptApprovalStage,
  update: (script: FilmScript) => FilmScript,
): void {
  const activeProjectId = get().activeProjectId;
  if (!activeProjectId) return;
  let changed = false;
  const projects = get().projects.map((sourceProject) => {
    if (sourceProject.id !== activeProjectId) return sourceProject;
    const project = normalizeFilmProject(sourceProject);
    const currentScript = scriptOf(project);
    const nextScript = update(currentScript);
    if (JSON.stringify(currentScript) === JSON.stringify(nextScript)) return sourceProject;
    changed = true;
    return touchProject({
      ...project,
      approvals: invalidateApprovalsFrom(project, stage),
      script: nextScript,
    });
  });
  if (!changed) return;
  persistProjects(projects, get().planningChatMessages);
  set({ projects });
}

// 後続ステージの復元導線が「読込完了」と「書込可能」を区別できるよう保持する。
export function filmProjectsFileReadDecided(): boolean {
  return fileReadDecided;
}
