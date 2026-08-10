/**
 * 2026-08-10 STΛCK決定「書き出しは固定規格でなく**テンプレサイズにあわせる**」の牙。
 *
 * ## 何を守っているか
 *
 * ページ寸法が固定3:4ではなく、テンプレの `pageAspect` に追従すること。
 * 壊れ方は2方向あり、両方をここで止める:
 *
 *   1. **追従しない**: 4:5テンプレを選んでも 1080×1440 / 2160×2880 のままになる
 *      （友人テンプレのコマ座標が縦に潰れる）
 *   2. **後方互換を壊す**: pageAspect を渡さない既存経路まで寸法が変わる
 *      （3:4 の既存ページ・保存済みデータが作り直しになる）
 *
 * 特に 2 は静かに壊れるので、「省略時は現行と同値」を各層で固定する。
 *
 * 補遺1 (2026-08-10) で塗り絵経路(stencil)と書き出しファイル名の接尾辞も対象に加えた。
 * stencil は ALIGNED_PIPELINE の既定経路なので、ここが3:4のままだと
 * user02(4:5) の主経路が丸ごと追従しない。
 */
import { describe, expect, it } from "vitest";

import {
  comicAspectSuffix,
  comicExportSize,
} from "../src/lib/comic/exportSize";
import {
  ALL_COMIC_LAYOUT_TEMPLATES,
  getComicTemplate,
  type ComicPanelSlot,
} from "../src/lib/comic/layoutTemplates";
import {
  buildAssemblyPlan,
  STRUCTURE_PAGE_H,
  STRUCTURE_PAGE_W,
  structurePageSize,
} from "../src/lib/comic/pageAssembly";
import {
  comicPageAspectCandidates,
  planComicPageNormalization,
} from "../src/lib/comic/pageNormalize";
import {
  renderPanelMaskRaster,
  renderTemplateScaffoldRaster,
} from "../src/lib/comic/stencil";

describe("A1: structurePageSize は比率追従・省略時は現行同値", () => {
  it("T-A1-1: 3:4 は 1080×1440（従来の作業寸法）", () => {
    expect(structurePageSize({ w: 3, h: 4 })).toEqual({ w: 1080, h: 1440 });
  });

  it("T-A1-2: 4:5 は 1080×1350", () => {
    expect(structurePageSize({ w: 4, h: 5 })).toEqual({ w: 1080, h: 1350 });
  });

  it("T-A1-3: 省略時は既定の 3:4（既存呼び出しの後方互換）", () => {
    expect(structurePageSize()).toEqual({
      w: STRUCTURE_PAGE_W,
      h: STRUCTURE_PAGE_H,
    });
    expect(structurePageSize()).toEqual(structurePageSize({ w: 3, h: 4 }));
  });

  it("T-A1-4: buildAssemblyPlan も省略時は現行同値・指定時は追従する", () => {
    const slots: ComicPanelSlot[] = [
      { x: 10, y: 10, w: 40, h: 40 },
      { x: 55, y: 10, w: 35, h: 40 },
    ];
    const omitted = buildAssemblyPlan(slots, "standard");
    const explicit34 = buildAssemblyPlan(slots, "standard", { w: 3, h: 4 });
    // 省略時 == 3:4 明示時（挙動が変わらないことの担保）
    expect(omitted).toEqual(explicit34);
    expect(omitted.pageW).toBe(1080);
    expect(omitted.pageH).toBe(1440);

    const plan45 = buildAssemblyPlan(slots, "standard", { w: 4, h: 5 });
    expect(plan45.pageW).toBe(1080);
    expect(plan45.pageH).toBe(1350);
    // コマ矩形もページ高に追従する（percent × pageH）
    expect(plan45.panels[0].rect.y).toBe(Math.round(0.1 * 1350));
    expect(plan45.panels[0].rect.h).toBe(Math.round(0.4 * 1350));
  });
});

