import { useEffect } from "react";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useWorkspace } from "../../../lib/store/workspace";
import { ensureStoryboardEventListener } from "../../../lib/storyboard/events";
import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { EditWorkspace } from "../../EditWorkspace";
import { Timeline } from "../../GenerationWorkspace";
import { PlanWorkspace } from "../../PlanWorkspace";
import { VideoGenerationWorkspace } from "../../VideoGenerationWorkspace";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { CutGridReviewPanel } from "./CutGridReviewPanel";
import { GenerationProgressPanel } from "./GenerationProgressPanel";
import { GoalChatPanel } from "./GoalChatPanel";
import { PhaseRail } from "./PhaseRail";
import { SketchReviewPanel } from "./SketchReviewPanel";

/**
 * Storyboard Workspace (β版)
 *
 * STΛCK 指示 (2026-05-20):
 *   - 「用途セレクタ廃止 → スキル選択で UI 切替」方式の本命 UI
 *   - 4 Phase の Agentic フロー (AI 駆動で深掘りしながら絵コンテを作る)
 *
 * Phase:
 *   1. goal       — AI が深掘り質問で「作りたい映像」を引き出す
 *   2. sketch     — 絵コンテ的なテキストレイアウトを提示してレビュー
 *   3. generation — 各カットを順次生成。進捗を可視化
 *   4. review     — 完成カットをグリッド表示、最終確認
 *
 * 既存の GenerationWorkspace は触らない。
 * SkillWorkspaceRouter が activeUiMode === "storyboard" のときに本コンポーネントを描画する。
 *
 * FB#1 / FB#4 修正 (2026-06-06 夜):
 *   タブ (企画 / 画像生成 / 動画生成 / 編集) はストーリーモード中でも機能させる。
 *   - activeTab === "generate" → ストーリーカットの 4-Phase フロー (本スキルの本体)
 *   - activeTab === "video"    → 動画生成タブをインライン描画 (確定カットの i2v 連携先)
 *   - activeTab === "plan"     → 企画タブ (カット再検討の戻り先)
 *   - activeTab === "edit"     → 編集タブ
 *   これにより「動画タブへ送る」で動画タブに切り替わっても、ストーリーモードからは
 *   抜けない (タブで戻ればストーリーカット UI に復帰できる)。
 */
export function StoryboardWorkspace() {
  const phase = useStoryboardRun((s) => s.phase);
  const activeTab = useWorkspace((s) => s.activeTab);

  useEffect(() => {
    void ensureStoryboardEventListener();
  }, []);

  // 動画 / 企画 / 編集タブは、ストーリーモードを保ったままインライン描画する。
  // タブ列 (WorkspaceTabs) は共通ヘッダーに残すので、ユーザーはいつでも
  // 「画像生成」タブを押してストーリーカットの Phase フローに戻れる。
  if (activeTab !== "generate") {
    return (
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
        <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
          <div className="flex items-center gap-3">
            <WorkspaceTabs />
            <ActiveProjectSelector />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
          {activeTab === "plan" && <PlanWorkspace />}
          {activeTab === "video" && <VideoGenerationWorkspace timeline={<Timeline />} />}
          {activeTab === "edit" && <EditWorkspace />}
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      {/* Phase レール (現フェーズを左側に縦表示。クリックで戻れる) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PhaseRail />

        <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
          {phase === "goal" && <GoalChatPanel />}
          {phase === "sketch" && <SketchReviewPanel />}
          {phase === "generation" && <GenerationProgressPanel />}
          {phase === "review" && <CutGridReviewPanel />}
        </div>
      </div>
    </section>
  );
}
