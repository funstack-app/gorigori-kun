import { create } from "zustand";

/**
 * プロンプトプリセット管理。Midjourney Code Manager 仕様を参考に、
 * カテゴリ × プリセット のシンプルな 2 階層で管理する。
 *
 * 永続化: localStorage（MVP）。エクスポート機能は後追い。
 */

export type PresetCategory = {
  id: string;
  name: string;
  /** 一覧で色マーカーに使う hex（#6366f1 等）。ユーザーがカラーピッカーで自由に変更可。 */
  color: string;
  /** カテゴリに紐づく任意タグ。検索やプリセットへの自動補完候補に使う。 */
  tags?: string[];
};

/**
 * サムネ表示時の focal point（注目点）と zoom。
 * Midjourney Code Manager 流の「ズーム + ドラッグで好きな位置に」に対応。
 *
 * - x / y: 0..1 の正規化座標。0 = 左/上、1 = 右/下、0.5 = 中央
 * - zoom: 1.0 = 等倍（object-cover と同じ）、3.0 = 3 倍ズーム
 *
 * 未指定なら center / zoom 1.0（=従来の object-cover と同等）。
 */
export type ThumbnailFocus = {
  x: number;
  y: number;
  zoom: number;
};

export const FOCUS_DEFAULT: ThumbnailFocus = { x: 0.5, y: 0.5, zoom: 1 };
export const FOCUS_ZOOM_MIN = 1;
export const FOCUS_ZOOM_MAX = 4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampZoom = (v: number): number =>
  Math.min(FOCUS_ZOOM_MAX, Math.max(FOCUS_ZOOM_MIN, v));

/** focus 値を正規化（範囲外を clamp、未定義は中央 zoom1 へ）。 */
export function normalizeFocus(focus: ThumbnailFocus | undefined): ThumbnailFocus {
  if (!focus) return FOCUS_DEFAULT;
  return {
    x: clamp01(focus.x),
    y: clamp01(focus.y),
    zoom: clampZoom(focus.zoom),
  };
}

/**
 * 旧 9-grid 文字列値（"tl".."br"）から新 {x,y,zoom} へのマイグレーション。
 * 既存 localStorage を読み込む際に通す。
 */
function migrateLegacyFocus(value: unknown): ThumbnailFocus | undefined {
  if (value == null) return undefined;
  if (typeof value === "object" && "x" in (value as object) && "y" in (value as object)) {
    return normalizeFocus(value as ThumbnailFocus);
  }
  if (typeof value !== "string") return undefined;
  const map: Record<string, [number, number]> = {
    tl: [0, 0], tc: [0.5, 0], tr: [1, 0],
    cl: [0, 0.5], cc: [0.5, 0.5], cr: [1, 0.5],
    bl: [0, 1], bc: [0.5, 1], br: [1, 1],
  };
  const xy = map[value];
  if (!xy) return undefined;
  return { x: xy[0], y: xy[1], zoom: 1 };
}

/**
 * <img> 要素に当てる CSS スタイル。
 * - object-cover を前提に、object-position で focal point の周辺を見せる
 * - transform: scale で zoom を適用、transform-origin を focal point に合わせる
 *   → ズームアップしても focal point が画面中心に留まる
 */
export function focusToImageStyle(focus: ThumbnailFocus | undefined): {
  objectPosition: string;
  transform: string;
  transformOrigin: string;
} {
  const f = normalizeFocus(focus);
  const xPct = `${(f.x * 100).toFixed(2)}%`;
  const yPct = `${(f.y * 100).toFixed(2)}%`;
  return {
    objectPosition: `${xPct} ${yPct}`,
    transform: f.zoom !== 1 ? `scale(${f.zoom})` : "none",
    transformOrigin: `${xPct} ${yPct}`,
  };
}

/**
 * F-#7 (2026-05-19): プリセットに添付されるキャラ画像 (= 参照画像) の
 * 簡略 record。ファイルパスとオプションのロールだけ持ち、プリセット呼び出し時に
 * composer.references へ流す。
 */
