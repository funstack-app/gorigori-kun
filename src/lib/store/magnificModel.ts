import { create } from "zustand";

// Magnific オプショナル拡張のモデル選択 (2026-06-08)。
// 接続先タブで「Magnific」を選び、モデルを1つ選んだ状態を持つ。
// null = Magnific未選択(=コア or Higgsfield を使う)。比較生成はサポートしない(MVP)。

const LS_KEY = "magnific.selectedModel";

function load(): string | null {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function save(model: string | null): void {
  try {
    if (model) localStorage.setItem(LS_KEY, model);
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

type MagnificModelState = {
  /** 選択中の Magnific モデルid。null = 未選択(Magnificを使わない)。 */
  selectedModel: string | null;
  selectModel: (model: string | null) => void;
};

export const useMagnificModel = create<MagnificModelState>((set) => ({
  selectedModel: load(),
  selectModel: (model) => {
    save(model);
    set({ selectedModel: model });
  },
}));
