import { invoke } from "@tauri-apps/api/core";
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
 * 永続化 (v0.6.9): Tauri 経由のファイル保存に変更。
 *   - Mac:   ~/Library/Application Support/app.codexframefactory/projects.json
 *   - Win:   %APPDATA%/app.codexframefactory/projects.json
 *
 * 旧 localStorage に保存されていたデータは、起動時に自動マイグレーションする。
 * これにより dev版 と 配布版 でデータが共有され、再インストールでも消えない。
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

/**
 * プロジェクトに紐づくストック素材のクレジット記録 (法務対応 2026-05-21)。
 *
 * 用途:
 *   - 商用案件で「この PR 動画で使った素材は？」と聞かれた時の出典トレース
 *   - エクスポート時に credits.csv として一覧出力する
 *
 * 記録タイミング:
 *   - StockSearchModal の「参照に追加」時、アクティブプロジェクトがあれば
 *     useProjects.getState().recordStockCredit(activeProjectId, credit) を呼ぶ
 *
 * 重複排除:
 *   - 同じ photoId が既にあれば addedAt のみ更新 (二重カウントしない)
 */
export type StockCredit = {
  provider: "pexels";
  photoId: string;
  author: string;
  sourceUrl?: string;
  /** ローカルに保存したファイルパス。後追いで「どの素材か」を辿る用。 */
  localPath?: string;
  /** いつ参照に取り込んだか */
  addedAt: number;
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
  /**
   * このプロジェクトで取り込んだストック素材のクレジット累積ログ。
   * 法務対応 (2026-05-21): credits.csv エクスポート用の出典トレース。
   * 未定義の場合は空配列扱い (後方互換)。
   */
  stockCredits?: StockCredit[];
  createdAt: number;
  updatedAt: number;
};

const PROJECTS_LS_KEY = "projects.projects";
/** localStorage の冗長バックアップ。万一 localStorage が一時的に空でも、
 *  ここに最後の正常な配列が残っていれば復元できる。 */
const PROJECTS_LS_BACKUP_KEY = "projects.projects.backup";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * localStorage からのデータ救出 (旧版互換)。
 * v0.6.8 以前は localStorage に保存されていた。新規ファイル保存に
 * 移行した後も、初回起動時に localStorage に残っているデータがあれば
 * それを読み出して、ファイルへ移行する。
 */
function readFromLocalStorage(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Project[];
      }
    }
    const backup = localStorage.getItem(PROJECTS_LS_BACKUP_KEY);
    if (backup) {
      const backupParsed = JSON.parse(backup);
      if (Array.isArray(backupParsed) && backupParsed.length > 0) {
        return backupParsed as Project[];
      }
    }
  } catch (err) {
    console.error("[projects] localStorage 読み出し失敗:", err);
  }
  return [];
}

/**
 * Tauri 経由でファイルから読み出す。
 * 初期化時、または localStorage が空の時に呼ぶ。
 */
async function readFromFile(): Promise<Project[]> {
  try {
    const content = await invoke<string>("projects_read");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed as Project[];
    }
  } catch (err) {
    console.error("[projects] ファイル読み出し失敗:", err);
  }
  return [];
}

/**
 * Tauri 経由でファイルに書き込む。
 */
async function writeToFile(projects: Project[]): Promise<void> {
  try {
    const serialized = JSON.stringify(projects);
    await invoke("projects_write", { content: serialized });
  } catch (err) {
    console.error("[projects] ファイル書き込み失敗:", err);
  }
}

function persist(projects: Project[]) {
  // 旧 localStorage にも引き続き書く (緊急時の救出経路として)
  try {
    const serialized = JSON.stringify(projects);
    localStorage.setItem(PROJECTS_LS_KEY, serialized);
    if (projects.length > 0) {
      localStorage.setItem(PROJECTS_LS_BACKUP_KEY, serialized);
    }
  } catch (err) {
    console.error("[projects] localStorage 書き込み失敗:", err);
  }
  // 主たる保存先はファイル (非同期)
  void writeToFile(projects);
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

  /**
   * 全プロジェクトを走査して、`imagePath === oldPath` のアイテムを `newPath` に書き換える。
   * F-#2 修正 (2026-05-19): ライブラリで画像をリネームした際、各プロジェクトの items[].imagePath が
   * 古いパスを保持していると黒画像になるため、リネーム成功直後に呼び出して整合性を取る。
   * 該当アイテムが無いプロジェクトは触らない (updatedAt も維持)。
   */
  renameItemPath: (oldPath: string, newPath: string) => void;

  /** 企画チャットログを上書き保存する（差分ではなく毎回スナップショット） */
  setPlanChat: (projectId: string, messages: ProjectChatMessage[]) => void;

  /**
   * ストック素材のクレジットを記録する (法務対応 2026-05-21)。
   * 同じ photoId が既にあれば addedAt のみ更新 (重複排除)。
   * プロジェクトが見つからない場合は何もしない。
   */
  recordStockCredit: (
    projectId: string,
    credit: Omit<StockCredit, "addedAt">,
  ) => void;

  /**
   * プロジェクトの stockCredits を CSV 文字列として生成する。
   * 1 行目はヘッダ。空ログでもヘッダのみ返す。
   * 法務対応 (2026-05-21): 商用案件の出典トレース用。
   */
  buildCreditsCsv: (projectId: string) => string;

  /**
   * 初期化: ファイルから読み出して store に流し込む。
   * 起動時に必ず1回呼ぶ。複数回呼ばれても安全 (最後の結果で上書き)。
   * Tauri が動いていない時 (Vite単体プレビュー等) は localStorage に
   * フォールバックする。
   */
  initialize: () => Promise<void>;
};

