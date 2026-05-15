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
  selectAll: (paths: string[]) => void;
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
    set({ selected: next });
  },
  selectAll: (paths) => {
    set({ selected: new Set(paths) });
  },
  clear: () => set({ selected: new Set() }),
}));
