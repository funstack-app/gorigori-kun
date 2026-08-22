import { create } from "zustand";

/**
 * ライブラリ画面で「複数の画像を選んで一括処理」するための選択状態。
 *
 * - selected: 選択中の画像 path のセット
 * - selectionMode: チェックボックスを表示する選択モードかどうか
 *
 * 選択モードに入ると各画像にチェックボックスが出て、クリックで選択 toggle。
 * 通常モードではチェックボックスは出ず、画像クリックは従来動作（参照追加など）。
 *
 * プロジェクト一括追加・一括リネーム等の起点になる。
 */

type LibrarySelectionState = {
  selectionMode: boolean;
  selected: Set<string>;
  enterMode: () => void;
  exitMode: () => void;
  toggle: (path: string) => void;
  /** 日付見出しなど、複数 path をまとめて選択/解除する。 */
  toggleMany: (paths: string[]) => void;
  selectAll: (paths: string[]) => void;
  /** 現在表示中の path だけを残し、画面外の選択を一括操作から外す。 */
  retainVisible: (paths: readonly string[]) => void;
  clear: () => void;
};

export const useLibrarySelection = create<LibrarySelectionState>((set, get) => ({
  selectionMode: false,
  selected: new Set<string>(),
  enterMode: () => set({ selectionMode: true }),
  exitMode: () => set({ selectionMode: false, selected: new Set() }),
  toggle: (path) => {
    const next = new Set(get().selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ selected: next, selectionMode: next.size > 0 });
  },
  toggleMany: (paths) => {
    const next = toggleSelectionPaths(get().selected, paths);
    set({ selected: next, selectionMode: next.size > 0 });
  },
  selectAll: (paths) => {
    set({ selected: new Set(paths) });
  },
  retainVisible: (paths) => {
    const selected = get().selected;
    if (selected.size === 0) return;
    const visible = new Set(paths);
    const next = new Set(Array.from(selected).filter((path) => visible.has(path)));
    if (next.size === selected.size) return;
    set({ selected: next, selectionMode: next.size > 0 });
  },
  clear: () => set({ selected: new Set(), selectionMode: false }),
}));

/**
 * paths がすべて選択済みなら全解除、1件でも未選択なら全追加する純関数。
 * 元の Set は変更しない。
 */
export function toggleSelectionPaths(
  selected: ReadonlySet<string>,
  paths: readonly string[],
): Set<string> {
  const uniquePaths = Array.from(new Set(paths));
  const next = new Set(selected);
  if (uniquePaths.length === 0) return next;
  const allSelected = uniquePaths.every((path) => next.has(path));
  for (const path of uniquePaths) {
    if (allSelected) next.delete(path);
    else next.add(path);
  }
  return next;
}