describe("A2: 正規化先は候補比率への最近傍スナップ", () => {
  it("T-A2-1: 3:4級の入力は 1080×1440 へ", () => {
    for (const [w, h] of [
      [1080, 1440],
      [1024, 1365],
      [2160, 2880],
    ]) {
      const plan = planComicPageNormalization(w, h);
      expect([plan.targetWidth, plan.targetHeight]).toEqual([1080, 1440]);
    }
  });

  it("T-A2-2: 4:5級の入力は 1080×1350 へ（友人テンプレPSDの実寸を含む）", () => {
    for (const [w, h] of [
      [2160, 2700],
      [1080, 1350],
      [1600, 2000],
    ]) {
      const plan = planComicPageNormalization(w, h);
      expect([plan.targetWidth, plan.targetHeight]).toEqual([1080, 1350]);
    }
  });

  it("T-A2-3: 中間比率は最近傍へスナップする（どちらかに必ず落ちる）", () => {
    // 3:4 = 0.75、4:5 = 0.80。その間の 0.78 は 4:5 側が近い（log距離）
    const between = planComicPageNormalization(1000, 1282); // ≒0.780
    expect([between.targetWidth, between.targetHeight]).toEqual([1080, 1350]);
    // 0.76 は 3:4 側が近い
    const nearer34 = planComicPageNormalization(1000, 1316); // ≒0.760
    expect([nearer34.targetWidth, nearer34.targetHeight]).toEqual([1080, 1440]);
  });

  it("T-A2-4: 候補は登録テンプレの pageAspect から導出される（手書きしない）", () => {
    const candidates = comicPageAspectCandidates();
    const keys = candidates.map((c) => `${c.w}:${c.h}`);
    // 重複なし
    expect(new Set(keys).size).toBe(keys.length);
    // 全テンプレの比率が候補に含まれる（テンプレを足したら候補も増える）
    for (const template of ALL_COMIC_LAYOUT_TEMPLATES) {
      expect(keys).toContain(`${template.pageAspect.w}:${template.pageAspect.h}`);
    }
  });

  it("T-A2-5: 想定外比率でも止めず、contain の不変条件を守る", () => {
    const plan = planComicPageNormalization(1920, 1080); // 横長
    expect(plan.scale).toBeGreaterThan(0);
    expect(plan.scale).toBeLessThanOrEqual(1);
    expect(plan.drawRect.x).toBeGreaterThanOrEqual(0);
    expect(plan.drawRect.y).toBeGreaterThanOrEqual(0);
    expect(plan.drawRect.x + plan.drawRect.w).toBeLessThanOrEqual(plan.targetWidth + 1e-7);
    expect(plan.drawRect.y + plan.drawRect.h).toBeLessThanOrEqual(plan.targetHeight + 1e-7);
    // 比率差が大きいので警告は立つ（が正規化は実施される）
    expect(plan.aspectWarn).toBe(true);
  });
});

describe("A3: 友人テンプレ user02（4:5・コマ4つ）", () => {
  const template = getComicTemplate("user02");

  it("T-A3-1: id が解決でき、4:5・4コマで登録されている", () => {
    expect(template.id).toBe("user02");
    expect(template.pageAspect).toEqual({ w: 4, h: 5 });
    expect(template.panelCount).toBe(4);
    expect(template.slots).toHaveLength(4);
    expect(template.roles).toHaveLength(4);
  });

  it("T-A3-2: 全スロットがページ内（0-100%）に収まる", () => {
    for (const [i, slot] of template.slots.entries()) {
      expect(slot.w, `slot${i}.w`).toBeGreaterThan(0);
      expect(slot.h, `slot${i}.h`).toBeGreaterThan(0);
      expect(slot.x, `slot${i}.x`).toBeGreaterThanOrEqual(0);
      expect(slot.y, `slot${i}.y`).toBeGreaterThanOrEqual(0);
      expect(slot.x + slot.w, `slot${i}.right`).toBeLessThanOrEqual(100);
      expect(slot.y + slot.h, `slot${i}.bottom`).toBeLessThanOrEqual(100);
    }
  });

  it("T-A3-3: コマ同士が重ならない（bbox 交差面積0）", () => {
    const overlapArea = (a: ComicPanelSlot, b: ComicPanelSlot): number => {
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      return w > 0 && h > 0 ? w * h : 0;
    };
    for (let i = 0; i < template.slots.length; i += 1) {
      for (let j = i + 1; j < template.slots.length; j += 1) {
        expect(
          overlapArea(template.slots[i], template.slots[j]),
          `slot${i} × slot${j}`,
        ).toBe(0);
      }
    }
  });

  it("T-A3-4: 4:5 の作業ページ上で退化コマが出ない", () => {
    const plan = buildAssemblyPlan(template.slots, "standard", template.pageAspect);
    expect(plan.pageH).toBe(1350);
    for (const panel of plan.panels) {
      expect(panel.rect.w).toBeGreaterThan(0);
      expect(panel.rect.h).toBeGreaterThan(0);
      expect(panel.rect.x + panel.rect.w).toBeLessThanOrEqual(plan.pageW);
      expect(panel.rect.y + panel.rect.h).toBeLessThanOrEqual(plan.pageH);
    }
  });
});

