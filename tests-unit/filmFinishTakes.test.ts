import { describe, expect, it } from "vitest";

import { collectAdoptedTakePaths } from "../src/lib/film/finishTakes";
import type { FilmBlock, FilmTake } from "../src/lib/film/types";

function makeBlock(id: string): FilmBlock {
  return {
    id,
    sceneId: `S-${id}`,
    durationSeconds: 5,
    visual: "",
    performance: "",
    dialogue: "",
    sound: "",
    foreshadowIds: [],
  };
}

function makeTake(blockId: string, path: string, adopted: boolean): FilmTake {
  return {
    blockId,
    path,
    adopted,
    version: 1,
    verdictNote: adopted ? "採用" : "不採用",
  };
}

describe("フィルム仕上げの採用テイク収集", () => {
  const blocks = [makeBlock("B2"), makeBlock("B1"), makeBlock("B3")];

  it("テイク配列ではなくblocksの順でpathを返す", () => {
    const takes = [
      makeTake("B1", "/film/b1.mp4", true),
      makeTake("B2", "/film/b2.mp4", true),
    ];

    expect(collectAdoptedTakePaths(blocks, takes)).toEqual([
      "/film/b2.mp4",
      "/film/b1.mp4",
    ]);
  });

  it("未採用テイクと採用のないブロックをスキップする", () => {
    const takes = [
      makeTake("B2", "/film/b2-ng.mp4", false),
      makeTake("B1", "/film/b1.mp4", true),
    ];

    expect(collectAdoptedTakePaths(blocks, takes)).toEqual(["/film/b1.mp4"]);
  });

  it("採用0本・1本・2本以上を件数で分岐できる", () => {
    expect(collectAdoptedTakePaths(blocks, [])).toHaveLength(0);
    expect(collectAdoptedTakePaths(blocks, [makeTake("B2", "/film/b2.mp4", true)])).toHaveLength(1);
    expect(collectAdoptedTakePaths(blocks, [
      makeTake("B1", "/film/b1.mp4", true),
      makeTake("B2", "/film/b2.mp4", true),
      makeTake("B3", "/film/b3.mp4", true),
    ])).toHaveLength(3);
  });
});
