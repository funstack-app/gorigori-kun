import { create } from "zustand";

/**
 * プロジェクト = 制作物のアーカイブ箱。
 *
 * Code Manager / Notion / Figma のページ的な軽い「箱」として機能する。
 * 制作画面で生成した画像 1 枚ごとに「プロジェクトに保存」できるようにし、
 * このストアに永続化する。プロジェクトを開くと、保存した画像が
 * グリッドで一覧できる。
 *
 * sessions ストア（チャット履歴）とは独立した 2 軸:
 * - sessions: 進行中の作業セッション（時系列、過去のチャット）
 * - projects: 完成物のアーカイブ箱（用途別、案件別、テーマ別）
 *
 * 永続化: localStorage（MVP）。後で Tauri のファイル DB に移行可。
 */

export type ProjectItem = {
  id: string;
  /** 元の画像ファイルパス（Tauri convertFileSrc で表示する） */
  imagePath: string;
  /** 任意のメモ（用途、コメント、誰宛 等） */
  note?: string;
  /** 生成時のプロンプト（あれば、後追いで参照しやすいように） */
  prompt?: string;
  /** 元 session id（あれば、戻る導線用） */
  sourceSessionId?: string;
  addedAt: number;
};

/**
 * プロジェクトに保存する企画チャットの 1 メッセージ。
 * planChat.PlanMessage と互換（streaming は保存しない）。
 */
export type ProjectChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachedImages?: string[];
  createdAt: number;
};

export type Project = {
  id: string;
  name: string;
  /** 任意の説明 */
  description?: string;
  items: ProjectItem[];
  /** 企画チャット (PlanWorkspace) のログ。アクティブプロジェクト時に
   *  会話完了ごとに上書き保存される。 */
  planChat?: ProjectChatMessage[];
  createdAt: number;
  updatedAt: number;
};

const PROJECTS_LS_KEY = "projects.projects";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPersisted(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Project[]) : [];
  } catch {
    return [];
  }
}

function persist(projects: Project[]) {
  try {
    localStorage.setItem(PROJECTS_LS_KEY, JSON.stringify(projects));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

type ProjectsState = {
  projects: Project[];

  createProject: (name: string, description?: string) => Project;
  renameProject: (id: string, name: string) => void;
  updateProjectDescription: (id: string, description: string | undefined) => void;
  removeProject: (id: string) => void;

  addItem: (
    projectId: string,
    item: Omit<ProjectItem, "id" | "addedAt">,
  ) => ProjectItem | null;
  removeItem: (projectId: string, itemId: string) => void;

  /** 企画チャットログを上書き保存する（差分ではなく毎回スナップショット） */
  setPlanChat: (projectId: string, messages: ProjectChatMessage[]) => void;
};

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: readPersisted(),

  createProject: (name, description) => {
    const now = Date.now();
    const project: Project = {
      id: generateId(),
      name: name.trim() || "無題のプロジェクト",
      description: description?.trim() || undefined,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    const next = [project, ...get().projects];
    persist(next);
    set({ projects: next });
    return project;
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = get().projects.map((p) =>
      p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
    );
    persist(next);
    set({ projects: next });
  },

  updateProjectDescription: (id, description) => {
    const next = get().projects.map((p) =>
      p.id === id
        ? {
            ...p,
            description: description?.trim() || undefined,
            updatedAt: Date.now(),
          }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  removeProject: (id) => {
    const next = get().projects.filter((p) => p.id !== id);
    persist(next);
    set({ projects: next });
  },

  addItem: (projectId, itemData) => {
    const projects = get().projects;
    const target = projects.find((p) => p.id === projectId);
    if (!target) return null;
    // 同じ画像パスが既に箱の中にあれば addedAt だけ更新（重複追加を防ぐ）
    const existing = target.items.find((it) => it.imagePath === itemData.imagePath);
    let nextItem: ProjectItem;
    if (existing) {
      nextItem = { ...existing, ...itemData, addedAt: Date.now() };
    } else {
      nextItem = {
        id: generateId(),
        addedAt: Date.now(),
        ...itemData,
      };
    }
    const nextItems = existing
      ? target.items.map((it) => (it.id === existing.id ? nextItem : it))
      : [nextItem, ...target.items];
    const next = projects.map((p) =>
      p.id === projectId
        ? { ...p, items: nextItems, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });
    return nextItem;
  },

  removeItem: (projectId, itemId) => {
    const next = get().projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            items: p.items.filter((it) => it.id !== itemId),
            updatedAt: Date.now(),
          }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  setPlanChat: (projectId, messages) => {
    const next = get().projects.map((p) =>
      p.id === projectId
        ? { ...p, planChat: messages, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });
  },
}));