describe("A4: comicExportSize は比率追従（幅2160固定）", () => {
  it("T-A4-1: (1080,1440) → (2160,2880) / (1080,1350) → (2160,2700)", () => {
    expect(comicExportSize(1080, 1440)).toEqual({ width: 2160, height: 2880 });
    expect(comicExportSize(1080, 1350)).toEqual({ width: 2160, height: 2700 });
  });

  it("T-A4-2: 正規化先の寸法をそのまま渡すと、必ず縦横2倍になる", () => {
    for (const [w, h] of [
      [1080, 1440],
      [1080, 1350],
    ]) {
      const plan = planComicPageNormalization(w, h);
      const target = comicExportSize(plan.targetWidth, plan.targetHeight);
      expect(target.width).toBe(plan.targetWidth * 2);
      expect(target.height).toBe(plan.targetHeight * 2);
    }
  });

  it("T-A4-3: 寸法を読めない入力は既定の 3:4 へ落ちる（推測で埋めない）", () => {
    expect(comicExportSize(0, 1440)).toEqual({ width: 2160, height: 2880 });
    expect(comicExportSize(Number.NaN, Number.NaN)).toEqual({
      width: 2160,
      height: 2880,
    });
  });
});

describe("A5: 塗り絵経路(stencil)もテンプレ比率に追従する", () => {
  it("T-A5-1: 4:5テンプレの scaffold / mask は 1080×1350 で生成される", () => {
    const template = getComicTemplate("user02");
    const scaffold = renderTemplateScaffoldRaster(template, "rtl");
    const mask = renderPanelMaskRaster(template, "rtl");
    expect([scaffold.width, scaffold.height]).toEqual([1080, 1350]);
    expect([mask.width, mask.height]).toEqual([1080, 1350]);
    // scaffold と mask が同寸 = 合成時の寸法不一致で落ちない
    expect([mask.width, mask.height]).toEqual([scaffold.width, scaffold.height]);
    // raster の実体もその寸法ぶんある（寸法だけ変えて中身が伴わない事故を止める）
    expect(scaffold.rgba.length).toBe(1080 * 1350 * 4);
  });

  it("T-A5-2: 3:4テンプレは従来どおり 1080×1440（後方互換）", () => {
    const template = getComicTemplate("manga10");
    expect(template.pageAspect).toEqual({ w: 3, h: 4 });
    const scaffold = renderTemplateScaffoldRaster(template, "rtl");
    const mask = renderPanelMaskRaster(template, "rtl");
    expect([scaffold.width, scaffold.height]).toEqual([1080, 1440]);
    expect([mask.width, mask.height]).toEqual([1080, 1440]);
  });

  it("T-A5-3: 4:5でも枠線が実際に描かれる（白紙のまま返さない）", () => {
    const scaffold = renderTemplateScaffoldRaster(getComicTemplate("user02"), "rtl");
    let blackPixels = 0;
    for (let offset = 0; offset < scaffold.rgba.length; offset += 4) {
      if (scaffold.rgba[offset] === 0 && scaffold.rgba[offset + 1] === 0) {
        blackPixels += 1;
      }
    }
    expect(blackPixels).toBeGreaterThan(0);
    // マスク側もコマ内側が白く塗られている
    const mask = renderPanelMaskRaster(getComicTemplate("user02"), "rtl");
    let whitePixels = 0;
    for (let offset = 0; offset < mask.rgba.length; offset += 4) {
      if (mask.rgba[offset] === 255) whitePixels += 1;
    }
    expect(whitePixels).toBeGreaterThan(0);
  });
});

describe("A6: 書き出しファイル名の比率接尾辞", () => {
  it("T-A6-1: 2160×2880 → 3x4（既存ファイル名を変えない）", () => {
    expect(comicAspectSuffix(2160, 2880)).toBe("3x4");
  });

  it("T-A6-2: 2160×2700 → 4x5（4:5ページに 3x4 と書かない）", () => {
    expect(comicAspectSuffix(2160, 2700)).toBe("4x5");
  });

  it("T-A6-3: 書き出し寸法から通しで求めても同じ接尾辞になる", () => {
    const page34 = comicExportSize(1080, 1440);
    expect(comicAspectSuffix(page34.width, page34.height)).toBe("3x4");
    const page45 = comicExportSize(1080, 1350);
    expect(comicAspectSuffix(page45.width, page45.height)).toBe("4x5");
  });

  it("T-A6-4: 寸法を読めない場合は既定規格の比率へ落ちる", () => {
    expect(comicAspectSuffix(0, 2880)).toBe("3x4");
    expect(comicAspectSuffix(Number.NaN, Number.NaN)).toBe("3x4");
  });
});
