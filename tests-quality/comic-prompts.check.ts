/** 漫画FB改修 r1: faithful 1コマ句 / story rows / おまかせ座標句の純関数検査。 */
import { expect, test } from "@playwright/test";

import { getComicTemplate } from "../src/lib/comic/layoutTemplates";
import {
  buildFullPagePrompt,
  buildPanelImagePrompt,
  buildStoryPrompt,
  parseComicStory,
} from "../src/lib/comic/prompts";
import type { ComicCharacter, ComicPanel } from "../src/lib/comic/types";

const FAITHFUL_PANEL_BASE =
  "manga panel edit, rendered in the exact art style of the existing page — reference image 1 is the page being edited; match its style precisely";
const FAITHFUL_IDENTITY =
  "depict every referenced subject exactly as they appear in the reference images — same face, hairstyle, outfit, and distinctive features";
const REFERENCE_POSE =
  "use the reference images only for the character's appearance and identity — do not copy the reference's pose, framing, or camera distance; follow this panel's composition instructions instead";
const REFERENCE_FAITHFUL =
  "preserve the reference images' original rendering style, medium, and level of realism exactly — do not convert to a different art style; keep pose and framing following each panel's composition instructions";
const FAITHFUL_PANEL_FINAL =
  "the edited panel must be indistinguishable in style from the untouched panels around it";

function comicPanel(index: number): ComicPanel {
  return {
    index,
    composition: `composition-${index}`,
    characters: ["モチ丸"],
    acting: `acting-${index}`,
    balloons: [],
    sfx: [],
    prompt: `prompt-${index}`,
  };
}

const character: ComicCharacter = {
  name: "モチ丸",
  attributes: "round white face",
  referenceImagePaths: ["/tmp/not-read.png"],
};

function storyJson(rows: unknown): string {
  return JSON.stringify({
    pages: [
      {
        page: 1,
        synopsis: "お餅を分ける",
        layoutHint: "two panels on top, one wide panel below",
        cast: ["モチ丸"],
        panelCount: 3,
        rows,
        panels: [1, 2, 3].map((index) => ({
          index,
          composition: `composition-${index}`,
          characters: ["モチ丸"],
          acting: `acting-${index}`,
          balloons: [],
          sfx: [],
          prompt: `prompt-${index}`,
        })),
      },
    ],
  });
}

test("faithful の1コマpromptは設計書A-cの6項構成を守り、漫画化句を混ぜない", () => {
  const prompt = buildPanelImagePrompt(
    comicPanel(1),
    [character],
    "faithful",
    true,
    "このstyleTextはfaithfulへ入れてはいけない",
  );

  const orderedClauses = [
    FAITHFUL_PANEL_BASE,
    FAITHFUL_IDENTITY,
    REFERENCE_POSE,
    REFERENCE_FAITHFUL,
    "prompt-1",
    FAITHFUL_PANEL_FINAL,
    "do not render any meta text or numbers on the image",
  ];
  let previous = -1;
  for (const clause of orderedClauses) {
    const current = prompt.indexOf(clause);
    expect(current, `句が入る: ${clause.slice(0, 36)}`).toBeGreaterThan(previous);
    previous = current;
  }

  expect(prompt).toContain("character design — モチ丸: round white face");
  expect(prompt).toContain("acting-1");
  expect(prompt).not.toContain("black and white manga illustration");
  expect(prompt).not.toContain("full color manga illustration");
  expect(prompt).not.toContain("completely ignore the reference image's rendering style");
  expect(prompt).not.toContain("final output must look like a professional Japanese");
  expect(prompt).not.toContain("portrait page, consistent page size");
  expect(prompt).not.toContain("このstyleTextはfaithfulへ入れてはいけない");

  const withoutCharacterReferences = buildPanelImagePrompt(
    comicPanel(1),
    [character],
    "faithful",
    false,
  );
  expect(withoutCharacterReferences).toContain(FAITHFUL_PANEL_BASE);
  expect(withoutCharacterReferences).toContain(REFERENCE_FAITHFUL);
  expect(withoutCharacterReferences).not.toContain(FAITHFUL_IDENTITY);
  expect(withoutCharacterReferences).not.toContain(REFERENCE_POSE);
});

test("おまかせstory仕様はrowsを要求し、テンプレ指定時は要求しない", () => {
  const automatic = buildStoryPrompt("お餅の話", [character], { readingDirection: "ltr" });
  expect(automatic).toContain(
    "1 から panelCount までの番号を、重複・欠番なく1回ずつ使います。",
  );
  expect(automatic).toContain(
    '"rows": [[上段のコマ番号を読み順で], [次の段のコマ番号を読み順で], ...]',
  );

  const templated = buildStoryPrompt("お餅の話", [character], {
    template: getComicTemplate("manga01"),
  });
  expect(templated).not.toContain('"rows"');
});

test("parseComicStoryは正しいrowsをlayoutPlanへ合成し、重複・欠番は部分採用しない", () => {
  const parsed = parseComicStory(storyJson([[1, 2], [3]]), "ltr");
  expect(parsed).not.toBeNull();
  expect(parsed?.[0].rows).toEqual([[1, 2], [3]]);
  expect(parsed?.[0].layoutPlan).toHaveLength(3);
  expect(parsed?.[0].layoutPlan?.[0].x).toBeLessThan(parsed?.[0].layoutPlan?.[1].x ?? 0);

  // 牙: 重複を含む壊れた rows は一部だけ拾わず、rows/layoutPlan を丸ごと棄却する。
  const duplicate = parseComicStory(storyJson([[1, 1], [2, 3]]), "rtl");
  expect(duplicate).not.toBeNull();
  expect(duplicate?.[0].rows).toBeUndefined();
  expect(duplicate?.[0].layoutPlan).toBeUndefined();
  expect(duplicate?.[0].panels).toHaveLength(3);

  const missing = parseComicStory(storyJson([[1], [3]]), "rtl");
  expect(missing).not.toBeNull();
  expect(missing?.[0].rows).toBeUndefined();
  expect(missing?.[0].layoutPlan).toBeUndefined();
});

test("template=nullでもlayoutPlanの座標とrows由来の全コマ位置語を焼き込む", () => {
  const page = parseComicStory(storyJson([[1, 2], [3]]), "ltr")?.[0];
  expect(page?.layoutPlan).toHaveLength(3);
  if (!page?.layoutPlan || !page.rows) throw new Error("rows/layoutPlan fixture の合成に失敗");

  const prompt = buildFullPagePrompt(page.panels, null, [character], "mono", false, {
    readingDirection: "ltr",
    layoutHint: page.layoutHint,
    rows: page.rows,
    layoutPlan: page.layoutPlan,
  });
  expect(prompt).toContain("follow this exact panel layout: row 1: two");
  expect(prompt).toContain("exact page-percent coordinates — panel 1 bounds: x");
  expect(prompt).toContain("panel 1 (top-left): prompt-1");
  expect(prompt).toContain("panel 2 (top-right): prompt-2");
  expect(prompt).toContain("panel 3 (bottom, full width): prompt-3");
  expect(prompt).not.toContain("design the panel layout yourself");
});
