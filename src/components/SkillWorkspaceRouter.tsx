import { lazy, Suspense } from "react";

import { useSkillUiMode } from "../lib/store/skillUiMode";
import { useWorkspace } from "../lib/store/workspace";
import { ActiveProjectSelector } from "./ActiveProjectSelector";
import { EditWorkspace } from "./EditWorkspace";
import { GenerationWorkspace, Timeline } from "./GenerationWorkspace";
import { PlanWorkspace } from "./PlanWorkspace";
import { VideoGenerationWorkspace } from "./VideoGenerationWorkspace";
import { WorkspaceTabs } from "./WorkspaceTabs";
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
  const activeTab = useWorkspace((s) => s.activeTab);

  if (activeUiMode === "default") {
    return <GenerationWorkspace />;
  }

  if (activeUiMode === "storyboard") {
    return <StoryboardWorkspace />;
  }

  const skillWorkspace = (() => {
    switch (activeUiMode) {
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
      default:
        return null;
    }
  })();

  return (
    <>
      <div style={{ display: activeTab === "generate" ? "contents" : "none" }}>
        {skillWorkspace}
      </div>
      {activeTab !== "generate" && (
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
          <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
            <div className="flex items-center gap-3">
              <WorkspaceTabs />
              <ActiveProjectSelector />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
            {activeTab === "plan" && <PlanWorkspace />}
            {activeTab === "video" && (
              <VideoGenerationWorkspace timeline={<Timeline />} />
            )}
            {activeTab === "edit" && <EditWorkspace />}
          </div>
        </section>
      )}
    </>
  );
}
