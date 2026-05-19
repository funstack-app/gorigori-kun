import { useEffect } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { ensureStoryboardEventListener } from "../../../lib/storyboard/events";

import { PhaseRail } from "./PhaseRail";
import { GoalChatPanel } from "./GoalChatPanel";
import { SketchReviewPanel } from "./SketchReviewPanel";
import { GenerationProgressPanel } from "./GenerationProgressPanel";
import { CutGridReviewPanel } from "./CutGridReviewPanel";

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
 */
export function StoryboardWorkspace() {
  const phase = useStoryboardRun((s) => s.phase);

  useEffect(() => {
    void ensureStoryboardEventListener();
  }, []);

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
