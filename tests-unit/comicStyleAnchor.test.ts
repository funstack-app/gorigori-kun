import { describe, expect, it } from "vitest";

import {
  buildFullPagePrompt,
  buildPanelImagePrompt,
  comicStyleAnchorMatchClause,
} from "../src/lib/comic/prompts";
import {
  MAX_COMIC_PAGE_REFERENCE_IMAGES,
  planStyleAnchoredReferences,
} from "../src/lib/comic/styleAnchor";
import { buildStructurePanelRequest } from "../src/lib/comic/structureRun";
import type {
  ComicEnvReference,
  ComicPanel,
} from "../src/lib/comic/types";
import {
  COMIC_WORK_STYLE_STORE_FILE,
  COMIC_WORK_STYLE_STORE_KEY,
  DEFAULT_COMIC_WORK_STYLE,
  parseComicWorkStyle,
} from "../src/lib/store/comicRun";

const panel: ComicPanel = {
  index: 1,
  composition: "close-up",
  characters: [],
  acting: "",
  balloons: [],
  sfx: [],
  prompt: "a quiet close-up",
};

function env(index: number): ComicEnvReference {
  return {
    id: `env-${index}`,
    name: `背景${index}`,
    kind: "location",
    imagePath: `/env/${index}.png`,
    source: "library",
  };
}

describe("作品の画風のお手本", () => {
  it("お手本を先頭へ固定し、総上限を増やさず押し出した参照を返す", () => {
    const chars = Array.from({ length: 9 }, (_, index) => `/char/${index + 1}.png`);
    const environments = [env(1), env(2), env(3)];

    const plan = planStyleAnchoredReferences({
      styleAnchorImagePath: "/managed/style.png",
      charRefPaths: chars,
      envReferences: environments,
    });

    expect(plan.refImagePaths).toHaveLength(MAX_COMIC_PAGE_REFERENCE_IMAGES);
    expect(plan.refImagePaths[0]).toBe("/managed/style.png");
    expect(plan.charRefPaths).toEqual(chars);
    expect(plan.envReferences.map((item) => item.imagePath)).toEqual([
      "/env/1.png",
      "/env/2.png",
    ]);
    expect(plan.displacedPaths).toEqual(["/env/3.png"]);
    expect(plan.styleAnchorReferenceIndex).toBe(1);
  });

  it("元ページなどの先置き参照があれば、プロンプト上のお手本番号をずらす", () => {
    const plan = planStyleAnchoredReferences({
      styleAnchorImagePath: "/managed/style.png",
      charRefPaths: ["/char/1.png"],
      maxReferences: 3,
      referenceIndexOffset: 1,
    });

    expect(plan.refImagePaths).toEqual([
      "/managed/style.png",
      "/char/1.png",
    ]);
    expect(plan.styleAnchorReferenceIndex).toBe(2);
  });

  it("お手本を解除した場合は、上限や重複へ介入せず従来順を保つ", () => {
    const plan = planStyleAnchoredReferences({
      styleAnchorImagePath: null,
      charRefPaths: ["/same.png", "/same.png"],
      envReferences: [env(1)],
      maxReferences: 1,
    });

    expect(plan.refImagePaths).toEqual([
      "/same.png",
      "/same.png",
      "/env/1.png",
    ]);
    expect(plan.displacedPaths).toEqual([]);
    expect(plan.styleAnchorReferenceIndex).toBeUndefined();
  });

  it("ページ生成と1コマ再編集へ同じ画風一致要求句を入れる", () => {
    const pagePrompt = buildFullPagePrompt([panel], null, [], "mono", false, {
      styleAnchorReferenceIndex: 1,
    });
    const panelPrompt = buildPanelImagePrompt(
      panel,
      [],
      "mono",
      false,
      "",
      { styleAnchorReferenceIndex: 2 },
    );

    expect(pagePrompt).toContain(comicStyleAnchorMatchClause(1));
    expect(panelPrompt).toContain(comicStyleAnchorMatchClause(2));
    expect(pagePrompt).toContain("professional Japanese black-and-white manga");
    expect(panelPrompt).toContain("professional Japanese black-and-white manga");
  });

  it("旧コマ生成でも、お手本を参照1へ固定して同じ一致要求句を入れる", () => {
    const request = buildStructurePanelRequest({
      panel,
      slot: { x: 0, y: 0, w: 100, h: 100 },
      characters: [],
      colorMode: "mono",
      styleAnchorImagePath: "/managed/style.png",
      direction: "rtl",
      pageContext: { panelNo: 1, panelTotal: 1, synopsis: "静かな場面" },
      sourceTag: "comic-style-anchor-test",
    });

    expect(request.request.refImagePaths).toEqual(["/managed/style.png"]);
    expect(request.request.prompt).toContain(comicStyleAnchorMatchClause(1));
    expect(request.displacedReferencePaths).toEqual([]);
  });

  it("旧保存データに画風項目が無くても既定値で開ける", () => {
    expect(parseComicWorkStyle({})).toEqual({
      ok: true,
      value: DEFAULT_COMIC_WORK_STYLE,
    });
    expect(COMIC_WORK_STYLE_STORE_FILE).toBe("comic-run.json");
    expect(COMIC_WORK_STYLE_STORE_KEY).toBe("workStyle");
  });
});
