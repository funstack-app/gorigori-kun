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
 *
 * source: override の出自 (R-1 修正 2026-06-07)。
 *  - "image" → 画像生成のシーン構築 / 手書き / 企画採用 由来。スキル切替・
 *              プロジェクト切替で #5 のとおりクリアしてよい。
 *  - "i2v"   → ストーリーカットを動画タブへ送ったときの i2v プロンプト由来。
 *              スキル切替でクリアすると送ったばかりの i2v が消える (R-1) ため、
 *              skillReset は i2v 由来を消さない。
 * value が null のときは source も "image" 扱い (デフォルト)。
 */
export type ScenePromptSource = "image" | "i2v";

type ScenePromptState = {
  value: string | null;
  source: ScenePromptSource;
  /** 出自を明示して set する。省略時は "image" 扱い。 */
  set: (next: string | null, source?: ScenePromptSource) => void;
  clear: () => void;
};

export const useScenePromptOverride = create<ScenePromptState>((set) => ({
  value: null,
  source: "image",
  set: (next, source = "image") => set({ value: next, source }),
  clear: () => set({ value: null, source: "image" }),
}));
