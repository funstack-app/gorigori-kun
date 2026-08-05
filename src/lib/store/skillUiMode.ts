/**
 * Skill UI Mode Store (β版で導入)
 *
 * 「スキル選択 = UIモード切替」の中心ストア。
 *
 * 設計方針 (Codex クロスレビュー 2026-05-19 確定):
 *   - 既存の useSkillMode (storyboard 用の旧フラグ) とは別ストア
 *   - `purpose` (用途セレクタ) と分離する
 *   - `activeUiMode` を単一の真実とする
 *   - α版の作品モードはこのストアの "default" として保護
 *
 * 想定するUIモード:
 *   - "default"    : α版の作品モード (既存 GenerationWorkspace そのまま)
 *   - "storyboard" : ストーリーカットスキル専用UI (β版で実装)
 *   - "multiAngle" : マルチアングルスキル専用UI (β版で実装)
 *
 * 拡張時はここに UiMode を追加する。
 */

import { create } from "zustand";

export type UiMode =
  | "default"
  | "storyboard"
  | "multiAngle"
  | "scene3d"
  | "characterRegister"
  | "expressionSet"
  | "sceneRecreate"
  | "comic"
  | "redline"
  | "regulationCheck"
  | "productSet"
  | "sticker";

type SkillUiModeState = {
  /** 現在アクティブなスキルの ID。null なら作品モード */
  activeSkillId: string | null;
  /** 現在のUIモード。activeSkillId と一意に対応する */
  activeUiMode: UiMode;

  /**
   * スキルに入る。スキルIDから UiMode を解決して切り替える。
   */
  enterSkill: (skillId: string, uiMode: UiMode) => void;

  /** 作品モードに戻る */
  exitSkill: () => void;
};

export const useSkillUiMode = create<SkillUiModeState>((set) => ({
  activeSkillId: null,
  activeUiMode: "default",

  enterSkill: (skillId, uiMode) => {
    set({ activeSkillId: skillId, activeUiMode: uiMode });
  },

  exitSkill: () => {
    set({ activeSkillId: null, activeUiMode: "default" });
  },
}));

/**
 * スキル ID から UI モードを引くマップ。
 * 新しいスキルを追加する時はここに登録する。
 */
export const SKILL_UI_MODE_MAP: Record<string, UiMode> = {
  "gori-storyboard": "storyboard",
  "gori-multi-angle": "multiAngle",
  "gori-scene-3d": "scene3d",
  "gori-character-register": "characterRegister",
  "gori-expression-set": "expressionSet",
  "gori-scene-recreate": "sceneRecreate",
  "gori-comic": "comic",
  "gori-redline": "redline",
  "gori-regulation-check": "regulationCheck",
  "gori-product-set": "productSet",
  "gori-sticker": "sticker",
};

export function resolveUiMode(skillId: string): UiMode {
  return SKILL_UI_MODE_MAP[skillId] ?? "default";
}
