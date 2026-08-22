import { describe, expect, it } from "vitest";

import type { RemoteMcpModelCatalog } from "../src/lib/remoteMcpModels";
import {
  reconcileRemoteMcpSelections,
  type RemoteMcpSelection,
} from "../src/lib/store/remoteMcpGen";

function selection(providerId: string, modelId: string): RemoteMcpSelection {
  return {
    providerId,
    providerLabel: providerId,
    toolName: "video_generate",
    inputSchemaJson: "{}",
    kind: "video",
    model: {
      id: modelId,
      name: modelId,
      kind: "video",
      passModel: true,
    },
  };
}

function catalog(providerId: string, modelIds: string[]): RemoteMcpModelCatalog {
  return {
    providerId,
    providerLabel: providerId,
    kind: "video",
    source: "catalog",
    generationTool: {
      name: "video_generate",
      inputSchemaJson: "{}",
    },
    models: modelIds.map((id) => ({
      id,
      name: id,
      kind: "video",
      passModel: true,
    })),
  };
}

describe("再取得後の比較モデル選択", () => {
  it("先頭だけでなく2件目と3件目も調べ、消えたモデルだけを外す", () => {
    const first = selection("krea", "krea-1");
    const second = selection("magnific", "old-model");
    const third = selection("magnific", "current-model");

    const result = reconcileRemoteMcpSelections(
      [first, second, third],
      "magnific",
      catalog("magnific", ["current-model"]),
    );

    expect(result.selections).toEqual([first, third]);
    expect(result.removed).toEqual([second]);
  });

  it("生成ツールが変わったモデル選択も外す", () => {
    const selected = selection("magnific", "current-model");
    const nextCatalog = catalog("magnific", ["current-model"]);
    nextCatalog.generationTool = { name: "create_video", inputSchemaJson: "{}" };

    const result = reconcileRemoteMcpSelections([selected], "magnific", nextCatalog);

    expect(result.selections).toEqual([]);
    expect(result.removed).toEqual([selected]);
  });
});
