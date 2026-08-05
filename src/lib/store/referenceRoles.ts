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

/**
 * plugin-store のファイル名 / キー (2026-08-03 r9c)。
 *
 * なぜ localStorage 単独をやめたか: WebView のビルドID
 * (app.codexframefactory / .dev / .capture) ごとに別領域になり、ビルドを跨ぐと
 * 割当が空に見える。WebView データ消去でも全損する。
 * 同型データ (path キーの作品メタ) である favorites/judgements が既に
 * plugin-store なので、path キー資産の regime を 1 つに揃える
 * (rename / 移動 / relink の追従面を数えやすくするため)。
 *
 * Rust 正本 (motions.json 等) にしないのは、データがパス→ロール1語の小さな map で、
 * 世代バックアップ・空上書きガードの価値が薄く、再指定コストも極小のため。
 */
const ROLES_STORE_FILE = "reference-roles.json";
const ROLES_STORE_KEY = "byPath";

type RolesMap = Record<string, ReferenceRoleKind>;

function isRoleKind(v: unknown): v is ReferenceRoleKind {
  return (REFERENCE_ROLE_KINDS as readonly string[]).includes(v as string);
}

/**
 * 未検証の map (localStorage / ファイル由来) を 1 件ずつ検証して取り込む。
 *
 * **捨てた件数を返す** (2026-08-06 / DL-12)。以前は無通知で捨てていたため、
 * 未知のロール値を持つ新バージョンで一度起動すると、その値が黙って消えた状態が
 * 正本として書き戻されていた。捨てた事実をログに残し、呼び出し側が
 * 「書き戻してよいか」を判断できるようにする。
 */
function sanitizeRoles(parsed: unknown): { roles: RolesMap; dropped: number } {
  if (!parsed || typeof parsed !== "object") return { roles: {}, dropped: 0 };
  const out: RolesMap = {};
  let dropped = 0;
  for (const [path, role] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof path === "string" && isRoleKind(role)) out[path] = role;
    else dropped++;
  }
  if (dropped > 0) {
    console.warn(`[referenceRoles] 認識できないロール ${dropped} 件を除外しました`);
  }
  return { roles: out, dropped };
}

function readPersisted(): RolesMap {
  try {
    const raw = localStorage.getItem(ROLES_LS_KEY);
    if (!raw) return {};
    return sanitizeRoles(JSON.parse(raw)).roles;
  } catch {
    return {};
  }
}

// store インスタンスはモジュールキャッシュ (savedPrompts.ts と同型)。
// mutate のたびに plugin import + load を再実行するのは無駄で、書き込み競合も招く。
let storePromise: Promise<Awaited<ReturnType<typeof loadStoreOnce>> | null> | null = null;

async function loadStoreOnce() {
  const { load } = await import("@tauri-apps/plugin-store");
  return await load(ROLES_STORE_FILE, { defaults: {}, autoSave: true });
}

async function loadStore() {
  if (storePromise) return storePromise;
  storePromise = loadStoreOnce().catch((err) => {
    // Tauri 外 (Vite 単体プレビュー等) や load 失敗。localStorage 運用を継続する。
    console.warn("[referenceRoles] loadStore failed", err);
    return null;
  });
  return storePromise;
}

/**
 * ファイルへ書いてよいと確定したか。initialize が成功したときだけ true。
 * false の間は localStorage のみに書き、**ファイルへは触らない**
 * (読めていない正本を localStorage 由来の内容で潰さない)。
 */
let fileWriteUnlocked = false;
/** 解禁前に mutate した path (解禁時にファイル側へ再適用する)。 */
const mutatedPaths = new Set<string>();

/**
 * plugin-store へ書く。**成否を返す** (2026-08-06 / DL-12)。
 *
 * 以前は失敗を内部で握り潰して void を返していたため、初回移行が失敗しても
 * 呼び出し側は成功として書き込みを解禁していた。「ファイルには何も無いのに
 * 書けている前提で動く」= presets が 2026-08-06 に踏んだのと同じ穴。
 */
async function persistToStore(value: RolesMap): Promise<boolean> {
  const store = await loadStore();
  if (!store) return false; // ファイルへは書かない (localStorage のみ継続)
  try {
    await store.set(ROLES_STORE_KEY, value);
    await store.save();
    return true;
  } catch (err) {
    // ロールは再指定可能な軽資産なのでトーストまでは出さない (ログのみ)。
    console.warn("[referenceRoles] persist failed", err);
    return false;
  }
}