export type PresetAttachedImage = {
  path: string;
  /** "subject" | "look" 等。composer.ReferenceRole と互換だが、依存を避けて string で持つ */
  role?: string;
};

export type Preset = {
  id: string;
  name: string;
  /** プロンプトに挿入される本文。日本語可、@imgN 記法も使える */
  prompt: string;
  /** どのカテゴリに属すか。null は「未分類」 */
  categoryId: string | null;
  description?: string;
  /** プリセット個別タグ（検索用）。 */
  tags?: string[];
  /**
   * サムネイル（base64 data URL）。1 枚のみ保存（MVP）。
   * 長辺 1024 / JPEG q=0.92 で 200-400KB 程度を想定。
   */
  thumbnail?: string;
  /** サムネ表示時のフォーカス点（9-grid）。未指定は中央（cc）。 */
  thumbnailFocus?: ThumbnailFocus;
  /**
   * F-#7 (2026-05-19): プリセットに紐づくキャラ添付画像。
   * Ta4low さん要望「プリセットでキャラ画像も保存」対応。
   * プリセット呼び出し時に composer.references にも流し込む。
   */
  attachedImages?: PresetAttachedImage[];
  /** お気に入りフラグ。Code Manager と同じ仕様（チップで絞り込み可）。 */
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SortKey =
  | "updatedDesc"
  | "updatedAsc"
  | "createdDesc"
  | "createdAsc"
  | "nameAsc"
  | "nameDesc"
  | "tagCountDesc";

const CATEGORIES_LS_KEY = "presets.categories";
const PRESETS_LS_KEY = "presets.presets";

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** localStorage から読んだ Preset 配列に focus マイグレートを適用する。 */
function loadPresets(): Preset[] {
  const raw = readPersisted<Preset[]>(PRESETS_LS_KEY, []);
  return raw.map((p) => {
    const migrated = migrateLegacyFocus(p.thumbnailFocus as unknown);
    if (!migrated) {
      // thumbnailFocus が無い / 認識できない値 → そのまま削除
      const { thumbnailFocus: _drop, ...rest } = p as Preset & { thumbnailFocus?: unknown };
      return rest as Preset;
    }
    return { ...p, thumbnailFocus: migrated };
  });
}

function persist<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function sortPresets(presets: Preset[], key: SortKey): Preset[] {
  const byNameAsc = (a: Preset, b: Preset) => a.name.localeCompare(b.name, "ja");
  return [...presets].sort((a, b) => {
    switch (key) {
      case "updatedAsc":
        return a.updatedAt - b.updatedAt || byNameAsc(a, b);
      case "createdDesc":
        return b.createdAt - a.createdAt || byNameAsc(a, b);
      case "createdAsc":
        return a.createdAt - b.createdAt || byNameAsc(a, b);
      case "nameAsc":
        return byNameAsc(a, b);
      case "nameDesc":
        return byNameAsc(b, a);
      case "tagCountDesc":
        return (b.tags?.length ?? 0) - (a.tags?.length ?? 0) || byNameAsc(a, b);
      case "updatedDesc":
      default:
        return b.updatedAt - a.updatedAt || byNameAsc(a, b);
    }
  });
}

const DEFAULT_CATEGORIES: PresetCategory[] = [
  { id: "default-portrait", name: "ポートレート", color: "#ec4899" },
  { id: "default-product", name: "プロダクト", color: "#6366f1" },
  { id: "default-landscape", name: "風景", color: "#10b981" },
];

type PresetsState = {
  categories: PresetCategory[];
  presets: Preset[];

  addCategory: (name: string, color?: string, tags?: string[]) => PresetCategory;
  updateCategory: (id: string, updates: Partial<Omit<PresetCategory, "id">>) => void;
  removeCategory: (id: string) => void;

  addPreset: (data: Omit<Preset, "id" | "createdAt" | "updatedAt">) => Preset;
  updatePreset: (id: string, updates: Partial<Omit<Preset, "id" | "createdAt">>) => void;
  removePreset: (id: string) => void;

  /** お気に入り toggle。Code Manager と同じ仕様。 */
  toggleFavorite: (id: string) => void;

  /** プリセットを並び替え。fromIndex の要素を toIndex の位置に移動。同じカテゴリ内のみ並び替え可能。 */
  reorderPresets: (fromId: string, toId: string) => void;
};

export const usePresets = create<PresetsState>((set, get) => ({
  categories: readPersisted<PresetCategory[]>(CATEGORIES_LS_KEY, DEFAULT_CATEGORIES),
  presets: loadPresets(),

  addCategory: (name, color = "#6366f1", tags) => {
    const category: PresetCategory = {
      id: generateId(),
      name: name.trim(),
      color,
      tags: tags && tags.length > 0 ? tags : undefined,
    };
    const next = [...get().categories, category];
    persist(CATEGORIES_LS_KEY, next);
    set({ categories: next });
    return category;
  },

  updateCategory: (id, updates) => {
    const next = get().categories.map((c) => (c.id === id ? { ...c, ...updates } : c));
    persist(CATEGORIES_LS_KEY, next);
    set({ categories: next });
  },

  removeCategory: (id) => {
    const nextCategories = get().categories.filter((c) => c.id !== id);
    // 紐づくプリセットは「未分類」へ
    const nextPresets = get().presets.map((p) =>
      p.categoryId === id ? { ...p, categoryId: null, updatedAt: Date.now() } : p,
    );
    persist(CATEGORIES_LS_KEY, nextCategories);
    persist(PRESETS_LS_KEY, nextPresets);
    set({ categories: nextCategories, presets: nextPresets });
  },

  addPreset: (data) => {
    const now = Date.now();
    const preset: Preset = {
      id: generateId(),
      name: data.name.trim(),
      prompt: data.prompt,
      categoryId: data.categoryId,
      description: data.description?.trim() || undefined,
      tags: data.tags && data.tags.length > 0 ? data.tags : undefined,
      thumbnail: data.thumbnail,
      thumbnailFocus: data.thumbnailFocus,
      // STΛCK 報告 (2026-05-19): F-#7 で Preset 型に attachedImages を追加した
      // が、addPreset 内で参照されておらず localStorage に保存されないバグ。
      // ここで data.attachedImages を引き継ぐことで「プリセットにキャラ画像が
      // 登録されない」問題を根治。
      attachedImages:
        data.attachedImages && data.attachedImages.length > 0
          ? data.attachedImages
          : undefined,
      favorite: data.favorite,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().presets, preset];
    persist(PRESETS_LS_KEY, next);
    set({ presets: next });
    return preset;
  },

  updatePreset: (id, updates) => {
    const next = get().presets.map((p) =>
      p.id === id
        ? {
            ...p,
            ...updates,
            // ID と createdAt は update しないが、念のため上書き防止
            id: p.id,
            createdAt: p.createdAt,
            updatedAt: Date.now(),
          }
        : p,
    );
    persist(PRESETS_LS_KEY, next);
    set({ presets: next });
  },

  removePreset: (id) => {
    const next = get().presets.filter((p) => p.id !== id);
    persist(PRESETS_LS_KEY, next);
    set({ presets: next });
  },

  toggleFavorite: (id) => {
    const next = get().presets.map((p) =>
      p.id === id
        ? { ...p, favorite: !p.favorite, updatedAt: Date.now() }
        : p,
    );
    persist(PRESETS_LS_KEY, next);
    set({ presets: next });
  },

  reorderPresets: (fromId, toId) => {
    if (fromId === toId) return;
    const current = get().presets;
    const fromIdx = current.findIndex((p) => p.id === fromId);
    const toIdx = current.findIndex((p) => p.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...current];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    persist(PRESETS_LS_KEY, next);
    set({ presets: next });
  },
}));
