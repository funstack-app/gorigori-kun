/**
 * D1 (2026-08-05): 確定カットの個別除外。
 *
 * 事故: Phase 4 で 6 枚並んだうち 1 枚だけ構図が破綻していても、カード上に
 * 削除も除外も無く、押せない「やり直し（未対応）」が置いてあるだけだった。
 * 1 枚捨てるには Phase 1 の ↺ リセットで**全部捨てる**しかなかった。
 *
 * ここで固定するのは 4 つ:
 *
 *   1. excludeCut / includeCut が 1 枚だけを出し入れし、他カットに波及しない
 *   2. **cuts Map からは消さない**。terminalStatusFor は `map.size !== totalCuts`
 *      で終端を判定し、settleAndFlushQueue は決着件数と totalCuts の一致を
 *      要求する (A-7 件数充足ガード)。実削除すると走行中 run の終端検知が
 *      恒久的に不成立になり、pendingProductionCuts が永久待機になる。
 *      「除外は成果物の話であって run の話ではない」を構造で守る。
 *   3. 除外しても**元のカット番号がずれない**。Cut 2 を除外しても Cut 3 は
 *      Cut 3 のまま (絵コンテ・動画キュー側の呼び名と食い違わせない)。
 *      CutGridReviewPanel が orderedCuts の index で採番しているのと同じ式を
 *      ここで評価し、実装のズレに気づけるようにする。
 *   4. reset() で除外が消える (前ストーリーの除外を次へ持ち越さない)
 */
import { beforeEach, describe, expect, it } from "vitest";

import { installStoryboardIpcMock } from "./helpers/storyboardIpcMock";

type StoryboardRunModule = typeof import("../src/lib/store/storyboardRun");

async function loadStore(): Promise<StoryboardRunModule> {
  return (await import("../src/lib/store/storyboardRun")) as StoryboardRunModule;
}

/** 本生成 run の最小パラメータ (store は sketchMode / productionScope しか見ない)。 */
function productionParams(runId: string, scope: string[]) {
  return {
    runId,
    sketchMode: false,
    productionScope: scope,
  } as unknown as Parameters<
    ReturnType<StoryboardRunModule["useStoryboardRun"]["getState"]>["beginRun"]
  >[1];
}

const ZERO_SCORES = {
  identity: 0,
  outfit: 0,
  prop: 0,
  face: 0,
  hand: 0,
  background: 0,
};

/**
 * CutGridReviewPanel の「除外を除いた成果物」と同じ式。
 * パネルは orderedCuts (= cuts の全件) を index 付きで回し、除外集合を
 * skip しながら**元 index で採番**する。実装を変えたらここも落ちる。
 */
function keptWithOriginalNumbers(
  cuts: Map<string, { cutId: string }>,
  excludedCutIds: string[],
): Array<{ cutId: string; label: string }> {
  const excluded = new Set(excludedCutIds);
  const out: Array<{ cutId: string; label: string }> = [];
  Array.from(cuts.values()).forEach((c, i) => {
    if (excluded.has(c.cutId)) return;
    out.push({ cutId: c.cutId, label: `Cut ${i + 1}` });
  });
  return out;
}

/** 3 カットが確定済みで並んでいる Phase 4 相当の状態を作る。 */
async function seedThreeConfirmedCuts() {
  installStoryboardIpcMock();
  const { useStoryboardRun } = await loadStore();
  const run = () => useStoryboardRun.getState();
  const ids = ["cut-a", "cut-b", "cut-c"];

  run().beginRun("run-1", productionParams("run-1", ids));
  run().applyEvent({ kind: "started", runId: "run-1", totalCuts: 3, sceneGroups: [] });
  for (const cutId of ids) {
    run().applyEvent({
      kind: "cutStarted",
      runId: "run-1",
      cutId,
      sceneGroupId: "g1",
      takeCount: 1,
    });
    run().applyEvent({
      kind: "takeCompleted",
      runId: "run-1",
      cutId,
      takeId: `${cutId}-t1`,
      imagePath: `/tmp/${cutId}.png`,
      scores: ZERO_SCORES,
    });
    run().adoptTake(cutId);
  }

  return { useStoryboardRun, run, ids };
}

