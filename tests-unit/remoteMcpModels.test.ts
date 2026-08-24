import { describe, expect, it, vi } from "vitest";

import { remoteMcp, type RemoteMcpToolInfo } from "../src/lib/ipc";
import {
  buildRemoteMcpModelCatalog,
  buildHiggsfieldVideoModelCatalog,
  classifyRemoteMcpModel,
  deriveRemoteMcpVideoSpecs,
  extractRemoteMcpCatalogModels,
  fetchRemoteMcpModelCatalog,
  findRemoteMcpModelListTool,
  findRemoteMcpModelInfoTool,
  selectPrimaryRemoteMcpGenerationTool,
} from "../src/lib/remoteMcpModels";
import { buildRemoteMcpParams } from "../src/lib/remoteMcpTools";

function tool(
  name: string,
  properties: Record<string, unknown> = {},
  extra: Partial<RemoteMcpToolInfo> = {},
): RemoteMcpToolInfo {
  return {
    name,
    inputSchemaJson: JSON.stringify({ type: "object", properties }),
    ...extra,
  };
}

describe("remote MCP model catalog", () => {
  it("モデル一覧ツールを決めた優先順で1つ選ぶ", () => {
    const selected = findRemoteMcpModelListTool([
      tool("video_models_list"),
      tool("get_models"),
      tool("list_models"),
      tool("generate_video"),
    ]);
    expect(selected?.name).toBe("list_models");
    expect(
      findRemoteMcpModelListTool(
        [tool("video_models_list"), tool("list_models")],
        "video",
      )?.name,
    ).toBe("video_models_list");
  });

  it("Pollo の pollo_list_models をモデル一覧ツールとして選ぶ", () => {
    const selected = findRemoteMcpModelListTool([
      tool("get_models"),
      tool("pollo_list_models"),
      tool("pollo_generate_image"),
    ]);
    expect(selected?.name).toBe("pollo_list_models");
  });

  it("OpenArt の openart_model_list をモデル一覧ツールとして選ぶ", () => {
    const selected = findRemoteMcpModelListTool([
      tool("openart_generate_image"),
      tool("openart_model_list"),
    ]);
    expect(selected?.name).toBe("openart_model_list");
  });

  it("接続先のモデル一覧が空なら標準モデルへ退避して警告する", async () => {
    const query = vi.spyOn(remoteMcp, "query").mockResolvedValue({
      contentText: "",
      structuredContent: { models: [] },
    });

    try {
      const catalog = await fetchRemoteMcpModelCatalog({
        providerId: "ideogram",
        providerLabel: "Ideogram",
        kind: "image",
        tools: [
          tool("list_models"),
          tool("generate_image", { prompt: { type: "string" } }),
        ],
      });

      expect(query).toHaveBeenCalledWith({
        providerId: "ideogram",
        toolName: "list_models",
        paramsJson: "{}",
      });
      expect(catalog.source).toBe("standard");
      expect(catalog.warning).toBe(
        "接続先のモデル一覧が空のため、標準モデルで生成します。",
      );
    } finally {
      query.mockRestore();
    }
  });

  it("モデル一覧の応答が読めない場合は既存の unavailable エラーを保つ", async () => {
    const query = vi.spyOn(remoteMcp, "query").mockResolvedValue({
      contentText: "モデル一覧を表示しました",
    });

    try {
      await expect(
        fetchRemoteMcpModelCatalog({
          providerId: "magnific",
          providerLabel: "Magnific",
          kind: "video",
          tools: [
            tool("video_models_list"),
            tool("video_generate", { prompt: { type: "string" } }),
          ],
        }),
      ).rejects.toThrow(
        "モデル一覧を取得できませんでした: Error: モデル一覧の応答から実モデルを読み取れませんでした。",
      );
    } finally {
      query.mockRestore();
    }
  });

  it("媒体ごとの主生成ツールを名前ヒューリスティックで選ぶ", () => {
    const tools = [
      tool("create_video"),
      tool("video_generate"),
      tool("video_upscale"),
      tool("generate_image"),
    ];
    expect(selectPrimaryRemoteMcpGenerationTool(tools, "video")?.name).toBe("video_generate");
    expect(selectPrimaryRemoteMcpGenerationTool(tools, "image")?.name).toBe("generate_image");
  });

  it("元動画が必須の編集ツールを生成候補から外す", () => {
    const editor = tool("video_generate", {}, {
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          prompt: { type: "string" },
          video: { type: "string" },
        },
        required: ["prompt", "video"],
      }),
    });
    const textToVideo = tool("create_video", { prompt: { type: "string" } });
    expect(selectPrimaryRemoteMcpGenerationTool([editor, textToVideo], "video")?.name).toBe(
      "create_video",
    );
  });

  it("開始画像が必須のimage_to_videoは動画生成に残し、元動画必須の編集は除外する", () => {
    const imageToVideo = tool("image_to_video", {}, {
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          prompt: { type: "string" },
          start_image: { type: "string" },
        },
        required: ["prompt", "start_image"],
      }),
    });
    const videoToVideo = tool("video_to_video", {}, {
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: {
          prompt: { type: "string" },
          source_video: { type: "string" },
        },
        required: ["prompt", "source_video"],
      }),
    });

    expect(selectPrimaryRemoteMcpGenerationTool([imageToVideo], "video")?.name).toBe(
      "image_to_video",
    );
    expect(selectPrimaryRemoteMcpGenerationTool([videoToVideo], "video")).toBeNull();
    expect(classifyRemoteMcpModel({ id: "i2v-kind", name: "I2V Kind" })).toBe(
      "video",
    );
  });

  it("Krea型のモデル情報ツールを説明と実名から選ぶ", () => {
    const selected = findRemoteMcpModelInfoTool([
      tool("list_models"),
      tool("get_model_info", { model: { type: "string" } }, {
        description: "For Seedance 2 and Kling 3.0 models, fetch model specifications",
      }),
    ]);
    expect(selected?.name).toBe("get_model_info");
  });

  it("type系メタデータを名前より優先して画像・動画へ分類する", () => {
    expect(
      classifyRemoteMcpModel({
        id: "ambiguous-model",
        name: "Flux Video Name",
        metadata: { output_type: "image" },
      }),
    ).toBe("image");
    expect(classifyRemoteMcpModel({ id: "veo-3", name: "Veo 3" })).toBe("video");
    expect(classifyRemoteMcpModel({ id: "flux-2", name: "FLUX 2" })).toBe("image");
    expect(classifyRemoteMcpModel({ id: "mystery", name: "Mystery" })).toBe("other");
  });

  it("structuredContent と content text の代表形からモデルを重複なく抽出する", () => {
    const models = extractRemoteMcpCatalogModels(
      {
        structuredContent: {
          models: [
            { id: "seedance-2", name: "Seedance 2", type: "video" },
            { id: "happy-horse", name: "Happy Horse" },
          ],
        },
        contentText: JSON.stringify({ data: [{ id: "seedance-2", name: "Seedance 2" }] }),
      },
      "video",
    );
    expect(models.map((model) => [model.id, model.kind])).toEqual([
      ["seedance-2", "video"],
      ["happy-horse", "video"],
    ]);
  });

  it("slug をキーにしたモデル辞書と Markdown 一覧から実モデル名を抽出する", () => {
    const keyed = extractRemoteMcpCatalogModels(
      {
        structuredContent: {
          result: {
            videoModels: {
              "kling-3.0": { name: "Kling 3.0", durations: [5, 10] },
              "seedance-2.5": { label: "Seedance 2.5" },
            },
          },
        },
        contentText: "",
      },
      "video",
    );
    expect(keyed.map((model) => [model.id, model.name])).toEqual([
      ["kling-3.0", "Kling 3.0"],
      ["seedance-2.5", "Seedance 2.5"],
    ]);

    const markdown = extractRemoteMcpCatalogModels(
      {
        contentText: [
          "Available video models:",
          "- **Kling 3.0** (`kling-3.0`)",
          "- `seedance-2.5` — Seedance 2.5",
        ].join("\n"),
      },
      "video",
    );
    expect(markdown.map((model) => [model.id, model.name])).toEqual([
      ["kling-3.0", "Kling 3.0"],
      ["seedance-2.5", "Seedance 2.5"],
    ]);
  });

  it("一覧が無ければ主生成ツールの model enum を使う", () => {
    const catalog = buildRemoteMcpModelCatalog({
      providerId: "runway",
      providerLabel: "Runway",
      kind: "video",
      tools: [
        tool("video_generate", {
          prompt: { type: "string" },
          model_id: { type: "string", enum: ["gen-4", "veo-3"] },
        }),
      ],
    });
    expect(catalog.source).toBe("enum");
    expect(catalog.models.map((model) => model.id)).toEqual(["gen-4", "veo-3"]);
    expect(catalog.generationTool?.name).toBe("video_generate");
  });

  it("一覧も enum も無ければ偽の model 値を送らない標準1件にする", () => {
    const catalog = buildRemoteMcpModelCatalog({
      providerId: "krea",
      providerLabel: "Krea",
      kind: "image",
      tools: [tool("generate_image", { prompt: { type: "string" } })],
    });
    expect(catalog.source).toBe("standard");
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({ name: "Krea 標準", passModel: false });
  });

  it("一覧ツールがある接続先では、読めない応答を標準1件へ置き換えない", () => {
    const catalog = buildRemoteMcpModelCatalog({
      providerId: "magnific",
      providerLabel: "Magnific",
      kind: "video",
      tools: [tool("video_generate", { prompt: { type: "string" } })],
      catalogOutput: { contentText: "モデル一覧を表示しました" },
      catalogToolName: "video_models_list",
      requireExplicitModels: true,
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(catalog.warning).toContain("実モデル");
  });

  it("video_models_list の媒体ヒントで未知名の実モデルも動画一覧へ残す", () => {
    const catalog = buildRemoteMcpModelCatalog({
      providerId: "magnific",
      providerLabel: "Magnific",
      kind: "video",
      tools: [tool("video_generate", { prompt: { type: "string" } })],
      catalogOutput: {
        structuredContent: { models: [{ id: "future-v1", name: "Future V1" }] },
        contentText: "",
      },
      catalogToolName: "video_models_list",
      requireExplicitModels: true,
    });
    expect(catalog.source).toBe("catalog");
    expect(catalog.models.map((model) => [model.id, model.kind])).toEqual([
      ["future-v1", "video"],
    ]);
  });
});

