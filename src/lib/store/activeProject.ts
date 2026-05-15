import { create } from "zustand";

/**
 * 「現在作業中のプロジェクト ID」を保持するグローバルストア。
 *
 * これが立っていると、企画チャットの会話ログ + 採用後に生成された画像が
 * 自動的にそのプロジェクトに紐付く。null（未選択）なら従来通り、
 * プロジェクトには何も保存されない。
 *
 * 永続化は localStorage にする。アプリ再起動後も「最後に作業していた
 * プロジェクト」が選択されたままだと体験が一貫する。
 */

const ACTIVE_PROJECT_LS_KEY = "activeProject.id";

function readPersisted(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_LS_KEY);
    return raw ? raw : null;
  } catch {
    return null;
  }
}

function persist(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_LS_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_LS_KEY, id);
  } catch {
    /* non-fatal */
  }
}

type ActiveProjectState = {
  activeProjectId: string | null;
  setActive: (id: string | null) => void;
};

export const useActiveProject = create<ActiveProjectState>((set) => ({
  activeProjectId: readPersisted(),
  setActive: (id) => {
    persist(id);
    set({ activeProjectId: id });
  },
}));