beforeEach(() => {
  localStorage.clear();
});

describe("storyboardRun: 確定カットの個別除外 (D1)", () => {
  it("T-D1-0: 前提 — 3 カットが確定済みで並んでいる", async () => {
    const { run } = await seedThreeConfirmedCuts();
    expect(run().cuts.size).toBe(3);
    expect(run().totalCuts).toBe(3);
    for (const cutId of ["cut-a", "cut-b", "cut-c"]) {
      expect(run().cuts.get(cutId)?.status).toBe("confirmed");
    }
  });

  it("T-D1-1: 1 枚だけ除外でき、他のカットは影響を受けない", async () => {
    const { run } = await seedThreeConfirmedCuts();

    expect(run().excludedCutIds).toEqual([]);

    run().excludeCut("cut-b");

    expect(run().excludedCutIds).toEqual(["cut-b"]);
    // 他の 2 枚は採用済みのまま、take も選択も無傷。
    for (const cutId of ["cut-a", "cut-c"]) {
      const cut = run().cuts.get(cutId);
      expect(cut?.status).toBe("confirmed");
      expect(cut?.takes).toHaveLength(1);
      expect(cut?.selectedTakeId).toBe(`${cutId}-t1`);
    }
    // 成果物からは 2 枚だけが残る。
    expect(keptWithOriginalNumbers(run().cuts, run().excludedCutIds).map((k) => k.cutId)).toEqual([
      "cut-a",
      "cut-c",
    ]);
  });

  it("T-D1-2: 除外しても cuts Map から消えない (終端検知・待機キューを壊さない)", async () => {
    const { run } = await seedThreeConfirmedCuts();

    run().excludeCut("cut-b");

    // Map の件数が totalCuts と一致し続けることが A-7 件数充足ガードの前提。
    expect(run().cuts.size).toBe(3);
    expect(run().totalCuts).toBe(3);
    // 除外カット自身の生成結果 (画像) も消さない = 取り消せる。
    const excludedCut = run().cuts.get("cut-b");
    expect(excludedCut).toBeDefined();
    expect(excludedCut?.status).toBe("confirmed");
    expect(excludedCut?.takes[0]?.imagePath).toBe("/tmp/cut-b.png");
  });

  it("T-D1-3: 戻す (includeCut) と成果物に復帰する", async () => {
    const { run } = await seedThreeConfirmedCuts();

    run().excludeCut("cut-b");
    run().includeCut("cut-b");

    expect(run().excludedCutIds).toEqual([]);
    expect(keptWithOriginalNumbers(run().cuts, run().excludedCutIds)).toHaveLength(3);
  });

  it("T-D1-4: 同じカットを二重に除外しても増殖しない", async () => {
    const { run } = await seedThreeConfirmedCuts();

    run().excludeCut("cut-b");
    run().excludeCut("cut-b");

    expect(run().excludedCutIds).toEqual(["cut-b"]);
  });

  it("T-D1-5: 除外しても残ったカットの番号がずれない", async () => {
    const { run } = await seedThreeConfirmedCuts();

    run().excludeCut("cut-b"); // 真ん中を抜く

    const kept = keptWithOriginalNumbers(run().cuts, run().excludedCutIds);
    // cut-c は「Cut 2」に繰り上がらず「Cut 3」のまま。
    expect(kept).toEqual([
      { cutId: "cut-a", label: "Cut 1" },
      { cutId: "cut-c", label: "Cut 3" },
    ]);
  });

  it("T-D1-6: reset() で除外はクリアされる (前ストーリーの除外を持ち越さない)", async () => {
    const { run } = await seedThreeConfirmedCuts();

    run().excludeCut("cut-b");
    run().reset();

    expect(run().excludedCutIds).toEqual([]);
  });
});
