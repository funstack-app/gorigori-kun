import { create } from "zustand";

import { filmProjects } from "../ipc";
import type { FilmPhase, FilmProject } from "../film/types";

export type FilmProjectsFileData = {
  version: 1;
  projects: FilmProject[];
};

export type FilmProjectsFileState = "ok" | "missing" | "corrupted" | "unreadable";

type FilmProjectState = {
  projects: FilmProject[];
  activeProjectId: string | null;
  filmProjectsFileState: FilmProjectsFileState;
  initialize: () => Promise<void>;
  createProject: (title: string, theme: string, service: string) => FilmProject;
  setActiveProjectId: (projectId: string | null) => void;
  setPhase: (phase: FilmPhase) => void;
};

async function writeToFileNow(
  data: FilmProjectsFileData,
  allowEmpty: boolean,
): Promise<void> {
  try {
    await filmProjects.write(JSON.stringify(data), allowEmpty);
  } catch (err) {
    console.error("[film-projects] ファイル書き込み失敗:", err);
    try {
      const { useToasts } = await import("./toasts");
      useToasts.getState().push({
        kind: "error",
        text: `フィルムの保存先ファイルに書き込めませんでした。アプリを再起動すると再試行します: ${String(err)}`,
        ttlMs: 8000,
      });
    } catch {
      // 通知に失敗しても、書き込み失敗は呼び出し側へ返す。
    }
    throw err;
  }
}

/** 全量スナップショットを直列化する、最後勝ちの保存キュー。 */
let pendingWrite: { data: FilmProjectsFileData; allowEmpty: boolean } | null = null;
let writeInFlight: Promise<boolean> | null = null;

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
          lastOk = true;
        } catch {
          // 失敗通知は writeToFileNow で済んでいる。最新ジョブまで処理は続ける。
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

function persistProjects(projects: FilmProject[], allowEmpty = false): void {
  if (!fileWriteUnlocked) {
    pendingBeforeUnlock = true;
    return;
  }
  void writeToFile({ version: 1, projects }, allowEmpty);
}

function unlockFileWrite(projects: FilmProject[]): void {
  fileWriteUnlocked = true;
  if (!pendingBeforeUnlock) return;
  pendingBeforeUnlock = false;
  void writeToFile({ version: 1, projects });
}

function generateProjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeProject(title: string, theme: string, service: string): FilmProject {
  const trimmedTitle = title.trim();
  const trimmedTheme = theme.trim();
  const trimmedService = service.trim();
  if (!trimmedTitle || !trimmedTheme || !trimmedService) {
    throw new Error("タイトル・伝えたいこと・生成サービスは必須です");
  }

  return {
    id: generateProjectId(),
    title: trimmedTitle,
    theme: trimmedTheme,
    mode: "film",
    service: trimmedService,
    phase: 1,
    approvals: {
      logline: null,
      beatsheet: null,
      treatment: null,
      scenelist: null,
      look: null,
    },
    script: [],
    assets: [],
    foreshadow: [],
    stylePrefix: "",
    lookMasterPath: null,
    takes: [],
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

    const projects = parsed.projects as FilmProject[];
    const currentActiveId = get().activeProjectId;
    const activeProjectId = projects.some((project) => project.id === currentActiveId)
      ? currentActiveId
      : (projects[0]?.id ?? null);
    set({ projects, activeProjectId });
    return true;
  }

  if (!isCurrent()) return false;
  set({ filmProjectsFileState: "missing" });
  const projects = get().projects;
  if (projects.length > 0) {
    const ok = await writeToFile({ version: 1, projects });
    if (!ok) return false;
  }
  return true;
}

export const useFilmProjectStore = create<FilmProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  filmProjectsFileState: "missing",

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
    if (readable) unlockFileWrite(get().projects);
  },

  createProject: (title, theme, service) => {
    const project = makeProject(title, theme, service);
    const projects = [...get().projects, project];
    persistProjects(projects);
    set({ projects, activeProjectId: project.id });
    return project;
  },

  setActiveProjectId: (projectId) => {
    if (projectId !== null && !get().projects.some((project) => project.id === projectId)) {
      return;
    }
    set({ activeProjectId: projectId });
  },

  setPhase: (phase) => {
    if (!Number.isInteger(phase) || phase < 1 || phase > 6) return;
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) return;
    let changed = false;
    const projects = get().projects.map((project) => {
      if (project.id !== activeProjectId || project.phase === phase) return project;
      changed = true;
      return { ...project, phase };
    });
    if (!changed) return;
    persistProjects(projects);
    set({ projects });
  },
}));

// 後続ステージの復元導線が「読込完了」と「書込可能」を区別できるよう保持する。
export function filmProjectsFileReadDecided(): boolean {
  return fileReadDecided;
}
