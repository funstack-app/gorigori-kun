import { create } from "zustand";

/**
 * シーン生成タブのプロンプト override を保持するグローバルストア。
 *
 * もともと useSceneGeneration の useState で管理していたが、
 * 企画タブから「採用」ボタンで外部から書き換える必要が出たため、
 * Zustand に昇格して任意の箇所から set できるようにした。
 *
 * - value === null  → シーン構築から自動生成された prompt を使う
 * - value === ""    → 空入力（ユーザーが意図的にクリアした）
 * - value === "..." → ユーザー入力 or 企画から採用したプロンプト
 *
 * 永続化はしない（セッション中のみ。app 再起動でリセットされる方が
 * 「シーン構築の状態と乖離した古い override が残る」事故を防げる）。
 */
type ScenePromptState = {
  value: string | null;
  set: (next: string | null) => void;
  clear: () => void;
};

export const useScenePromptOverride = create<ScenePromptState>((set) => ({
  value: null,
  set: (next) => set({ value: next }),
  clear: () => set({ value: null }),
}));
