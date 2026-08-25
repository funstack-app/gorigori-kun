import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  galleryMediaSupportsFullResOnInteraction,
  resolveSafeImageDisplayPath,
} from "../src/components/SafeImage";

describe("library export fixes", () => {
  it("keeps the thumbnail until interaction-loaded full resolution is ready", () => {
    const base = {
      path: "/library/original.png",
      thumbnailPath: "/cache/thumbnail.png",
      thumbnail: true,
      fullResOnInteraction: true,
    };

    expect(
      resolveSafeImageDisplayPath({
        ...base,
        interactionStarted: false,
        fullResLoaded: false,
      }),
    ).toBe("/cache/thumbnail.png");
    expect(
      resolveSafeImageDisplayPath({
        ...base,
        interactionStarted: true,
        fullResLoaded: false,
      }),
    ).toBe("/cache/thumbnail.png");
    expect(
      resolveSafeImageDisplayPath({
        ...base,
        interactionStarted: true,
        fullResLoaded: true,
      }),
    ).toBe("/library/original.png");
  });

  it("does not promote video tiles to their original media", () => {
    expect(galleryMediaSupportsFullResOnInteraction("image")).toBe(true);
    expect(galleryMediaSupportsFullResOnInteraction("video")).toBe(false);
  });

  it("opens batch save above the selection bar with a scrollable viewport cap", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/LibraryBatchSaveButton.tsx"),
      "utf8",
    );

    expect(source).toContain("items-end justify-center");
    expect(source).toContain("pb-[72px]");
    expect(source).toContain('maxHeight: "calc(100vh - 120px)"');
    expect(source).toContain("min-h-0 overflow-y-auto");
  });
});
