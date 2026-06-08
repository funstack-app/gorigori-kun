import { create } from "zustand";

// Magnific オプショナル拡張のモデル選択 (2026-06-08)。
// 接続先タブで「Magnific」を選び、モデルを選んだ状態を持つ。
// selectedModels: [] = Magnific未選択(=コア or Higgsfield)、1件 = 単一生成、2件以上 = 比較生成。
// Higgsfield の selectedModels(配列) と同じ思想。比較生成は最大4モデル。

const LS_KEY = "magnific.selectedModels";
export const MAX_MAGNIFIC_COMPARE = 4;

function load(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function save(models: string[]): void {
  try {
    if (models.length > 0) localStorage.setItem(LS_KEY, JSON.stringify(models));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

type MagnificModelState = {
  /** 選択中の Magnific モデルid配列。[] = 未選択。 */
  selectedModels: string[];
  /** モデルを選択/解除トグル。最大 MAX_MAGNIFIC_COMPARE まで。Immutable に新規配列を作る。 */
  toggleModel: (model: string) => void;
  /** 全選択解除。 */
  clear: () => void;
};

export const useMagnificModel = create<MagnificModelState>((set) => ({
  selectedModels: load(),
  toggleModel: (model) =>
    set((state) => {
      const exists = state.selectedModels.includes(model);
      // Immutability: 直接変更せず spread で新規配列を作る。
      const next = exists
        ? state.selectedModels.filter((m) => m !== model)
        : state.selectedModels.length >= MAX_MAGNIFIC_COMPARE
          ? state.selectedModels // 上限なら追加しない
          : [...state.selectedModels, model];
      save(next);
      return { selectedModels: next };
    }),
  clear: () => {
    save([]);
    return set({ selectedModels: [] });
  },
}));
