import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";

/**
 * レギュレーション検査 Workspace（スタブ・スキル一覧v2.1 #11）
 *
 * 入稿物一式を文字量比率・必須表記・ロゴ・NG表現の観点で検査し、根拠付きの
 * 指摘一覧を返す。SkillWorkspaceRouter が activeUiMode === "regulationCheck"
 * のとき本コンポーネントを描画する。
 *
 * 現状は最小スタブ（後続の実装ワーカーが中身を実装する）。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 */
export function RegulationCheckWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-neutral-500">
        <p className="text-sm font-medium text-neutral-300">レギュレーション検査</p>
        <p className="text-xs">準備中</p>
      </div>
    </section>
  );
}
