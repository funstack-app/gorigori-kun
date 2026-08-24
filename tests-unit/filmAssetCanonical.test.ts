import { describe, expect, it } from "vitest";

import { buildCanonicalImageAdoption } from "../src/components/skills/film/AssetFactoryPanel";
import { createDefaultStressTest } from "../src/lib/film/assetFactory";
import type { FilmAsset } from "../src/lib/film/types";

function makeAsset(type: FilmAsset["type"]): FilmAsset {
  return {
    id: type === "character" ? "CH-01" : "PR-01",
    name: type === "character" ? "主人公" : "鍵",
    type,
    importance: "primary",
    blockIds: ["B-01"],
    status: "planned",
    pairKey: null,
    pairSide: null,
    promptDraft: "採用テスト",
    generatedImagePaths: [],
    lastGeneratedPrompt: null,
    canonicalImagePath: null,
    ngNotes: [],
    stressTest: type === "character" ? createDefaultStressTest() : null,
    locked: false,
  };
}

describe("④アセット工場の既存画像正典化", () => {
  it("既存の人物画像を正典にし、人物チェックへ進む状態にする", () => {
    const adopted = buildCanonicalImageAdoption(makeAsset("character"), "/images/hero.webp");

    expect(adopted.canonicalImagePath).toBe("/images/hero.webp");
    expect(adopted.status).toBe("reviewed");
    expect(adopted.locked).toBe(false);
    expect(adopted.stressTest?.primaryRound.status).toBe("idle");
    expect(adopted.generatedImagePaths).toEqual([]);
  });

  it("人物以外の既存画像は採用と同時に確定する", () => {
    const adopted = buildCanonicalImageAdoption(makeAsset("prop"), "/images/key.png");

    expect(adopted.canonicalImagePath).toBe("/images/key.png");
    expect(adopted.status).toBe("locked");
    expect(adopted.locked).toBe(true);
    expect(adopted.generatedImagePaths).toEqual([]);
  });
});
