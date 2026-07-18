import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";

/**
 * 赤入れ反映 Workspace（スタブ・スキル一覧v2.1 #10）
 *
 * 赤入れPDF・注釈画像を読み取り、指している箇所をマスク化して部分修正。
 * 検品してワンタップで差し戻せる。SkillWorkspaceRouter が activeUiMode === "redline"
 * のとき本コンポーネントを描画する。
 *
 * 現状は最小スタブ（後続の実装ワーカーが中身を実装する）。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function RedlineWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-neutral-500">
        <p className="text-sm font-medium text-neutral-300">赤入れ反映</p>
        <p className="text-xs">準備中</p>
      </div>
    </section>
  );
}
