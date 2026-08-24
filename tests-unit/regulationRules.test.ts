import { describe, expect, it, vi } from "vitest";

import type { RegulationRulesFile } from "../src/lib/store/regulationRules";

import {
  checkImageSpecification,
  isAspectRatioWithinTolerance,
} from "../src/lib/regulationCheck/imageSpecs";
import { DEFAULT_RULE_SETS } from "../src/lib/regulationCheck/rules";

const MEDIA_IDS = [
  "meta-ads",
  "google-ads",
  "line-ads",
  "tiktok-ads",
  "x-ads",
  "yahoo-ads",
] as const;

describe("2026-08-22 媒体別ルールセット", () => {
  it.each(MEDIA_IDS)("%s が存在し、全ルールに出典と確認情報がある", (id) => {
    const ruleSet = DEFAULT_RULE_SETS.find((candidate) => candidate.id === id);

    expect(ruleSet).toBeDefined();
    expect(ruleSet!.rules.length).toBeGreaterThan(0);
    for (const rule of ruleSet!.rules) {
      expect(rule.sourceUrl).toMatch(/^https:\/\//);
      expect(rule.checkedAt).toBe("2026-08-22");
      expect(["machine", "ai", "legal"]).toContain(rule.kind);
      expect(["high", "medium", "low"]).toContain(rule.confidence);
    }
  });

  it("未確認の数値を持つ媒体は、ルールセット冒頭用の未収録注記を持つ", () => {
    for (const id of ["meta-ads", "tiktok-ads", "x-ads", "yahoo-ads"]) {
      const ruleSet = DEFAULT_RULE_SETS.find((candidate) => candidate.id === id)!;
      expect(ruleSet.notes.some((note) => note.includes("未確認のため未収録"))).toBe(true);
    }
  });

  it("Metaの旧20%ルールを廃止済みの情報ルールとして保持する", () => {
    const meta = DEFAULT_RULE_SETS.find((candidate) => candidate.id === "meta-ads")!;
    const legacy = meta.rules.find((rule) => rule.id === "meta-legacy-text-20");

    expect(legacy?.criteria).toContain("2020年に廃止済み");
    expect(legacy?.criteria).toContain("絶対に指摘しない");
  });
});

describe("画像規格の決定論チェック", () => {
  it("LINEの固定寸法・比率・PNG・容量がすべて合えば合格する", () => {
    const results = checkImageSpecification("line-ads", {
      width: 1200,
      height: 628,
      extension: ".PNG",
      fileSizeBytes: 1024 * 1024,
    });

    expect(results.map((result) => result.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("寸法・比率・形式・容量が規格外なら、それぞれ不合格になる", () => {
    const results = checkImageSpecification("line-ads", {
      width: 1200,
      height: 700,
      extension: "webp",
      fileSizeBytes: 11 * 1024 * 1024,
    });

    expect(results.map((result) => [result.name, result.status])).toEqual([
      ["ファイル形式", "fail"],
      ["アスペクト比", "fail"],
      ["画像サイズ", "fail"],
      ["ファイル容量", "fail"],
    ]);
  });

  it("アスペクト比は3%ちょうどを許容し、境界を超えたら不合格にする", () => {
    expect(isAspectRatioWithinTolerance(1030, 1000, 1, 1)).toBe(true);
    expect(isAspectRatioWithinTolerance(1031, 1000, 1, 1)).toBe(false);

    const atBoundary = checkImageSpecification("google-ads", {
      width: 1030,
      height: 1000,
      extension: "jpg",
      fileSizeBytes: null,
    });
    const outside = checkImageSpecification("google-ads", {
      width: 1031,
      height: 1000,
      extension: "jpg",
      fileSizeBytes: null,
    });

    expect(atBoundary.find((result) => result.name === "アスペクト比")?.status).toBe("pass");
    expect(outside.find((result) => result.name === "アスペクト比")?.status).toBe("fail");
  });

  it("Metaは4:5でも最小600×750px未満なら画像サイズを不合格にする", () => {
    const results = checkImageSpecification("meta-ads", {
      width: 599,
      height: 749,
      extension: "jpg",
      fileSizeBytes: 1024,
    });

    expect(results.find((result) => result.name === "アスペクト比")?.status).toBe("pass");
    expect(results.find((result) => result.name === "画像サイズ")?.status).toBe("fail");
  });
});

describe("クライアント別ルールの保存", () => {
  it("保存済みの媒体とカスタムルール下書きを復元する", async () => {
    const storeModule = await import("../src/lib/store/regulationRules");
    vi.spyOn(storeModule.regulationRulesGuard, "load").mockResolvedValue({
      status: "ok",
      value: {
        version: 1,
        savedRules: [],
        draft: { ruleSetId: "google-ads", customRule: "ロゴを右上に置く" },
      },
    });

    await storeModule.useRegulationRules.getState().hydrate();

    expect(storeModule.useRegulationRules.getState()).toMatchObject({
      hydrated: true,
      draft: { ruleSetId: "google-ads", customRule: "ロゴを右上に置く" },
    });
  });

  it("hydrate前は保存せず、下書きの連続変更を300ms後の1回にまとめる", async () => {
    vi.useFakeTimers();
    try {
      const storeModule = await import("../src/lib/store/regulationRules");
      vi.spyOn(storeModule.regulationRulesGuard, "load").mockResolvedValue({
        status: "absent",
      });
      const save = vi
        .spyOn(storeModule.regulationRulesGuard, "save")
        .mockResolvedValue(true);

      storeModule.useRegulationRules.getState().setDraft("meta-ads", "復元前");
      await vi.advanceTimersByTimeAsync(500);
      expect(save).not.toHaveBeenCalled();

      await storeModule.useRegulationRules.getState().hydrate();
      storeModule.useRegulationRules.getState().setDraft("google-ads", "1回目");
      storeModule.useRegulationRules.getState().setDraft("line-ads", "2回目");
      await vi.advanceTimersByTimeAsync(299);
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0]).toMatchObject({
        version: 1,
        draft: { ruleSetId: "line-ads", customRule: "2回目" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("同名保存を上書きし、適用・削除・ファイル往復ができる", async () => {
    vi.useFakeTimers();
    try {
      let disk: RegulationRulesFile | undefined;
      let storeModule = await import("../src/lib/store/regulationRules");
      vi.spyOn(storeModule.regulationRulesGuard, "load").mockImplementation(async () =>
        disk ? { status: "ok", value: disk } : { status: "absent" },
      );
      vi.spyOn(storeModule.regulationRulesGuard, "save").mockImplementation(async (value) => {
        disk = structuredClone(value);
        return true;
      });

      await storeModule.useRegulationRules.getState().hydrate();
      storeModule.useRegulationRules.getState().setDraft("meta-ads", "初版");
      const first = await storeModule.useRegulationRules.getState().saveRule("案件A");
      expect(first).not.toBeNull();

      storeModule.useRegulationRules.getState().setDraft("google-ads", "改訂版");
      const overwritten = await storeModule.useRegulationRules.getState().saveRule(" 案件A ");
      expect(overwritten?.id).toBe(first?.id);
      expect(storeModule.useRegulationRules.getState().savedRules).toHaveLength(1);
      expect(overwritten).toMatchObject({
        name: "案件A",
        ruleSetId: "google-ads",
        customRule: "改訂版",
      });

      storeModule.useRegulationRules.getState().setDraft("line-ads", "別の編集中ルール");
      const applied = storeModule.useRegulationRules.getState().applyRule(first!.id);
      expect(applied?.id).toBe(first?.id);
      expect(storeModule.useRegulationRules.getState().draft).toEqual({
        ruleSetId: "google-ads",
        customRule: "改訂版",
      });
      await vi.advanceTimersByTimeAsync(300);

      vi.restoreAllMocks();
      vi.resetModules();
      storeModule = await import("../src/lib/store/regulationRules");
      vi.spyOn(storeModule.regulationRulesGuard, "load").mockResolvedValue({
        status: "ok",
        value: disk!,
      });
      vi.spyOn(storeModule.regulationRulesGuard, "save").mockImplementation(async (value) => {
        disk = structuredClone(value);
        return true;
      });

      await storeModule.useRegulationRules.getState().hydrate();
      expect(storeModule.useRegulationRules.getState().savedRules).toEqual([overwritten]);
      expect(storeModule.useRegulationRules.getState().draft).toEqual({
        ruleSetId: "google-ads",
        customRule: "改訂版",
      });

      expect(
        await storeModule.useRegulationRules.getState().deleteRule(overwritten!.id),
      ).toBe(true);
      expect(storeModule.useRegulationRules.getState().savedRules).toEqual([]);
      expect(disk?.savedRules).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
