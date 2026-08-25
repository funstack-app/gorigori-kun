import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function section(text: string, start: string, end?: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe("ダイアログのビューポート制約", () => {
  it("ライブラリ一括削除は一覧だけがスクロールし、操作列が縮まない", () => {
    const app = section(
      source("src/App.tsx"),
      "function LibraryDeleteButton()",
      "function LibraryAddToProjectButton()",
    );

    expect(app).toMatch(
      /className="[^"]*max-h-\[calc\(100vh-80px\)\][^"]*flex-col[^"]*overflow-hidden/,
    );
    expect(app).toMatch(
      /<ul className="[^"]*min-h-0[^"]*flex-1[^"]*overflow-y-auto/,
    );
    expect(app).toMatch(
      /className="[^"]*shrink-0[^"]*justify-end[^"]*gap-2/,
    );
  });

  it.each([
    ["src/components/SkillDetailModal.tsx", "export function SkillDetailModal"],
    ["src/components/SnsExportModal.tsx", "export function SnsExportModal"],
    ["src/components/GenerationWorkspace.tsx", "function StoryboardDetailModal"],
    ["src/components/skills/scene3d/SceneFromImageDialog.tsx", "export function SceneFromImageDialog"],
  ])("%s は外枠を固定し、可変部分を内部スクロールにする", (path, marker) => {
    const modal = section(source(path), marker);

    expect(modal).toMatch(
      /className="[^"]*max-h-\[calc\(100vh-80px\)\][^"]*flex-col[^"]*overflow-hidden/,
    );
    expect(modal).toMatch(
      /className="[^"]*min-h-0[^"]*flex-1[^"]*overflow-y-auto/,
    );
  });

  it("可変フォームは保存・回答ボタン列を画面内に残す", () => {
    const approval = source("src/components/ApprovalDialog.tsx");
    const presets = source("src/components/PresetsDrawer.tsx");

    expect(approval).toContain("max-h-[calc(100vh-80px)]");
    expect(approval).toMatch(/sticky bottom-0[^\"]*shrink-0/);
    expect(presets).toMatch(
      /className="[^"]*max-h-\[calc\(100vh-80px\)\][^"]*flex-col[^"]*overflow-hidden/,
    );
    expect(presets).toMatch(/sticky bottom-0[^\"]*shrink-0/);
  });

  it("ストック素材の拡大表示は画像だけが縮み、操作列を残す", () => {
    const lightbox = section(
      source("src/components/StockSearchModal.tsx"),
      "{previewPhoto && (",
      "画像分析の結果モーダル",
    );

    expect(lightbox).toContain("max-h-[calc(100vh-80px)]");
    expect(lightbox).toMatch(/<img[\s\S]*className="[^"]*min-h-0[^"]*flex-1/);
    expect(lightbox).toMatch(/className="[^"]*shrink-0[^"]*flex-wrap/);
  });

  it("可変長のアンカー型メニューは内部スクロールを持つ", () => {
    const app = source("src/App.tsx");
    const contextMenu = source("src/components/ContextMenu.tsx");
    const mentions = source("src/components/PromptTextareaWithMentions.tsx");

    expect(app).toMatch(/top-full[^\"]*max-h-\[calc\(100vh-80px\)\][^\"]*overflow-y-auto/);
    expect(contextMenu).toContain("max-h-[calc(100vh-8px)]");
    expect(contextMenu).toContain("overflow-y-auto");
    expect(mentions).toMatch(/max-h-48[^\"]*overflow-y-auto/);
  });
});
