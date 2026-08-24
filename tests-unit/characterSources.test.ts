import { describe, expect, it } from "vitest";

import type { AssetLedgerEntry } from "../src/lib/ipc";
import { collectCharacterSources } from "../src/lib/characterSources";
import { characterRegisterAssetId } from "../src/lib/store/assetLedger";
import type { Preset } from "../src/lib/store/presets";

function preset(id: string, overrides: Partial<Preset> = {}): Preset {
  return {
    id,
    kind: "character",
    name: `キャラ ${id}`,
    prompt: "",
    categoryId: "characters",
    attachedImages: [{ path: `/sheets/${id}.png` }],
    createdAt: Date.parse("2026-08-20T00:00:00.000Z"),
    updatedAt: Date.parse("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

function ledgerAsset(
  id: string,
  overrides: Partial<AssetLedgerEntry> = {},
): AssetLedgerEntry {
  return {
    id,
    type: "character",
    name: `台帳 ${id}`,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    primaryImagePath: `/ledger/${id}.png`,
    imagePaths: [],
    prompt: "",
    negativePrompt: null,
    source: "film",
    locked: false,
    tags: [],
    ...overrides,
  };
}

describe("collectCharacterSources", () => {
  it("preset と台帳で決められた優先順から参照画像を解決する", () => {
    const sources = collectCharacterSources(
      [
        preset("source-first", {
          characterMeta: { sourceImage: "/references/source-first.png" },
          attachedImages: [{ path: "/sheets/ignored.png" }],
        }),
        preset("attached-fallback", {
          characterMeta: {},
          attachedImages: [{ path: "/sheets/attached-fallback.png" }],
        }),
      ],
      [
        ledgerAsset("primary-first", {
          primaryImagePath: "/ledger/primary.png",
          imagePaths: ["/ledger/ignored.png"],
        }),
        ledgerAsset("image-fallback", {
          primaryImagePath: null,
          imagePaths: ["/ledger/image-fallback.png"],
        }),
      ],
    );

    expect(sources.map((source) => [source.id, source.imagePath])).toEqual([
      ["source-first", "/references/source-first.png"],
      ["attached-fallback", "/sheets/attached-fallback.png"],
      ["primary-first", "/ledger/primary.png"],
      ["image-fallback", "/ledger/image-fallback.png"],
    ]);
  });

  it("生きているプリセットと同じIDのブリッジ台帳行を重複表示しない", () => {
    const livePreset = preset("live-character");
    const sources = collectCharacterSources(
      [livePreset],
      [
        ledgerAsset(characterRegisterAssetId(livePreset.id), {
          source: "character-register",
        }),
      ],
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: livePreset.id,
      origin: "preset",
      preset: livePreset,
    });
  });

  it("画像が無い行も残し、選択不可にできる理由を付ける", () => {
    const sources = collectCharacterSources(
      [
        preset("preset-without-image", {
          attachedImages: [],
          characterMeta: {},
        }),
      ],
      [
        ledgerAsset("ledger-without-image", {
          primaryImagePath: null,
          imagePaths: [],
        }),
      ],
    );

    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.imagePath).toBeNull();
      expect(source.unavailableReason).toBe("画像が登録されていません");
    }
  });

  it("台帳が空ならキャラプリセットだけを既存順で返す", () => {
    const first = preset("first");
    const prompt = preset("prompt", { kind: "prompt" });
    const second = preset("second");

    const sources = collectCharacterSources([first, prompt, second], []);

    expect(sources.map((source) => source.id)).toEqual(["first", "second"]);
    expect(sources.map((source) => source.origin)).toEqual([
      "preset",
      "preset",
    ]);
  });

  it("プリセットを先に保ち、台帳だけのキャラを更新日時の新しい順で後ろへ並べる", () => {
    const sources = collectCharacterSources(
      [preset("preset-first")],
      [
        ledgerAsset("older", {
          updatedAt: "2026-08-21T00:00:00.000Z",
          source: "character-register",
        }),
        ledgerAsset("newer", {
          updatedAt: "2026-08-23T00:00:00.000Z",
          source: "film",
        }),
        ledgerAsset("not-character", {
          type: "scene",
          updatedAt: "2026-08-24T00:00:00.000Z",
        }),
      ],
    );

    expect(sources.map((source) => source.id)).toEqual([
      "preset-first",
      "newer",
      "older",
    ]);
    expect(sources.slice(1).map((source) => source.originLabel)).toEqual([
      "フィルム",
      "登録",
    ]);
  });
});
