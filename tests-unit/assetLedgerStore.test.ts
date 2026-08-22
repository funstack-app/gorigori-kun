import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetLedgerEntry, AssetLedgerFile } from "../src/lib/ipc";
import type { FilmAsset } from "../src/lib/film/types";
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

import {
  characterRegisterAssetId,
  characterRegisterOutputToLedgerAsset,
  filmAssetLedgerId,
  filmAssetToLedgerAsset,
  useAssetLedger,
} from "../src/lib/store/assetLedger";

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

function filmAsset(overrides: Partial<FilmAsset> = {}): FilmAsset {
  return {
    id: "CH-01",
    name: "美咲",
    type: "character",
    importance: "primary",
    blockIds: ["B-01"],
    status: "reviewed",
    pairKey: null,
    pairSide: null,
    promptDraft: "人物シートの生成指示文\n全文",
    generatedImagePaths: ["/film/misaki-a.png"],
    lastGeneratedPrompt: "人物シートの生成指示文\n全文",
    canonicalImagePath: "/film/misaki-a.png",
    ngNotes: [],
    stressTest: null,
    locked: false,
    ...overrides,
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

  it("キャラ登録の元IDを同じ台帳行へ対応付け、確定シート画像と名前だけを保存する", async () => {
    const sourcePresetId = "preset/char 1";
    const now = new Date("2026-08-22T12:00:00.000Z");
    const existing = asset(characterRegisterAssetId(sourcePresetId));
    existing.createdAt = "2026-08-20T00:00:00.000Z";
    existing.prompt = "以前の指示文";
    existing.imagePaths = ["/old/source.png"];

    const converted = characterRegisterOutputToLedgerAsset(
      sourcePresetId,
      " 文子 ",
      ["/sheets/fumiko.png", "/sheets/fumiko.png", "/sheets/fumiko-face.png"],
      existing,
      now,
    );

    expect(converted).toEqual({
      id: "al-character-register-preset%2Fchar%201",
      type: "character",
      name: "文子",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: now.toISOString(),
      primaryImagePath: "/sheets/fumiko.png",
      imagePaths: ["/sheets/fumiko-face.png"],
      prompt: "",
      negativePrompt: null,
      source: "character-register",
      locked: false,
      tags: [],
    });

    // 先に既存プリセットの読み込みブリッジが同じIDを作っても、完成シートの登録は
    // 2件目を増やさず、その1件を画像だけの内容へ更新する。
    harness.presetState.presets = [characterPreset(sourcePresetId)];
    await useAssetLedger.getState().upsertCharacterRegisterOutput(
      sourcePresetId,
      "文子（更新）",
      ["/sheets/fumiko-v2.png"],
    );

    expect(harness.upsert).toHaveBeenCalledTimes(2);
    expect(useAssetLedger.getState().assets).toHaveLength(1);
    expect(useAssetLedger.getState().assets[0]).toMatchObject({
      id: characterRegisterAssetId(sourcePresetId),
      name: "文子（更新）",
      primaryImagePath: "/sheets/fumiko-v2.png",
      imagePaths: [],
      prompt: "",
      source: "character-register",
    });
  });

  it("フィルム種別を台帳種別へ対応させ、採用画像と指示文全文を保つ", () => {
    const now = new Date("2026-08-22T12:34:56.000Z");
    const mappings = [
      ["character", "character"],
      ["location", "scene"],
      ["prop", "prop"],
      ["text", "custom"],
    ] as const;

    for (const [filmType, ledgerType] of mappings) {
      const converted = filmAssetToLedgerAsset(
        "film-1",
        filmAsset({ type: filmType }),
        undefined,
        now,
      );
      expect(converted).toMatchObject({
        id: "al-film-film-1-CH-01",
        type: ledgerType,
        name: "美咲",
        primaryImagePath: "/film/misaki-a.png",
        prompt: "人物シートの生成指示文\n全文",
        source: "film",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }
  });

  it("同じ作品の同じフィルム素材を再登録しても1件を更新する", async () => {
    const first = filmAsset();
    await useAssetLedger.getState().upsertFilmAsset("film-1", first);
    const firstSaved = useAssetLedger.getState().assets[0];

    await useAssetLedger.getState().upsertFilmAsset(
      "film-1",
      filmAsset({
        canonicalImagePath: "/film/misaki-b.png",
        promptDraft: "修正後の生成指示文全文",
      }),
    );

    expect(harness.upsert).toHaveBeenCalledTimes(2);
    expect(useAssetLedger.getState().assets).toHaveLength(1);
    expect(useAssetLedger.getState().assets[0]).toMatchObject({
      id: filmAssetLedgerId("film-1", "CH-01"),
      createdAt: firstSaved?.createdAt,
      primaryImagePath: "/film/misaki-b.png",
      prompt: "修正後の生成指示文全文",
    });
  });
});
