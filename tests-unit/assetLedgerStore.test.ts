import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetLedgerEntry, AssetLedgerFile } from "../src/lib/ipc";
import type { Preset } from "../src/lib/store/presets";

const harness = vi.hoisted(() => ({
  read: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  initializePresets: vi.fn(),
  presetState: { presets: [] as Preset[] },
}));

vi.mock("../src/lib/ipc", () => ({
  assetLedger: {
    read: harness.read,
    upsert: harness.upsert,
    delete: harness.delete,
  },
}));

vi.mock("../src/lib/store/presets", () => ({
  presetKind: (preset: Preset) =>
    preset.kind === "character" ? "character" : "prompt",
  usePresets: {
    getState: () => ({
      presets: harness.presetState.presets,
      initialize: harness.initializePresets,
    }),
  },
}));

import { useAssetLedger } from "../src/lib/store/assetLedger";

function asset(id = "al-1"): AssetLedgerEntry {
  return {
    id,
    type: "custom",
    name: "テスト素材",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    primaryImagePath: null,
    imagePaths: [],
    prompt: "",
    negativePrompt: null,
    source: "import",
    locked: false,
    tags: [],
  };
}

function characterPreset(id = "preset-char-1"): Preset {
  return {
    id,
    kind: "character",
    name: "文子",
    prompt: "黒髪、白いシャツ",
    categoryId: "characters",
    tags: ["主人公"],
    attachedImages: [
      { path: "/characters/fumiko-sheet.png", role: "subject" },
      { path: "/characters/fumiko-face.png", role: "subject" },
    ],
    characterMeta: {
      sourceImage: "/references/fumiko.png",
      sourceImages: ["/references/fumiko.png"],
    },
    createdAt: Date.parse("2026-08-20T00:00:00.000Z"),
    updatedAt: Date.parse("2026-08-21T00:00:00.000Z"),
  };
}

describe("assetLedger store", () => {
  let disk: AssetLedgerFile;

  beforeEach(() => {
    disk = { version: 1, assets: [] };
    harness.presetState.presets = [];
    harness.read.mockReset().mockImplementation(async () => ({
      version: 1,
      assets: [...disk.assets],
    }));
    harness.upsert.mockReset().mockImplementation(async (incoming: AssetLedgerEntry) => {
      const index = disk.assets.findIndex((item) => item.id === incoming.id);
      disk.assets =
        index < 0
          ? [...disk.assets, incoming]
          : disk.assets.map((item, current) =>
              current === index ? incoming : item,
            );
      return incoming;
    });
    harness.delete.mockReset().mockImplementation(async (id: string) => {
      disk.assets = disk.assets.filter((item) => item.id !== id);
    });
    harness.initializePresets.mockReset().mockResolvedValue(undefined);
    useAssetLedger.setState({
      assets: [],
      loading: false,
      loaded: false,
      error: null,
    });
  });

  it("読み込み時に既存キャラを1度だけ台帳へ取り込む", async () => {
    harness.presetState.presets = [characterPreset(), { ...characterPreset("prompt-1"), kind: "prompt" }];

    await useAssetLedger.getState().load();

    expect(harness.initializePresets).toHaveBeenCalledTimes(1);
    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "al-character-register-preset-char-1",
        type: "character",
        source: "character-register",
        name: "文子",
        prompt: "黒髪、白いシャツ",
        primaryImagePath: "/characters/fumiko-sheet.png",
        imagePaths: [
          "/characters/fumiko-face.png",
          "/references/fumiko.png",
        ],
      }),
    );
    expect(useAssetLedger.getState()).toMatchObject({
      loading: false,
      loaded: true,
      error: null,
      assets: [expect.objectContaining({ source: "character-register" })],
    });

    await useAssetLedger.getState().load();

    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(useAssetLedger.getState().assets).toHaveLength(1);
  });

  it("upsert成功後に状態へ追加し、失敗時は既存状態を残す", async () => {
    const first = asset();
    await useAssetLedger.getState().upsert(first);
    expect(useAssetLedger.getState().assets).toEqual([first]);

    harness.upsert.mockRejectedValueOnce(new Error("保存失敗"));
    await expect(
      useAssetLedger.getState().upsert(asset("al-2")),
    ).rejects.toThrow("保存失敗");

    expect(useAssetLedger.getState().assets).toEqual([first]);
    expect(useAssetLedger.getState().error).toContain("保存失敗");
  });

  it("delete成功後だけ状態から削除する", async () => {
    const first = asset();
    useAssetLedger.setState({ assets: [first] });

    await useAssetLedger.getState().delete(first.id);

    expect(harness.delete).toHaveBeenCalledWith(first.id);
    expect(useAssetLedger.getState().assets).toEqual([]);
    expect(useAssetLedger.getState().error).toBeNull();
  });
});
