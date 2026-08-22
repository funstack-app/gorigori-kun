import { describe, expect, it } from "vitest";

import {
  groupLibraryItemsByDate,
  matchesLibrarySearch,
} from "../src/components/library/libraryGrouping";
import {
  inferGalleryMediaType,
  type GalleryItem,
} from "../src/lib/store/images";
import { toggleSelectionPaths } from "../src/lib/store/librarySelection";

function item(
  path: string,
  mtimeMs: number,
  overrides: Partial<GalleryItem> = {},
): GalleryItem {
  return {
    path,
    name: path.split("/").pop() ?? path,
    bucket: "test",
    mtimeMs,
    size: 1,
    kind: "created",
    ...overrides,
  };
}

describe("ライブラリの日付グループ化", () => {
  it("新しい日付から並べ、同日の素材を同じ見出しにまとめる", () => {
    const aug19Morning = new Date(2026, 7, 19, 9, 0).getTime();
    const aug19Night = new Date(2026, 7, 19, 21, 0).getTime();
    const aug15 = new Date(2026, 7, 15, 12, 0).getTime();
    const original = [
      item("/a/old.png", aug15),
      item("/a/morning.png", aug19Morning),
      item("/a/night.mp4", aug19Night, { mediaType: "video" }),
    ];

    const groups = groupLibraryItemsByDate(original);

    expect(groups.map((group) => group.label)).toEqual([
      "2026年8月19日",
      "2026年8月15日",
    ]);
    expect(groups[0].items.map((entry) => entry.path)).toEqual([
      "/a/night.mp4",
      "/a/morning.png",
    ]);
    expect(original.map((entry) => entry.path)).toEqual([
      "/a/old.png",
      "/a/morning.png",
      "/a/night.mp4",
    ]);
  });
});

describe("ライブラリ検索", () => {
  const target = item("/library/SUMMER-CAT.png", Date.now(), {
    name: "SUMMER-CAT.png",
    aiTitle: "夕暮れの海辺を歩く猫",
  });

  it("ファイル名を英字の大小を問わず部分一致で探せる", () => {
    expect(matchesLibrarySearch(target, "summer-cat")).toBe(true);
  });

  it("AI題名を部分一致で探せる", () => {
    expect(matchesLibrarySearch(target, "海辺を歩く")).toBe(true);
    expect(matchesLibrarySearch(target, "宇宙船")).toBe(false);
  });
});

describe("動画種別", () => {
  it("旧watcherイベントでも動画拡張子をvideoとして補完する", () => {
    expect(inferGalleryMediaType("/library/take-01.MP4")).toBe("video");
    expect(inferGalleryMediaType("/library/still.png")).toBe("image");
  });
});

describe("日付一括選択", () => {
  it("未選択が混じる日は全件追加し、全件選択済みの日は全件解除する", () => {
    const before = new Set(["a", "outside"]);
    const selected = toggleSelectionPaths(before, ["a", "b"]);

    expect(Array.from(selected).sort()).toEqual(["a", "b", "outside"]);
    expect(Array.from(before).sort()).toEqual(["a", "outside"]);

    const cleared = toggleSelectionPaths(selected, ["a", "b"]);
    expect(Array.from(cleared)).toEqual(["outside"]);
  });
});
