import { describe, expect, it } from "vitest";

import type { RemoteMcpToolInfo } from "../src/lib/ipc";
import {
  buildRemoteMcpModelCatalog,
  classifyRemoteMcpModel,
  deriveRemoteMcpVideoSpecs,
  extractRemoteMcpCatalogModels,
  findRemoteMcpModelListTool,
  selectPrimaryRemoteMcpGenerationTool,
} from "../src/lib/remoteMcpModels";

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
});
