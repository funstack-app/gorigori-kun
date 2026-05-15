import { create } from "zustand";

/**
 * 画像プレビューモーダルの状態。
 *
 * - path: 現在表示中の画像 path
 * - siblings: 矢印キー (← / →) で巡回する候補リスト
 *   open(path) だけ渡されたら useImages.items 全体を fallback として使う想定
 *   (ImagePreviewModal 側で逐次決める)
 *
 * open(path, siblings?) で前後リストを明示指定すると、矢印キーでその文脈内
 * (例: プロジェクト内、セッション内 turn 内) だけを巡回する。
 */
type State = {
  path?: string;
  siblings?: string[];
  open: (path: string, siblings?: string[]) => void;
  close: () => void;
  /** 矢印キー対応: 前/次の path に切替 (siblings がなければ何もしない) */
  goPrev: () => void;
  goNext: () => void;
};

export const useImagePreview = create<State>((set, get) => ({
  path: undefined,
  siblings: undefined,
  open: (path, siblings) =>
    set({
      path,
      siblings: siblings && siblings.length > 0 ? siblings : undefined,
    }),
  close: () => set({ path: undefined, siblings: undefined }),
  goPrev: () => {
    const { path, siblings } = get();
    if (!path || !siblings || siblings.length === 0) return;
    const idx = siblings.indexOf(path);
    if (idx < 0) return;
    const prev = siblings[(idx - 1 + siblings.length) % siblings.length];
    set({ path: prev });
  },
  goNext: () => {
    const { path, siblings } = get();
    if (!path || !siblings || siblings.length === 0) return;
    const idx = siblings.indexOf(path);
    if (idx < 0) return;
    const next = siblings[(idx + 1) % siblings.length];
    set({ path: next });
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.imagePreview = useImagePreview;
}
