import { lazy, Suspense } from "react";

import { useSkillUiMode } from "../lib/store/skillUiMode";
import { GenerationWorkspace } from "./GenerationWorkspace";
import { StoryboardWorkspace } from "./skills/storyboard/StoryboardWorkspace";
import { MultiAngleWorkspace } from "./skills/multiAngle/MultiAngleWorkspace";
import { CharacterRegisterWorkspace } from "./skills/character/CharacterRegisterWorkspace";
import { ExpressionSetWorkspace } from "./skills/expressionSet/ExpressionSetWorkspace";
import { SceneRecreateWorkspace } from "./skills/sceneRecreate/SceneRecreateWorkspace";
import { ComicWorkspace } from "./skills/comic/ComicWorkspace";
import { RedlineWorkspace } from "./skills/redline/RedlineWorkspace";
import { RegulationCheckWorkspace } from "./skills/regulationCheck/RegulationCheckWorkspace";
import { ProductSetWorkspace } from "./skills/productSet/ProductSetWorkspace";

// three.js を含むためメインバンドルから分離(スキルに入った時だけロード)
const Scene3dWorkspace = lazy(() =>
  import("./skills/scene3d/Scene3dWorkspace").then((m) => ({
    default: m.Scene3dWorkspace,
  })),
);

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
      return <MultiAngleWorkspace />;
    case "characterRegister":
      return <CharacterRegisterWorkspace />;
    case "expressionSet":
      return <ExpressionSetWorkspace />;
    case "sceneRecreate":
      return <SceneRecreateWorkspace />;
    case "comic":
      return <ComicWorkspace />;
    case "redline":
      return <RedlineWorkspace />;
    case "regulationCheck":
      return <RegulationCheckWorkspace />;
    case "productSet":
      return <ProductSetWorkspace />;
    case "scene3d":
      return (
        <Suspense
          fallback={
            <section className="flex min-h-0 flex-1 items-center justify-center bg-[#121212] text-sm text-neutral-500">
              3Dシーンを準備中…
            </section>
          }
        >
          <Scene3dWorkspace />
        </Suspense>
      );
    case "default":
    default:
      return <GenerationWorkspace />;
  }
}
