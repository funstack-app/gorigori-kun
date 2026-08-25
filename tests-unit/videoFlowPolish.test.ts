import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  deriveRemoteMcpVideoSpecs,
  reconcileRemoteMcpVideoSettings,
} from "../src/lib/remoteMcpModels";
import {
  shareRemoteMcpCatalogRefresh,
  supportedRemoteMcpResolution,
  type RemoteMcpRunInput,
  type RemoteMcpSelection,
} from "../src/lib/store/remoteMcpGen";

describe("動画フロー磨き", () => {
  it("生成スキーマから尺・比率・解像度の対応表を作る", () => {
    const specs = deriveRemoteMcpVideoSpecs(
      {},
      {
        inputSchemaJson: JSON.stringify({
          type: "object",
          properties: {
            duration: { type: "integer", enum: [5, 10], default: 10 },
            aspect_ratio: { type: "string", enum: ["16:9", "9:16"] },
            resolution: { type: "string", enum: ["720p", "1080p"] },
          },
        }),
      },
    );

    expect(specs.durationConstraint).toEqual({ kind: "enum", values: [5, 10], default: 10 });
    expect(specs.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(specs.resolutions).toEqual(["720p", "1080p"]);
    expect(specs.sources).toMatchObject({
      duration: "generation-schema",
      aspectRatios: "generation-schema",
      resolutions: "generation-schema",
    });
  });

  it("モデル変更で非対応の現在値を対応表の先頭へ補正する", () => {
    const result = reconcileRemoteMcpVideoSettings(
      {
        durationConstraint: { kind: "enum", values: [5, 10], default: 10 },
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720p", "1080p"],
      },
      { duration: 15, aspectRatio: "1:1", resolution: "4K" },
      {
        durations: [2, 3, 4],
        aspectRatios: ["1:1", "4:3"],
        resolutions: ["自動"],
      },
    );

    expect(result.options).toEqual({
      durations: [5, 10],
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p", "1080p"],
    });
    expect(result.values).toEqual({ duration: 5, aspectRatio: "16:9", resolution: "720p" });
    expect(result.adjusted).toEqual(["duration", "aspectRatio", "resolution"]);
  });

  it("対応表が無いモデルは従来の汎用候補と現在値を保つ", () => {
    const generic = {
      durations: [2, 3, 4, 5],
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["自動"],
    };
    const result = reconcileRemoteMcpVideoSettings(
      { durationConstraint: null, aspectRatios: null, resolutions: null },
      { duration: 4, aspectRatio: "1:1", resolution: "自動" },
      generic,
    );

    expect(result.options).toEqual(generic);
    expect(result.values).toEqual({ duration: 4, aspectRatio: "1:1", resolution: "自動" });
    expect(result.adjusted).toEqual([]);
  });

  it("resolutionをRemoteMcpRunInputに載せ、対応表があるモデルだけ生成先へ渡す", () => {
    const input = {
      kind: "video",
      prompt: "白い餅が跳ねる",
      resolution: "1080p",
    } satisfies RemoteMcpRunInput;
    const selection = {
      providerId: "krea",
      providerLabel: "Krea",
      toolName: "generate_video",
      inputSchemaJson: "{}",
      kind: "video",
      model: {
        id: "model-with-resolution-map",
        name: "Model with resolution map",
        videoSpecs: { resolutions: ["720p", "1080p"] },
      },
    } as RemoteMcpSelection;

    expect(input.resolution).toBe("1080p");
    expect(supportedRemoteMcpResolution(selection, input.resolution)).toBe("1080p");
    expect(
      supportedRemoteMcpResolution({ ...selection, model: undefined }, input.resolution),
    ).toBeUndefined();
    expect(supportedRemoteMcpResolution(selection, "4K")).toBeUndefined();

    const panelSource = readFileSync(
      resolve(process.cwd(), "src/components/VideoConstructedPromptPanel.tsx"),
      "utf8",
    );
    const runInput = panelSource.slice(
      panelSource.indexOf("startRemoteGeneration({"),
      panelSource.indexOf("compareEach: compareMode"),
    );
    expect(runInput).toContain("resolution,");

    const storeSource = readFileSync(
      resolve(process.cwd(), "src/lib/store/remoteMcpGen.ts"),
      "utf8",
    );
    expect(storeSource.match(/resolution: effectiveInput\.resolution/g)).toHaveLength(2);
  });

  it("同じプロバイダと媒体の同時更新は1本のPromiseを共有する", async () => {
    let finish: ((value: string) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    const first = shareRemoteMcpCatalogRefresh("krea", "video", refresh);
    const second = shareRemoteMcpCatalogRefresh("krea", "video", refresh);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    finish?.("ok");
    await expect(first).resolves.toBe("ok");
    await Promise.resolve();

    const nextRefresh = vi.fn(async () => "new");
    const third = shareRemoteMcpCatalogRefresh("krea", "video", nextRefresh);
    await expect(third).resolves.toBe("new");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(nextRefresh).toHaveBeenCalledTimes(1);
  });

  it("設定UIはプロンプト→モデル→3チップ→生成ボタンの順", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/VideoConstructedPromptPanel.tsx"),
      "utf8",
    );
    const prompt = source.indexOf("<PromptTextareaWithMentions");
    const model = source.indexOf('<HiggsfieldModelSelector media="video" />');
    const chips = source.indexOf("data-video-setting-chips");
    const submit = source.indexOf('data-tour="video-generation-submit"');

    expect(prompt).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(prompt);
    expect(chips).toBeGreaterThan(model);
    expect(submit).toBeGreaterThan(chips);
    expect(source.slice(chips, submit)).toContain('label="尺"');
    expect(source.slice(chips, submit)).toContain('label="比率"');
    expect(source.slice(chips, submit)).toContain('label="解像度"');
  });

  it("保存済みMagnific一覧を表示したまま裏更新し、成功後は選択を整理する", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/HiggsfieldModelSelector.tsx"),
      "utf8",
    );

    expect(source).toContain("refreshMagnificVideoModels({ keepVisible: Boolean(cached) })");
    expect(source).toContain("if (!options.keepVisible) setMagnificVideoState({ kind: \"loading\" })");
    expect(source).toContain("removeUnavailableSelections(providerId, catalog)");
    expect(source).toContain("shareRemoteMcpCatalogRefresh(");
  });
});
