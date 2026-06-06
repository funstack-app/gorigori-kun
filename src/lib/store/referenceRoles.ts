import { create } from "zustand";

/**
 * 参照画像の役割 (キャラ / スタイル) 管理ストア。
 *
 * FB#3 (2026-06-06 STΛCK 指示): 企画チャットに添付した画像を、AI の文脈推測に
 * 任せず **ユーザーが明示的に** 「これはキャラ参照」「これはスタイル参照」と
 * 指定できるようにする。複数キャラ参照 (5体登場するキャラ全員) と複数スタイル
 * 参照に対応する。
 *
 * 設計理由:
 *  - planChat.pendingImages / GoalChatPanel.attachedImages は「パス配列」で添付を
 *    管理しているので、役割は「パス → 役割」の Map で別ストアに持つのが最小侵襲。
 *  - 役割が未指定のパスは "character" 既定 (キャラ参照を本来使ってほしいという
 *    ユーザー要望に沿う。旧挙動の「1枚目=キャラ/2枚目=スタイル自動割当」を廃する)。
 *  - localStorage 永続化。企画タブ ⇄ 専用ストーリーボードパネル間で共有する。
 */

export type ReferenceRoleKind = "character" | "style";

export const REFERENCE_ROLE_DEFAULT: ReferenceRoleKind = "character";

const ROLES_LS_KEY = "referenceRoles.byPath";

type RolesMap = Record<string, ReferenceRoleKind>;

function isRoleKind(v: unknown): v is ReferenceRoleKind {
  return v === "character" || v === "style";
}

function readPersisted(): RolesMap {
  try {
    const raw = localStorage.getItem(ROLES_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: RolesMap = {};
    for (const [path, role] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof path === "string" && isRoleKind(role)) out[path] = role;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(value: RolesMap) {
  try {
    localStorage.setItem(ROLES_LS_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

type ReferenceRolesState = {
  /** パス → 役割。未登録のパスは既定でキャラ扱い (getRole 参照)。 */
  roles: RolesMap;
  /** 指定パスの役割を返す。未登録は REFERENCE_ROLE_DEFAULT。 */
  getRole: (path: string) => ReferenceRoleKind;
  /** 役割を設定する。 */
  setRole: (path: string, role: ReferenceRoleKind) => void;
  /** キャラ ⇄ スタイル をトグルする。 */
  toggleRole: (path: string) => void;
  /** 役割が未登録なら既定値で初期化する (添付直後に呼ぶ)。冪等。 */
  ensureRoles: (paths: string[], fallback?: ReferenceRoleKind) => void;
  /** 添付解除時に役割エントリを掃除する。 */
  clearRole: (path: string) => void;
};

export const useReferenceRoles = create<ReferenceRolesState>((set, get) => ({
  roles: readPersisted(),

  getRole: (path) => get().roles[path] ?? REFERENCE_ROLE_DEFAULT,

  setRole: (path, role) => {
    const next = { ...get().roles, [path]: role };
    persist(next);
    set({ roles: next });
  },

  toggleRole: (path) => {
    const current = get().roles[path] ?? REFERENCE_ROLE_DEFAULT;
    const next = {
      ...get().roles,
      [path]: current === "character" ? ("style" as const) : ("character" as const),
    };
    persist(next);
    set({ roles: next });
  },

  ensureRoles: (paths, fallback = REFERENCE_ROLE_DEFAULT) => {
    const current = get().roles;
    let changed = false;
    const next: RolesMap = { ...current };
    for (const path of paths) {
      if (path && next[path] === undefined) {
        next[path] = fallback;
        changed = true;
      }
    }
    if (!changed) return;
    persist(next);
    set({ roles: next });
  },

  clearRole: (path) => {
    if (get().roles[path] === undefined) return;
    const next = { ...get().roles };
    delete next[path];
    persist(next);
    set({ roles: next });
  },
}));
