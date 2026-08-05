/**
 * A-7 件数充足ガードのロックテスト (mm2 2026-08-03)。
 *
 * 守っている挙動 (storyboardRun.ts の settleAndFlushQueue):
 *   status が 'failed' になっただけでは待機キューを発射しない。全カットが
 *   非 running である**うえに**、決着したカット数が totalCuts に達している
 *   ことを要求する。
 *
 * なぜ要るか: CutStarted が全カット分届く前の CutFailed で早発射すると、
 * 発射先の beginRun が activeRunId を差し替え、旧 run の後続イベントが
 * applyEvent の別 run ガードで**全破棄**される (issue-3 の再導入)。
 *
 * 脱出口 (totalCuts <= 0) も同時に固定する。orchestrator が Started 前に
 * 死んだ run を perma-queue にしないための意図的な非対称で、これを消すと
 * 待機カットが永久に発射されなくなる。
 *
 * コード変更はしない。**現在の挙動を固定する**のがこのファイルの役目。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { installStoryboardIpcMock, type StoryboardIpcMock } from "./helpers/storyboardIpcMock";

type StoryboardRunModule = typeof import("../src/lib/store/storyboardRun");

async function loadStore(): Promise<StoryboardRunModule> {
  return (await import("../src/lib/store/storyboardRun")) as StoryboardRunModule;
}

/**
 * 本生成 run のパラメータ最小形 (store は sketchMode / productionScope しか見ない)。
 *
 * **productionScope を必ず渡す**。scope 無しの走行中本生成 run は
 * 「全カット一括が走行中」= 全カット除外 (startProductionForCuts の
 * inFlightScope === null) となり、あとから積もうとしたカットは
 * 「既に本番へ送信済み」として弾かれ、そもそもキューに入らない。
 * キューへ積める状況を作るには、積むカットが走行中 run の scope 外である必要がある。
 */
function productionParams(runId: string, scope: string[]) {
  return {
    runId,
    sketchMode: false,
    productionScope: scope,
  } as unknown as Parameters<
    ReturnType<StoryboardRunModule["useStoryboardRun"]["getState"]>["beginRun"]
  >[1];
}

let ipc: StoryboardIpcMock;

beforeEach(() => {
  localStorage.clear();
});

describe("storyboardRun: 失敗決着の件数充足ガード (A-7 / mm2)", () => {
  it("T-mm2-1: totalCuts=3 で 1 件だけ failed なら発射しない (件数不足)", async () => {
    ipc = installStoryboardIpcMock();
    const { useStoryboardRun } = await loadStore();
    const run = () => useStoryboardRun.getState();

    run().beginRun("run-1", productionParams("run-1", ["cut-a", "cut-b", "cut-c"]));
    run().applyEvent({
      kind: "started",
      runId: "run-1",
      totalCuts: 3,
      sceneGroups: [],
    });
    // 待機キューを積む (走行中なので即発射されず pendingProductionCuts に入る)。
    await run().startProductionForCuts(["queued-cut"]);
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]);

    const runCallsBefore = ipc.calls("storyboard_run").length;

    // CutStarted が 3 件届く前に 1 件だけ CutFailed。status は failed になるが、
    // 決着したのは 1/3 件しかない。
    run().applyEvent({
      kind: "cutFailed",
      runId: "run-1",
      cutId: "cut-a",
      reason: "boom",
    });

    expect(run().status).toBe("failed");
    // ガードが効いていればキューは残ったまま、storyboard_run も呼ばれない。
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]);
    expect(ipc.calls("storyboard_run")).toHaveLength(runCallsBefore);
    // 早発射していれば beginRun が activeRunId を差し替えている。
    // 据え置きであること = 旧 run のイベントが破棄されない状態が保たれている。
    expect(run().activeRunId).toBe("run-1");
  });

  it("T-mm2-2: totalCuts=3 で 3 件すべて決着したら発射する", async () => {
    ipc = installStoryboardIpcMock();
    const { useStoryboardRun } = await loadStore();
    const run = () => useStoryboardRun.getState();

    run().beginRun("run-2", productionParams("run-2", ["cut-a", "cut-b", "cut-c"]));
    run().applyEvent({
      kind: "started",
      runId: "run-2",
      totalCuts: 3,
      sceneGroups: [],
    });
    await run().startProductionForCuts(["queued-cut"]);
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]);

    // 3 件すべてを決着させる (最後の 1 件で件数が充足する)。
    run().applyEvent({
      kind: "cutFailed",
      runId: "run-2",
      cutId: "cut-a",
      reason: "boom",
    });
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]); // 1/3 ではまだ

    run().applyEvent({
      kind: "cutFailed",
      runId: "run-2",
      cutId: "cut-b",
      reason: "boom",
    });
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]); // 2/3 でもまだ

    run().applyEvent({
      kind: "cutFailed",
      runId: "run-2",
      cutId: "cut-c",
      reason: "boom",
    });

    // 3/3 で充足 → 発射。キューが空化される。
    expect(run().pendingProductionCuts).toEqual([]);
    // 発射は startProductionForCuts 経由なので storyboard_run まで届く。
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.calls("storyboard_run").length).toBeGreaterThan(0);
  });

  it("T-mm2-3: totalCuts=0 (Started 前死亡) は脱出口として発射する", async () => {
    ipc = installStoryboardIpcMock();
    const { useStoryboardRun } = await loadStore();
    const run = () => useStoryboardRun.getState();

    // started イベントが来ないまま run が始まる = totalCuts は 0 のまま。
    run().beginRun("run-3", productionParams("run-3", ["cut-a"]));
    expect(run().totalCuts).toBe(0);
    await run().startProductionForCuts(["queued-cut"]);
    expect(run().pendingProductionCuts).toEqual(["queued-cut"]);

    // orchestrator が Started 前に死ぬと CutFailed "unknown" だけが届く。
    run().applyEvent({
      kind: "cutFailed",
      runId: "run-3",
      cutId: "unknown",
      reason: "orchestrator died",
    });

    // totalCuts <= 0 の脱出口が効き、perma-queue にならない。
    //
    // status は見ない: 発射は startProductionForCuts → beginRun へ進むため、
    // この時点の activeRunId / status は**発射先の新 run のもの**に入れ替わっている
    // (cutFailed が立てた 'failed' は既に上書き済み)。観測すべきは「発射されたか」で、
    // それはキューの空化と storyboard_run の呼び出しに現れる。
    expect(run().pendingProductionCuts).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.calls("storyboard_run").length).toBeGreaterThan(0);
    // 発射先は待機カットを scope に持つ新しい run (旧 run-3 ではない)。
    expect(run().activeRunId).not.toBe("run-3");
  });
});