describe("remote MCP nested params", () => {
  it("Krea形式の2段inputラッパー内へ共通入力を包む", () => {
    const result = buildRemoteMcpParams(
      JSON.stringify({
        type: "object",
        properties: {
          request: {
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  prompt: { type: "string" },
                  model: { type: "string" },
                  duration: { type: "integer" },
                  aspect_ratio: { type: "string" },
                },
                required: ["prompt", "model", "duration", "aspect_ratio"],
              },
            },
            required: ["input"],
          },
        },
        required: ["request"],
      }),
      {
        prompt: "走る犬",
        model: "kling-3.0",
        durationSeconds: 6,
        aspectRatio: "16:9",
      },
    );

    expect(result.params).toEqual({
      request: {
        input: {
          prompt: "走る犬",
          model: "kling-3.0",
          duration: 6,
          aspect_ratio: "16:9",
        },
      },
    });
    expect(result.missingRequired).toEqual([]);
  });
});

describe("remote MCP video specs", () => {
  it("inputSchema の有無・maxItems・enum/range から取得できた仕様だけを返す", () => {
    const specs = deriveRemoteMcpVideoSpecs(
      {},
      tool("video_generate", {
        first_frame: { type: "string" },
        last_frame: { type: "string" },
        reference_images: {
          type: "array",
          maxItems: 4,
          items: { type: "string" },
        },
        motion_reference: { type: "string" },
        duration: { type: "integer", minimum: 3, maximum: 10 },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
      }),
    );
    expect(specs).toEqual({
      startEndImages: "supported",
      referenceTypes: ["image", "motion"],
      referenceLimit: 4,
      duration: "3〜10秒",
      durationConstraint: { kind: "integer", default: 3, min: 3, max: 10, step: 1 },
      aspectRatios: ["16:9", "9:16"],
      modes: null,
      audio: "unknown",
      multiCut: "unknown",
      sources: {
        startEndImages: "generation-schema",
        referenceTypes: "generation-schema",
        referenceLimit: "generation-schema",
        duration: "generation-schema",
        aspectRatios: "generation-schema",
      },
    });
  });

  it("カタログの明示メタデータを優先し、取れない項目は unknown/null にする", () => {
    const specs = deriveRemoteMcpVideoSpecs(
      {
        metadata: {
          supportsStartEndFrames: false,
          supported_reference_types: ["video"],
          max_references: 2,
          supported_durations: [5, 10],
        },
      },
      null,
    );
    expect(specs.startEndImages).toBe("unsupported");
    expect(specs.referenceTypes).toEqual(["video"]);
    expect(specs.referenceLimit).toBe(2);
    expect(specs.duration).toBe("5秒 / 10秒");
    expect(specs.aspectRatios).toBeNull();

    expect(deriveRemoteMcpVideoSpecs({}, null)).toEqual({
      startEndImages: "unknown",
      referenceTypes: null,
      referenceLimit: null,
      duration: null,
      durationConstraint: null,
      aspectRatios: null,
      modes: null,
      audio: "unknown",
      multiCut: "unknown",
      sources: {},
    });
  });

  it("モード・音声・マルチカットは明示された対応だけを仕様として返す", () => {
    const specs = deriveRemoteMcpVideoSpecs(
      {
        metadata: {
          supported_modes: ["standard", "fast"],
          supports_audio: true,
          supports_multi_cut: true,
          duration: { min: 4, max: 12, step: 2, default: 6 },
        },
      },
      null,
    );
    expect(specs.modes).toEqual(["standard", "fast"]);
    expect(specs.audio).toBe("supported");
    expect(specs.multiCut).toBe("supported");
    expect(specs.durationConstraint).toEqual({
      kind: "integer",
      min: 4,
      max: 12,
      step: 2,
      default: 6,
    });
  });

  it("モデル情報の実応答から尺・比率・参照上限を読み、出所を区別する", () => {
    const specs = deriveRemoteMcpVideoSpecs(
      {
        metadata: {
          __specSource: "model-info",
          modelInfo: {
            duration_range: { min: 4, max: 10, step: 2, default: 6 },
            supported_aspect_ratios: ["16:9", "9:16"],
            supported_reference_types: ["image"],
            max_reference_images: 3,
          },
        },
      },
      null,
    );
    expect(specs.durationConstraint).toEqual({
      kind: "integer",
      min: 4,
      max: 10,
      step: 2,
      default: 6,
    });
    expect(specs.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(specs.referenceTypes).toEqual(["image"]);
    expect(specs.referenceLimit).toBe(3);
    expect(specs.sources).toMatchObject({
      duration: "model-info",
      aspectRatios: "model-info",
      referenceTypes: "model-info",
      referenceLimit: "model-info",
    });
  });

  it("HiggsField実名一覧へ、既知モデルだけ実測仕様を補完して出所を残す", () => {
    const catalog = buildHiggsfieldVideoModelCatalog(
      [
        { displayName: "Kling 3.0", jobSetType: "kling3_0", type: "video" },
        { displayName: "Future Video", jobSetType: "future_video", type: "video" },
      ],
      { fallback: false, fetchedAt: 123 },
    );
    expect(catalog.models.map((model) => model.name)).toEqual(["Kling 3.0", "Future Video"]);
    expect(catalog.models[0].videoSpecs?.durationConstraint).toEqual({
      kind: "integer",
      default: 5,
      min: 2,
      max: 10,
    });
    expect(catalog.models[0].videoSpecs?.sources?.duration).toBe("measured-fallback");
    expect(catalog.models[1].videoSpecs?.durationConstraint).toBeNull();
  });
});
