/** きっちりコマ割り: スロット優先順位と生成リクエスト組立の純関数検査。 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import {
  getComicTemplate,
  type ComicPanelSlot,
} from "../src/lib/comic/layoutTemplates";
import { synthesizeSlotsFromRows } from "../src/lib/comic/layoutSynthesis";
import {
  mirrorSlotX,
  recomposeAutoLayoutPlans,
} from "../src/lib/comic/panelLayoutOps";
import {
  buildStructureRunPlan,
  fallbackRowsForPanelCount,
  resolveStructureSlots,
} from "../src/lib/comic/structureRun";
import type {
  ComicCharacter,
  ComicEnvReference,
  ComicPanel,
  ComicStoryPage,
} from "../src/lib/comic/types";

const workspaceSource = readFileSync(
  new URL("../src/components/skills/comic/ComicWorkspace.tsx", import.meta.url),
  "utf8",
);

function panel(index: number, characters: string[] = ["モチ丸"]): ComicPanel {
  return {
    index,
    composition: `composition-${index}`,
    characters,
    acting: `acting-${index}`,
    balloons: [],
    sfx: [],
    prompt: `prompt-${index}`,
  };
}

function page(
  panelCount: number,
  extra: Partial<ComicStoryPage> = {},
): ComicStoryPage {
  return {
    page: 1,
    synopsis: "お餅をみんなで分ける",
    layoutHint: "",
    cast: ["モチ丸"],
    panelCount,
    panels: Array.from({ length: panelCount }, (_, index) => panel(index + 1)),
    ...extra,
  };
}

function simpleSlots(panelCount: number, xOffset = 0): ComicPanelSlot[] {
  return Array.from({ length: panelCount }, (_, index) => ({
    x: xOffset + index,
    y: xOffset + index,
    w: 0.5,
    h: 0.5,
  }));
}

function rectanglesOverlap(a: ComicPanelSlot, b: ComicPanelSlot): boolean {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
}

test("fallbackRowsForPanelCountは1..8を2列ずつ、奇数端数だけ1列にする", () => {
  for (let panelCount = 1; panelCount <= 8; panelCount += 1) {
    const expected: number[][] = [];
    for (let panelNo = 1; panelNo <= panelCount; panelNo += 2) {
      expected.push(
        panelNo < panelCount ? [panelNo, panelNo + 1] : [panelNo],
      );
    }
    expect(fallbackRowsForPanelCount(panelCount)).toEqual(expected);
  }
  expect(fallbackRowsForPanelCount(0)).toEqual([]);
  expect(fallbackRowsForPanelCount(1.5)).toEqual([]);
});

test("resolveStructureSlotsはoverride > template > layoutPlan > rows > fallbackを守る", () => {
  const override = simpleSlots(6, 70);
  const layoutPlan = simpleSlots(6, 40);
  const withEverything = page(6, { slotsOverride: override, layoutPlan });
  expect(
    resolveStructureSlots({
      page: withEverything,
      storyTemplateId: "manga01",
      direction: "rtl",
    }),
  ).toEqual(override);

  // 牙: 下位候補に意図的に別座標を置く。順番を1つでも逆にすると失敗する。
  const withTemplateAndLayout = page(6, { layoutPlan });
  expect(
    resolveStructureSlots({
      page: withTemplateAndLayout,
      storyTemplateId: "manga01",
      direction: "rtl",
    }),
  ).toEqual(getComicTemplate("manga01").slots);

  expect(
    resolveStructureSlots({
      page: withTemplateAndLayout,
      storyTemplateId: "manga10",
      direction: "rtl",
    }),
  ).toEqual(layoutPlan);

  const rows = [[1], [2, 3]];
  const rowsOnly = page(3, { rows });
  expect(
    resolveStructureSlots({
      page: rowsOnly,
      storyTemplateId: null,
      direction: "ltr",
    }),
  ).toEqual(synthesizeSlotsFromRows(rows, 3, "ltr"));

  const fallback = resolveStructureSlots({
    page: page(5),
    storyTemplateId: null,
    direction: "rtl",
  });
  expect(fallback).toHaveLength(5);
  expect(fallback[0].x).toBeGreaterThan(fallback[1].x);
});

test("resolveStructureSlotsのfallbackは常にpanelCount個で重ならない", () => {
  for (let panelCount = 1; panelCount <= 8; panelCount += 1) {
    const slots = resolveStructureSlots({
      page: page(panelCount),
      storyTemplateId: null,
      direction: panelCount % 2 === 0 ? "ltr" : "rtl",
    });
    expect(slots).toHaveLength(panelCount);
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        expect(rectanglesOverlap(slots[i], slots[j])).toBe(false);
      }
    }
  }
});

test("ltrのテンプレはコマ番号を保ったままX軸ミラーされる", () => {
  const original = getComicTemplate("manga01").slots;
  const resolved = resolveStructureSlots({
    page: page(6),
    storyTemplateId: "manga01",
    direction: "ltr",
  });
  expect(resolved).toEqual(original.map(mirrorSlotX));
  expect(resolved[0].x).toBeLessThan(original[0].x);
});

test("B方式の復元は実行中に増えたコマ素材を残さず開始前結果を丸ごと戻す", () => {
  // 牙: currentを先に展開する実装へ戻すと、snapshotに無いコマ素材キーが残る。
  expect(workspaceSource).toContain(
    "return current.page === snapshot.page ? { ...snapshot } : current;",
  );
  expect(workspaceSource).not.toMatch(
    /\.\.\.result,\s*\.\.\.resultBeforeRun/,
  );
  // 単体中止・失敗・一括中止が、同じ復元関数だけを通ることを固定する。
  expect(
    workspaceSource.match(/restorePageResultSnapshot\(result, (?:resultBeforeRun|before)\)/g),
  ).toHaveLength(3);
});

test("おまかせ構成の方向変更はrowsから再合成し、往復しても二重反転しない", () => {
  const rows = [[1, 2], [3]];
  const rtlPlan = synthesizeSlotsFromRows(rows, 3, "rtl");
  expect(rtlPlan).not.toBeNull();
  const original = page(3, { rows, layoutPlan: rtlPlan! });

  const ltrPages = recomposeAutoLayoutPlans({
    pages: [original],
    storyTemplateId: null,
    direction: "ltr",
  });
  expect(ltrPages[0].layoutPlan).toEqual(
    synthesizeSlotsFromRows(rows, 3, "ltr"),
  );
  expect(ltrPages[0].layoutPlan?.[0].x).toBeLessThan(
    ltrPages[0].layoutPlan?.[1].x ?? 0,
  );

  const rtlAgain = recomposeAutoLayoutPlans({
    pages: ltrPages,
    storyTemplateId: null,
    direction: "rtl",
  });
  // 牙: 現在のlayoutPlanを都度ミラーする実装ではなく、正本rowsから毎回同じ値を作る。
  expect(rtlAgain[0].layoutPlan).toEqual(rtlPlan);
});

test("テンプレ構成の方向変更ではlayoutPlanを再合成しない", () => {
  const rows = [[1, 2], [3]];
  const templatePage = page(3, {
    rows,
    layoutPlan: synthesizeSlotsFromRows(rows, 3, "rtl")!,
  });
  const pages = [templatePage];

  const unchanged = recomposeAutoLayoutPlans({
    pages,
    storyTemplateId: "manga01",
    direction: "ltr",
  });

  expect(unchanged).toBe(pages);
  expect(unchanged[0]).toBe(templatePage);
});

test("buildStructureRunPlanはaspect・参照上限・sourceTag・genModeを一度に決める", () => {
  const slots: ComicPanelSlot[] = [
    { x: 4, y: 4, w: 30, h: 40 },
    { x: 4, y: 50, w: 60, h: 25 },
  ];
  const storyPage = page(2, {
    slotsOverride: slots,
    // 並びを崩してもpanelIndexとslotはindex-1で対応する。
    panels: [panel(2, []), panel(1)],
  });
  const character: ComicCharacter = {
    name: "モチ丸",
    attributes: "round white face",
    referenceImagePaths: Array.from(
      { length: 8 },
      (_, index) => `/chars/mochi-${index + 1}.png`,
    ),
  };
  const envReferences: ComicEnvReference[] = Array.from(
    { length: 4 },
    (_, index) => ({
      id: `env-${index + 1}`,
      name: `背景${index + 1}`,
      kind: index === 0 ? "location" : "item",
      imagePath: `/env/ref-${index + 1}.png`,
      source: "file",
    }),
  );

  const plan = buildStructureRunPlan({
    page: storyPage,
    storyTemplateId: "manga10",
    direction: "rtl",
    characters: [character],
    colorMode: "mono",
    styleText: "soft pencil texture",
    envReferences,
    sourceTag: "comic-structure-run-1",
  });

  expect(plan.genMode).toBe("structure");
  expect(plan.slots).toEqual(slots);
  expect(plan.panelRequests.map((item) => item.panelIndex)).toEqual([1, 2]);

  const first = plan.panelRequests[0].request;
  expect(first.count).toBe(1);
  expect(first.aspect).toBe("9:16");
  expect(first.sourceTag).toBe("comic-structure-run-1");
  expect(first.refImagePaths).toEqual([
    "/chars/mochi-1.png",
    "/chars/mochi-2.png",
    "/chars/mochi-3.png",
    "/chars/mochi-4.png",
    "/chars/mochi-5.png",
    "/chars/mochi-6.png",
    "/env/ref-1.png",
    "/env/ref-2.png",
    "/env/ref-3.png",
  ]);
  expect(first.prompt).toContain("reference images 1-6 are character references");
  expect(first.prompt).toContain("reference image 7: 「背景1」");
  expect(first.prompt).toContain("story context: this is panel 1 of 2");

  const second = plan.panelRequests[1].request;
  expect(second.aspect).toBe("16:9");
  expect(second.refImagePaths).toEqual([
    "/env/ref-1.png",
    "/env/ref-2.png",
    "/env/ref-3.png",
  ]);
  expect(second.prompt).toContain("reference image 1: 「背景1」");
  expect(second.prompt).not.toContain("are character references");

  // 牙: キャラ8枚を先に9枚で切る実装だと、優先すべき環境3枚が欠ける。
  expect(first.refImagePaths).toHaveLength(9);
  expect(first.refImagePaths.slice(-3)).toEqual([
    "/env/ref-1.png",
    "/env/ref-2.png",
    "/env/ref-3.png",
  ]);
  expect(first).not.toHaveProperty("enforceAspect");
  expect(first).not.toHaveProperty("maxAttempts");
});

test("buildStructureRunPlanはindex-1対応を作れない壊れたコマ番号を拒否する", () => {
  const broken = page(2, { panels: [panel(1), panel(1)] });
  expect(() =>
    buildStructureRunPlan({
      page: broken,
      storyTemplateId: null,
      direction: "rtl",
      characters: [],
      colorMode: "mono",
      sourceTag: "broken-run",
    }),
  ).toThrow("コマ番号は1からの連番");
});
