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

/**
 * 参照画像の役割種別。
 *
 * N-2 (2026-06-16 Ta4low 要望): 従来の character / style に加えて location
 * (ロケーション/背景・環境) と item (アイテム/商品・オブジェクト) を追加。
 *  - location: 背景・環境をこの画像に合わせる (被写体ではなく舞台)。
 *  - item: この商品/オブジェクトを登場させ、形状・質感を維持する。
 *
 * 後方互換: 旧データ (character / style のみ) は追加種別を含まないので、
 * localStorage / JSON に残っていても isRoleKind で弾かれず読める。新種別は
 * 既存の character 既定を壊さない (未指定は従来通り character)。
 */
export type ReferenceRoleKind = "character" | "style" | "location" | "item";

export const REFERENCE_ROLE_DEFAULT: ReferenceRoleKind = "character";

/** 全ロール種別の並び順 (UI のトグル表示順・イテレーションの正本)。 */
export const REFERENCE_ROLE_KINDS: readonly ReferenceRoleKind[] = [
  "character",
  "style",
  "location",
  "item",
] as const;

/**
 * ロールごとの UI ラベル・説明・配色・プロンプト用語を一元管理する。
 *
 * UI (ReferenceRoleToggle / ReferenceLibraryModal) とプロンプト構築
 * (planChat) が同じ定義を参照することで、種別追加時の記述漏れを防ぐ。
 */
export type ReferenceRoleMeta = {
  /** トグルの短いラベル。 */
  label: string;
  /** ライブラリ取り込み時の「〜として」ラベル。 */
  pickLabel: string;
  /** ホバー時の説明 (日本語)。 */
  description: string;
  /** アクティブ時の Tailwind 背景色クラス。 */
  activeClass: string;
  /** プロンプトに出す日本語の役割名 ([添付画像] 欄用)。 */
  promptLabelJa: string;
  /** プロンプトに出す役割の趣旨 (日本語 1 行)。 */
  promptNoteJa: string;
};

export const REFERENCE_ROLE_META: Record<ReferenceRoleKind, ReferenceRoleMeta> = {
  character: {
    label: "キャラ",
    pickLabel: "キャラとして",
    description: "キャラ参照: 人物/被写体の同一性を保つ対象",
    activeClass: "bg-pink-500 text-white",
    promptLabelJa: "キャラ参照",
    promptNoteJa: "登場キャラ/被写体の同一性を保つ対象",
  },
  style: {
    label: "スタイル",
    pickLabel: "スタイルとして",
    description: "スタイル参照: 絵のタッチ/質感のみ参照 (同一性には使わない)",
    activeClass: "bg-indigo-500 text-white",
    promptLabelJa: "スタイル参照",
    promptNoteJa: "絵のタッチ/質感のみ参照し人物同一性には使わない",
  },
  location: {
    label: "ロケーション",
    pickLabel: "ロケーションとして",
    description: "ロケーション参照: 背景・環境をこの画像に合わせる (舞台)",
    activeClass: "bg-emerald-500 text-white",
    promptLabelJa: "ロケーション参照",
    promptNoteJa: "背景・環境・舞台をこの画像に合わせる (被写体ではない)",
  },
  item: {
    label: "アイテム",
    pickLabel: "アイテムとして",
    description: "アイテム参照: この商品/オブジェクトを登場させ形状・質感を維持",
    activeClass: "bg-amber-500 text-white",
    promptLabelJa: "アイテム参照",
    promptNoteJa: "この商品/オブジェクトを登場させ形状・質感を維持する",
  },
};

const ROLES_LS_KEY = "referenceRoles.byPath";

type RolesMap = Record<string, ReferenceRoleKind>;

function isRoleKind(v: unknown): v is ReferenceRoleKind {
  return (REFERENCE_ROLE_KINDS as readonly string[]).includes(v as string);
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
  /** 役割を次の種別へ循環させる (character→style→location→item→character)。 */
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
    const idx = REFERENCE_ROLE_KINDS.indexOf(current);
    const nextRole =
      REFERENCE_ROLE_KINDS[(idx + 1) % REFERENCE_ROLE_KINDS.length];
    const next = { ...get().roles, [path]: nextRole };
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
