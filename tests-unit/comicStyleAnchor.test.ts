import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildFullPagePrompt,
  buildPanelImagePrompt,
  comicStyleAnchorMatchClause,
} from "../src/lib/comic/prompts";
import {
  comicStyleAnchorStoryId,
  MAX_COMIC_PAGE_REFERENCE_IMAGES,
  planStyleAnchoredReferences,
} from "../src/lib/comic/styleAnchor";
import { buildStructurePanelRequest } from "../src/lib/comic/structureRun";
import type {
  ComicEnvReference,
  ComicPanel,
} from "../src/lib/comic/types";
import {
  activateComicStyleAnchorStory,
  COMIC_WORK_STYLE_ANCHORS_KEY,
  COMIC_WORK_STYLE_STORE_FILE,
  COMIC_WORK_STYLE_STORE_KEY,
  DEFAULT_COMIC_WORK_STYLE,
  parseComicWorkStyle,
  parseComicWorkStyleStorage,
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

  it("お手本の保存IDは空白差を吸収し、別の話は別IDにする", () => {
    expect(comicStyleAnchorStoryId("  月で餅をつく話\n")).toBe(
      comicStyleAnchorStoryId("月で餅をつく話"),
    );
    expect(comicStyleAnchorStoryId("月で餅をつく話")).not.toBe(
      comicStyleAnchorStoryId("海で餅をつく話"),
    );
  });

  it("旧共有お手本は最初の作品へ一度だけ移し、次の作品へ漏らさない", () => {
    const legacy = parseComicWorkStyleStorage({
      colorMode: "mono",
      styleText: "",
      styleAnchorImagePath: "/managed/legacy-style.png",
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;

    const storyA = activateComicStyleAnchorStory(legacy.value, "story-a");
    expect(storyA.styleAnchorImagePath).toBe("/managed/legacy-style.png");
    expect(storyA.storage.styleAnchorImagePath).toBeNull();
    expect(storyA.storage.styleAnchorImagePathsByStory).toEqual({
      "story-a": "/managed/legacy-style.png",
    });

    const storyB = activateComicStyleAnchorStory(storyA.storage, "story-b");
    expect(storyB.styleAnchorImagePath).toBeNull();
    expect(storyB.storage.styleAnchorImagePathsByStory).toEqual({
      "story-a": "/managed/legacy-style.png",
    });
    expect(COMIC_WORK_STYLE_ANCHORS_KEY).toBe("styleAnchorImagePathsByStory");
  });

  it("新形式は作品ごとのお手本一覧をそのまま読む", () => {
    const parsed = parseComicWorkStyleStorage({
      colorMode: "color",
      styleText: "やわらかい線",
      styleAnchorImagePath: null,
      styleAnchorImagePathsByStory: {
        "story-a": "/managed/a.png",
        "story-b": "/managed/b.png",
      },
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        colorMode: "color",
        styleText: "やわらかい線",
        styleAnchorImagePath: null,
        styleAnchorImagePathsByStory: {
          "story-a": "/managed/a.png",
          "story-b": "/managed/b.png",
        },
      },
    });
  });

  it("自動設定は先頭ページ番号ではなく、最初の保存・採用を受け付ける", () => {
    const source = readFileSync(
      resolve("src/components/skills/comic/ComicWorkspace.tsx"),
      "utf8",
    );
    const start = source.indexOf("const ensureAutomaticStyleAnchor");
    const end = source.indexOf("const clearStyleAnchor", start);
    const functionSource = source.slice(start, end);

    expect(source).toContain("人が最初に保存・採用したページ");
    expect(functionSource).toContain("automaticStyleAnchorRef.current");
    expect(functionSource).not.toContain("storyPagesRef.current[0]");
    expect(functionSource).not.toContain("pageNo !==");
  });
});
