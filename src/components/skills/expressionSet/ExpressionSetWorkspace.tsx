import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";

/**
 * 表情差分 Workspace（スタブ・スキル一覧v2.1 #2）
 *
 * 登録キャラに表情セットを一括生成し、同一人物に見えるかをAIが検品して
 * 崩れたカットだけ作り直す。SkillWorkspaceRouter が activeUiMode === "expressionSet"
 * のとき本コンポーネントを描画する。
 *
 * 現状は最小スタブ（後続の実装ワーカーが中身を実装する）。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function ExpressionSetWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-neutral-500">
        <p className="text-sm font-medium text-neutral-300">表情差分</p>
        <p className="text-xs">準備中</p>
      </div>
    </section>
  );
}