export const useProjects = create<ProjectsState>((set, get) => ({
  // 初期値は同期的に localStorage から読む (起動の一瞬を埋めるため)。
  // 直後に initialize() でファイル側の正値で上書きされる。
  projects: readFromLocalStorage(),

  initialize: async () => {
    try {
      const fromFile = await readFromFile();
      const fromLs = readFromLocalStorage();
      // ファイル側が空で localStorage に有効データがあれば、マイグレーション。
      // ファイル側にデータがあればそれを正とする (ファイルが master)。
      if (fromFile.length === 0 && fromLs.length > 0) {
        console.info(
          "[projects] localStorage から", fromLs.length, "件をファイルへ移行",
        );
        await writeToFile(fromLs);
        set({ projects: fromLs });
      } else {
        set({ projects: fromFile });
      }
    } catch (err) {
      console.error("[projects] initialize 失敗:", err);
    }
  },

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

  renameItemPath: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const now = Date.now();
    let changed = false;
    const next = get().projects.map((p) => {
      let projectChanged = false;
      const items = p.items.map((it) => {
        if (it.imagePath === oldPath) {
          projectChanged = true;
          changed = true;
          return { ...it, imagePath: newPath };
        }
        return it;
      });
      return projectChanged ? { ...p, items, updatedAt: now } : p;
    });
    if (!changed) return;
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

  recordStockCredit: (projectId, credit) => {
    const projects = get().projects;
    const target = projects.find((p) => p.id === projectId);
    if (!target) return;
    const existing = (target.stockCredits ?? []).find(
      (c) => c.provider === credit.provider && c.photoId === credit.photoId,
    );
    const nextCredit: StockCredit = existing
      ? { ...existing, ...credit, addedAt: Date.now() }
      : { ...credit, addedAt: Date.now() };
    const nextCredits = existing
      ? (target.stockCredits ?? []).map((c) =>
          c.provider === existing.provider && c.photoId === existing.photoId
            ? nextCredit
            : c,
        )
      : [nextCredit, ...(target.stockCredits ?? [])];
    const next = projects.map((p) =>
      p.id === projectId
        ? { ...p, stockCredits: nextCredits, updatedAt: Date.now() }
        : p,
    );
    persist(next);
    set({ projects: next });
  },

  buildCreditsCsv: (projectId) => {
    const target = get().projects.find((p) => p.id === projectId);
    // 表計算ソフトとの互換重視で UTF-8 BOM を付けない素の CSV を返す。
    // BOM 付きが必要な呼び出し側 (Excel 日本語環境) はファイル保存時に
    // 先頭に "﻿" を付ければよい。
    const header =
      "provider,photo_id,author,source_url,local_path,added_at_iso,project_id,project_name";
    if (!target || !target.stockCredits || target.stockCredits.length === 0) {
      return `${header}\n`;
    }
    const projectName = target.name;
    const rows = target.stockCredits.map((c) => {
      const addedAtIso = new Date(c.addedAt).toISOString();
      return [
        csvEscape(c.provider),
        csvEscape(c.photoId),
        csvEscape(c.author),
        csvEscape(c.sourceUrl ?? ""),
        csvEscape(c.localPath ?? ""),
        csvEscape(addedAtIso),
        csvEscape(target.id),
        csvEscape(projectName),
      ].join(",");
    });
    return `${header}\n${rows.join("\n")}\n`;
  },
}));

/**
 * CSV の 1 セルをエスケープする。
 *  - カンマ / 改行 / ダブルクォートのいずれかが含まれていたら全体を "" で囲む
 *  - 内部のダブルクォートは "" にエスケープ
 *
 * 法務対応 (2026-05-21): credits.csv エクスポートで使用。
 *   著者名にカンマや日本語の括弧が入る可能性があるため、必須。
 */
function csvEscape(value: string): string {
  if (value === "") return "";
  const needsQuote = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}
