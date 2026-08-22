import { describe, expect, it } from "vitest";

import {
  adoptAssetCandidate,
  beginAssetGeneration,
  beginStressTest,
  canStartStressTest,
  chooseExtraStressRound,
  completeAssetGeneration,
  completeStressTestGeneration,
  evaluateStressTest,
  getAssetFactoryGateState,
  rejectAssetCandidates,
  saveAssetPromptDraft,
  setStressTestVerdict,
} from "../src/lib/film/assetFactory";
import type { AssetLedgerEntry } from "../src/lib/film/types";

function asset(overrides: Partial<AssetLedgerEntry> = {}): AssetLedgerEntry {
  return {
    id: "CH-01",
    name: "美咲",
    type: "character",
    importance: "primary",
    blockIds: ["B1"],
    status: "unplanned",
    pairKey: null,
    pairSide: null,
    ...overrides,
  };
}

describe("④アセット工場の状態遷移", () => {
  it("未起草→起草済→生成中→検品済→人物5/5→ロックへ進む", () => {
    const planned = saveAssetPromptDraft(asset(), "IDENTITY SHEET 全文");
    expect(planned.status).toBe("planned");

    const generating = beginAssetGeneration(planned);
    expect(generating.status).toBe("generating");

    const candidates = completeAssetGeneration(generating, ["a.png", "b.png", "c.png"]);
    const reviewed = adoptAssetCandidate(candidates, "b.png");
    expect(reviewed).toMatchObject({
      status: "reviewed",
      canonicalImagePath: "b.png",
      locked: false,
    });

    const stressGenerating = beginStressTest(reviewed);
    const stressReview = completeStressTestGeneration(
      stressGenerating,
      ["s1.png", "s2.png", "s3.png", "s4.png", "s5.png"],
    );
    const judged = [0, 1, 2, 3, 4].reduce(
      (current, index) => setStressTestVerdict(current, index, "pass"),
      stressReview,
    );
    const passed = evaluateStressTest(judged);
    expect(passed.stressTest?.primaryRound.status).toBe("passed");
    expect(passed.locked).toBe(false);

    const locked = chooseExtraStressRound(passed, "skip");
    expect(locked).toMatchObject({ status: "locked", locked: true });
  });

  it("人物以外は採用した時点でロックする", () => {
    const location = asset({ id: "LO-01", type: "location" });
    const planned = saveAssetPromptDraft(location, "2×2シーンシート全文");
    const generated = completeAssetGeneration(
      beginAssetGeneration(planned),
      ["l1.png", "l2.png", "l3.png"],
    );
    expect(adoptAssetCandidate(generated, "l1.png")).toMatchObject({
      status: "locked",
      canonicalImagePath: "l1.png",
      locked: true,
    });
  });

  it("全部NGは理由を残し、同じプロンプトのまま再生成させない", () => {
    const planned = saveAssetPromptDraft(asset(), "最初のディスクリプタ");
    const generated = completeAssetGeneration(
      beginAssetGeneration(planned),
      ["a.png", "b.png", "c.png"],
    );
    const rejected = rejectAssetCandidates(generated, "横顔で別人になった");
    expect(rejected.ngNotes).toEqual(["横顔で別人になった"]);
    expect(() => beginAssetGeneration(rejected)).toThrow(/直してから/u);
    expect(beginAssetGeneration(saveAssetPromptDraft(rejected, "横顔の鼻筋を具体化"))).toMatchObject({
      status: "generating",
    });
  });
});

describe("④完了ゲート", () => {
  it("主要だけをロック必須とし、準・背景は未ロックでも警告つきで進める", () => {
    const primary = asset({
      status: "locked",
      promptDraft: "主要の全文",
      canonicalImagePath: "primary.png",
      locked: true,
    });
    const supporting = asset({
      id: "PR-01",
      name: "封筒",
      type: "prop",
      importance: "supporting",
      status: "planned",
      promptDraft: "準アセットの全文",
      locked: false,
    });

    expect(getAssetFactoryGateState([primary, supporting])).toEqual({
      canProceed: true,
      undraftedAssetIds: [],
      unlockedPrimaryAssetIds: [],
      unlockedOptionalAssetIds: ["PR-01"],
    });
  });

  it("主要の未ロック、または全点起草前は進めない", () => {
    expect(getAssetFactoryGateState([
      asset({ status: "reviewed", promptDraft: "全文", locked: false }),
    ]).canProceed).toBe(false);
    expect(getAssetFactoryGateState([
      asset({ status: "locked", promptDraft: "", locked: true }),
    ]).canProceed).toBe(false);
  });
});

describe("人物ストレステスト5/5判定", () => {
  it("1枚でもNGなら言葉の修正が済むまで再実行できない", () => {
    const generated = completeAssetGeneration(
      beginAssetGeneration(saveAssetPromptDraft(asset(), "元のディスクリプタ")),
      ["a.png", "b.png", "c.png"],
    );
    const reviewed = adoptAssetCandidate(generated, "a.png");
    const stress = completeStressTestGeneration(
      beginStressTest(reviewed),
      ["s1.png", "s2.png", "s3.png", "s4.png", "s5.png"],
    );
    const judged = ["pass", "pass", "fail", "pass", "pass"].reduce(
      (current, verdict, index) =>
        setStressTestVerdict(current, index, verdict as "pass" | "fail"),
      stress,
    );
    const failed = evaluateStressTest(judged);
    expect(failed.stressTest).toMatchObject({
      needsPromptRevision: true,
      primaryRound: { status: "failed" },
    });
    expect(canStartStressTest(failed)).toBe(false);

    const revised = saveAssetPromptDraft(failed, "鼻筋と横顔の輪郭を具体化したディスクリプタ");
    expect(revised.canonicalImagePath).toBe("a.png");
    expect(revised.stressTest?.primaryRound.status).toBe("idle");
    expect(canStartStressTest(revised)).toBe(true);
  });
});
