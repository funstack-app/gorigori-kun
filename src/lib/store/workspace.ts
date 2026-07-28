import { create } from "zustand";

export type WorkspaceTab = "plan" | "generate" | "video" | "edit";
export type WorkspacePurpose = "artwork" | "ad" | "videoStory";

/**
 * 生成タイムラインのサムネサイズ。
 *
 * 「グリッド列数」をそのまま値にする数値スケール（小さい値 = 列少ない = サムネ大）。
 * UI のスライダーは min=2 max=8 で連続調整できる。
 *
 * 旧仕様（'small' / 'medium' / 'large' の文字列）は読み込み時にマイグレートする。
 */
export type TimelineSize = number;

export const TIMELINE_SIZE_MIN = 2;
export const TIMELINE_SIZE_MAX = 8;
export const TIMELINE_SIZE_DEFAULT = 4;

/**
 * ストーリーカット3画面 (絵コンテレビュー / 本生成進捗 / 最終確認) 共有のカードサイズ。
 *
 * 「アスペクト比 × 3段階レベル」の2次元テーブルを引くための level 値であり、
 * 列数を直に指す timelineSize (2-8) とは意味論が違うので別状態にする。
 * 1=大きく / 2=既定 / 3=小さく。
 */
export type StoryboardCardSize = number;

export const STORYBOARD_CARD_SIZE_MIN = 1;
export const STORYBOARD_CARD_SIZE_MAX = 3;
export const STORYBOARD_CARD_SIZE_DEFAULT = 2;

const WORKSPACE_PURPOSE_IDS = ["artwork", "ad", "videoStory"] as const;
const TIMELINE_SIZE_LS_KEY = "workspace.timelineSize";
const STORYBOARD_CARD_SIZE_LS_KEY = "workspace.storyboardCardSize";

export function isWorkspacePurpose(value: string): value is WorkspacePurpose {
  return (WORKSPACE_PURPOSE_IDS as readonly string[]).includes(value);
}

export function clampTimelineSize(n: number): TimelineSize {
  if (!Number.isFinite(n)) return TIMELINE_SIZE_DEFAULT;
  return Math.min(TIMELINE_SIZE_MAX, Math.max(TIMELINE_SIZE_MIN, Math.round(n)));
}

function readPersistedTimelineSize(): TimelineSize {
  try {
    const raw = localStorage.getItem(TIMELINE_SIZE_LS_KEY);
    if (!raw) return TIMELINE_SIZE_DEFAULT;
    // 旧文字列値のマイグレーション
    if (raw === "small") return 6;
    if (raw === "medium") return 4;
    if (raw === "large") return 3;
    const n = Number(raw);
    if (Number.isFinite(n)) return clampTimelineSize(n);
  } catch {
    /* private mode etc. */
  }
  return TIMELINE_SIZE_DEFAULT;
}

function persistTimelineSize(size: TimelineSize) {
  try {
    localStorage.setItem(TIMELINE_SIZE_LS_KEY, String(size));
  } catch {
    /* non-fatal */
  }
}

export function clampStoryboardCardSize(n: number): StoryboardCardSize {
  if (!Number.isFinite(n)) return STORYBOARD_CARD_SIZE_DEFAULT;
  return Math.min(
    STORYBOARD_CARD_SIZE_MAX,
    Math.max(STORYBOARD_CARD_SIZE_MIN, Math.round(n)),
  );
}

function readPersistedStoryboardCardSize(): StoryboardCardSize {
  try {
    const raw = localStorage.getItem(STORYBOARD_CARD_SIZE_LS_KEY);
    if (!raw) return STORYBOARD_CARD_SIZE_DEFAULT;
    const n = Number(raw);
    if (Number.isFinite(n)) return clampStoryboardCardSize(n);
  } catch {
    /* private mode etc. */
  }
  return STORYBOARD_CARD_SIZE_DEFAULT;
}

function persistStoryboardCardSize(size: StoryboardCardSize) {
  try {
    localStorage.setItem(STORYBOARD_CARD_SIZE_LS_KEY, String(size));
  } catch {
    /* non-fatal */
  }
}

type WorkspaceState = {
  activeTab: WorkspaceTab;
  purpose: WorkspacePurpose;
  timelineSize: TimelineSize;
  storyboardCardSize: StoryboardCardSize;
  setActiveTab: (tab: WorkspaceTab) => void;
  setPurpose: (purpose: WorkspacePurpose) => void;
  setTimelineSize: (size: TimelineSize) => void;
  setStoryboardCardSize: (size: StoryboardCardSize) => void;
};

export const useWorkspace = create<WorkspaceState>((set) => ({
  activeTab: "generate",
  purpose: "artwork",
  timelineSize: readPersistedTimelineSize(),
  storyboardCardSize: readPersistedStoryboardCardSize(),
  setActiveTab: (activeTab) => set({ activeTab }),
  setPurpose: (purpose) => set({ purpose }),
  setTimelineSize: (size) => {
    const next = clampTimelineSize(size);
    persistTimelineSize(next);
    set({ timelineSize: next });
  },
  setStoryboardCardSize: (size) => {
    const next = clampStoryboardCardSize(size);
    persistStoryboardCardSize(next);
    set({ storyboardCardSize: next });
  },
}));
