import { useEffect } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { ensureProductSetEventListener } from "../../../lib/productSet/events";

import { ProductSetSettingsPanel } from "./ProductSetSettingsPanel";
import { ProductSetGridPanel } from "./ProductSetGridPanel";

/**
 * EC納品セット Workspace（スキル一覧v2.1 #12 / MVP）
 *
 * 商品写真1枚から、白背景・シーンカット・ディテール寄りの納品一式をセットで生成・整形。
 * マルチアングル Workspace と同じ「左に設定 / 右に出力グリッド」の2ペイン構成。
 * 生成は既存の Rust コマンド（multiangle_run / multiangle_regenerate_cut）を再利用し、
 * 納品カタログ（src/lib/productSet/catalog.ts）を CutPromptSpec に落として渡す。
 *
 * SkillWorkspaceRouter が activeUiMode === "productSet" のとき本コンポーネントを描画する。
 * 既存の GenerationWorkspace / 他スキル Workspace は触らない。
 * 画像プレビューは App ルートの ImagePreviewModal（グローバル）を useImagePreview.open で呼ぶ。
 */
export function ProductSetWorkspace() {
  const openPreview = useImagePreview((s) => s.open);

  useEffect(() => {
    void ensureProductSetEventListener();
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
        <ProductSetSettingsPanel />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProductSetGridPanel onPreview={(path, all) => openPreview(path, all)} />
        </div>
      </div>
    </section>
  );
}
