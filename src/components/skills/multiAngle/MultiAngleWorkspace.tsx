import { useEffect } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { ensureMultiAngleEventListener } from "../../../lib/multiangle/events";

import { AngleSettingsPanel } from "./AngleSettingsPanel";
import { AngleGridPanel } from "./AngleGridPanel";

/**
 * マルチアングル Workspace（β版）
 *
 * ユーザー合意 (2026-06-06):
 *   - 画像生成タブのような「左に設定 / 右に出力グリッド」の2ペイン
 *   - 1枚の被写体参照から、選んだ構図カット（最大30）を並列で一気に生成
 *   - 出力は普通の1枚画像。各カットは独立してグリッドに並ぶ
 *   - ActiveProjectSelector で案件横断（生成物をそのまま案件へ）
 *
 * SkillWorkspaceRouter が activeUiMode === "multiAngle" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / StoryboardWorkspace は触らない。
 * 画像プレビューは App ルートの ImagePreviewModal（グローバル）を useImagePreview.open で呼ぶ。
 */
export function MultiAngleWorkspace() {
  const openPreview = useImagePreview((s) => s.open);

  useEffect(() => {
    void ensureMultiAngleEventListener();
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AngleSettingsPanel />
        <div className="min-h-0 flex-1 overflow-hidden">
          <AngleGridPanel
            onPreview={(path, all) => openPreview(path, all)}
          />
        </div>
      </div>
    </section>
  );
}
