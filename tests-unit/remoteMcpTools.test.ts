import { describe, expect, it } from "vitest";
import {
  buildRemoteMcpParams,
  classifyRemoteMcpTool,
  groupRemoteMcpTools,
  remoteMcpSchemaHasModelField,
  type RemoteMcpToolLike,
} from "../src/lib/remoteMcpTools";

function tool(name: string, properties: Record<string, unknown> = {}): RemoteMcpToolLike {
  return {
    name,
    inputSchemaJson: JSON.stringify({ type: "object", properties }),
  };
}

describe("classifyRemoteMcpTool", () => {
  it.each([
    ["generate_image", "image"],
    ["create-photo", "image"],
    ["text_to_image", "image"],
    ["generate_video", "video"],
    ["createMovie", "video"],
    ["image_to_video", "video"],
    ["text-to-video", "video"],
  ] as const)("%s を %s 生成へ分類する", (name, expected) => {
    expect(classifyRemoteMcpTool(tool(name))).toBe(expected);
  });

  it("汎用 generate は schema の媒体フィールドで分類する", () => {
    expect(
      classifyRemoteMcpTool(tool("generate", { video_prompt: { type: "string" } })),
    ).toBe("video");
    expect(
      classifyRemoteMcpTool(tool("create", { image_prompt: { type: "string" } })),
    ).toBe("image");
  });

  it("媒体名があっても一覧・削除は生成扱いにしない", () => {
    expect(classifyRemoteMcpTool(tool("list_image_models"))).toBe("other");
    expect(classifyRemoteMcpTool(tool("delete_video"))).toBe("other");
  });

  it("画像と動画の両方が候補になる汎用生成は推測せずその他にする", () => {
    expect(
      classifyRemoteMcpTool(
        tool("generate_asset", { output_type: { type: "string", enum: ["image", "video"] } }),
      ),
    ).toBe("other");
  });

  it("3分類の配列を作る", () => {
    const groups = groupRemoteMcpTools([
      tool("generate_image"),
      tool("generate_video"),
      tool("account_balance"),
    ]);
    expect(groups.image.map((item) => item.name)).toEqual(["generate_image"]);
    expect(groups.video.map((item) => item.name)).toEqual(["generate_video"]);
    expect(groups.other.map((item) => item.name)).toEqual(["account_balance"]);
  });
});

describe("buildRemoteMcpParams", () => {
  it("代表フィールドへプロンプト・モデル・比率・枚数を割り当てる", () => {
    const result = buildRemoteMcpParams(
      JSON.stringify({
        type: "object",
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          aspect_ratio: { type: "string" },
          n: { type: "integer" },
        },
        required: ["prompt", "model", "aspect_ratio", "n"],
      }),
      { prompt: "白いお餅", model: "krea-1", aspectRatio: "16:9", count: 2 },
    );

    expect(result.params).toEqual({
      prompt: "白いお餅",
      model: "krea-1",
      aspect_ratio: "16:9",
      n: 2,
    });
    expect(JSON.parse(result.paramsJson)).toEqual(result.params);
    expect(result.missingRequired).toEqual([]);
  });

  it("別名 text/model_id/resolution/num_images にも割り当てる", () => {
    const result = buildRemoteMcpParams(
      JSON.stringify({
        properties: {
          text: { type: "string" },
          model_id: { type: "string" },
          resolution: { type: "string" },
          num_images: { type: "string" },
        },
        required: ["text"],
      }),
      { prompt: "湯気の立つ餅", model: "m-2", aspectRatio: "1:1", count: 3 },
    );
    expect(result.params).toEqual({
      text: "湯気の立つ餅",
      model_id: "m-2",
      resolution: "1:1",
      num_images: "3",
    });
  });

  it("description/input もプロンプト候補として使う", () => {
    const description = buildRemoteMcpParams(
      JSON.stringify({ properties: { description: { type: "string" } }, required: ["description"] }),
      { prompt: "scene" },
    );
    const input = buildRemoteMcpParams(
      JSON.stringify({ properties: { input: { type: "string" } }, required: ["input"] }),
      { prompt: "scene" },
    );
    expect(description.params).toEqual({ description: "scene" });
    expect(input.params).toEqual({ input: "scene" });
  });

  it("未知の required は推測で埋めず、不足項目として返す", () => {
    const result = buildRemoteMcpParams(
      JSON.stringify({
        properties: {
          prompt: { type: "string" },
          seed: { type: "integer" },
          input_image: { type: "string" },
        },
        required: ["prompt", "seed", "input_image"],
      }),
      { prompt: "scene" },
    );
    expect(result.params).toEqual({ prompt: "scene" });
    expect(result.missingRequired).toEqual(["seed", "input_image"]);
  });

  it("required の default と const は schema の明示値を使う", () => {
    const result = buildRemoteMcpParams(
      JSON.stringify({
        properties: {
          prompt: { type: "string" },
          seed: { type: "integer", default: 42 },
          mode: { type: "string", const: "fast" },
        },
        required: ["prompt", "seed", "mode"],
      }),
      { prompt: "scene" },
    );
    expect(result.params).toEqual({ seed: 42, mode: "fast", prompt: "scene" });
    expect(result.missingRequired).toEqual([]);
  });

  it("モデル欄の有無を schema から判定する", () => {
    expect(
      remoteMcpSchemaHasModelField(
        JSON.stringify({ properties: { model_name: { type: "string" } } }),
      ),
    ).toBe(true);
    expect(
      remoteMcpSchemaHasModelField(
        JSON.stringify({ properties: { prompt: { type: "string" } } }),
      ),
    ).toBe(false);
  });

  it("壊れた schema は空で送らずエラーを返す", () => {
    const result = buildRemoteMcpParams("{broken", { prompt: "scene" });
    expect(result.paramsJson).toBe("{}");
    expect(result.params).toEqual({});
    expect(result.schemaError).toContain("読み取れません");
  });
});
