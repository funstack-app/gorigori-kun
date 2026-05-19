import { useSkillUiMode } from "../lib/store/skillUiMode";
import { GenerationWorkspace } from "./GenerationWorkspace";
import { StoryboardWorkspace } from "./skills/storyboard/StoryboardWorkspace";

/**
 * Skill UI Router
 *
 * useSkillUiMode.activeUiMode を見て、適切な Workspace を表示する。
 *
 * 設計方針 (Codex クロスレビュー 2026-05-19):
 *   - default 時は既存の GenerationWorkspace をそのまま使う
 *     → α版の作品モード機能を完全保護
 *   - storyboard, multiAngle は β版で順次実装
 *     → 当面は default にフォールバック
 *
 * 新しいスキル専用UIを追加する手順:
 *   1. src/components/skills/<モード名>/Workspace.tsx を新規作成
 *   2. ここに import + case 追加
 *   3. lib/store/skillUiMode.ts の SKILL_UI_MODE_MAP に登録
 *
 * 既存の GenerationWorkspace は触らない。スキル専用UIは別ファイル/別ディレクトリ。
 */
export function SkillWorkspaceRouter() {
  const activeUiMode = useSkillUiMode((s) => s.activeUiMode);

  switch (activeUiMode) {
    case "storyboard":
      return <StoryboardWorkspace />;
    case "multiAngle":
      // β版で MultiAngleWorkspace を実装するまでは default で動かす
      return <GenerationWorkspace />;
    case "default":
    default:
      return <GenerationWorkspace />;
  }
}
