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
      aspectRatios: ["16:9", "9:16"],
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
      aspectRatios: null,
    });
  });
});