function persist(value: RolesMap) {
  try {
    localStorage.setItem(ROLES_LS_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
  if (!fileWriteUnlocked) return; // 解禁前。mutatedPaths は呼び出し側で記録済み
  void persistToStore(value);
}

/** 解禁前の mutate を記録する (initialize でファイル側へ再適用するため)。 */
function markMutated(...paths: string[]) {
  if (fileWriteUnlocked) return;
  for (const p of paths) {
    if (p) mutatedPaths.add(p);
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
  /**
   * 画像のリネーム / 移動に追従してキーを付け替える (2026-08-03 r9c)。
   * ここを欠くと、リネームした瞬間にロールが既定 (キャラ) に剥がれる。
   * presets.renameImagePath と同型で、変化が無ければ set も persist もしない。
   */
  renamePath: (oldPath: string, newPath: string) => void;
  /**
   * rr2: relink (画像パス修復) の旧→新マップを一括適用する。renamePath の一括版で、
   * 1 回の set + 1 回の persist で済ませる。
   * 旧/新パスの両方を markMutated に積むため、initialize (解禁) との実行順が
   * どちらでも記録が失われない。変化が無ければ set も persist もしない。
   */
  relinkPaths: (pathMap: Record<string, string>) => void;
  /**
   * 起動時にファイル (reference-roles.json) から読み込み、書き込みを解禁する。
   * **読めなかった経路ではファイルへ書かない**という不変条件を守る。
   */
  initialize: () => Promise<void>;
};

export const useReferenceRoles = create<ReferenceRolesState>((set, get) => ({
  roles: readPersisted(),

  getRole: (path) => get().roles[path] ?? REFERENCE_ROLE_DEFAULT,

  setRole: (path, role) => {
    const next = { ...get().roles, [path]: role };
    markMutated(path);
    persist(next);
    set({ roles: next });
  },

  toggleRole: (path) => {
    const current = get().roles[path] ?? REFERENCE_ROLE_DEFAULT;
    const idx = REFERENCE_ROLE_KINDS.indexOf(current);
    const nextRole =
      REFERENCE_ROLE_KINDS[(idx + 1) % REFERENCE_ROLE_KINDS.length];
    const next = { ...get().roles, [path]: nextRole };
    markMutated(path);
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
        markMutated(path);
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
    // 削除も「触った path」として記録する。解禁時の再適用では
    // 「state に無い = 削除済み」として表現される。
    markMutated(path);
    persist(next);
    set({ roles: next });
  },

  renamePath: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const current = get().roles;
    const role = current[oldPath];
    if (role === undefined) return; // 既定 (キャラ) のままなら記録が無いので何もしない
    const next = { ...current };
    delete next[oldPath];
    next[newPath] = role;
    markMutated(oldPath, newPath);
    persist(next);
    set({ roles: next });
  },

  relinkPaths: (pathMap) => {
    const entries = Object.entries(pathMap).filter(
      ([oldPath, newPath]) => oldPath && newPath && oldPath !== newPath,
    );
    if (entries.length === 0) return;
    const current = get().roles;
    // 記録があるパスだけが対象 (既定=キャラのままなら何もしない)。
    const hits = entries.filter(([oldPath]) => current[oldPath] !== undefined);
    if (hits.length === 0) return;
    const next = { ...current };
    for (const [oldPath, newPath] of hits) {
      const role = next[oldPath];
      delete next[oldPath];
      next[newPath] = role;
      markMutated(oldPath, newPath);
    }
    persist(next);
    set({ roles: next });
  },

  initialize: async () => {
    const store = await loadStore();
    if (!store) return; // 解禁しない (localStorage 運用を継続)

    let fileRoles: unknown;
    try {
      fileRoles = await store.get(ROLES_STORE_KEY);
    } catch (err) {
      console.warn("[referenceRoles] ファイル読み出しに失敗 (localStorage を継続使用):", err);
      return; // 解禁しない
    }

    if (fileRoles != null && typeof fileRoles === "object") {
      // ファイル有 = 正本。ただし起動〜解禁の間に触った path はセッション中の値を勝たせる
      // (この窓で付けたロールを黙って捨てない)。
      const { roles: next, dropped } = sanitizeRoles(fileRoles);
      if (dropped > 0) {
        // 認識できない値が混じっている = 新しいバージョンが書いた台帳を、
        // 古い自分が読んでいる可能性がある。**解禁しない** (2026-08-06 / DL-12)。
        // 解禁すると、除外した状態を次の mutate で正本として書き戻し、
        // 新バージョンで付けたロールを恒久的に失う。
        console.warn(
          "[referenceRoles] 認識できないロールを含むため、ファイルへの書き込みを封鎖します",
        );
        set({ roles: next });
        return;
      }
      const current = get().roles;
      for (const path of mutatedPaths) {
        const role = current[path];
        if (role === undefined) delete next[path];
        else next[path] = role;
      }
      mutatedPaths.clear();
      fileWriteUnlocked = true;
      set({ roles: next });
      // localStorage の冗長バックアップを最新化する。
      try {
        localStorage.setItem(ROLES_LS_KEY, JSON.stringify(next));
      } catch {
        /* private mode / quota — non-fatal */
      }
      return;
    }

    // ファイル未作成 = localStorage からの移行 or 新規ユーザー。
    // 現在の state (localStorage 由来) を正とする。
    const current = get().roles;
    if (Object.keys(current).length > 0) {
      console.info("[referenceRoles] localStorage から参照ロールをファイルへ移行");
      // **移行の成否を見てから解禁する** (2026-08-06 / DL-12)。
      // 失敗したまま解禁すると「ファイルには何も無いのに書けている前提」で動き、
      // localStorage だけが唯一の実体である事実が見えなくなる
      // (presets が 2026-08-06 に踏んだ穴と同型)。
      const ok = await persistToStore(current);
      if (!ok) {
        console.error(
          "[referenceRoles] ファイルへの移行に失敗。localStorage を正のまま維持する",
        );
        return; // 解禁しない。mutatedPaths も保持し、次回起動で再試行する
      }
    }
    mutatedPaths.clear();
    fileWriteUnlocked = true;
  },
}));
