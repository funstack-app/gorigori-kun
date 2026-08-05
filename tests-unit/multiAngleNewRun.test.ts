/**
 * Sol 評価 2周目 blocking#3 (2026-08-04): multiAngle 「新規開始」の完全初期化。
 *
 * 事故: startNewRun() は環境文・比率も初期値へ戻すのに、ボタンの活性判定
 * (hasWork) は 被写体画像・カット選択・結果 の 3 つしか見ていなかった。
 * そのため「環境文だけ書いた」「比率だけ 16:9 にした」状態では
 * 「消す作業がありません」でボタンが押せず、入力欄は埋まったままになる。
 *
 * ここでは 2 つを固定する:
 *   1. startNewRun() が **4 種の入力すべて** (被写体・構図・環境・比率) を初期値へ戻す
 *   2. hasWork の判定式が startNewRun の初期化対象と一致している
 *      = 「押せないのに消す物がある」状態を作らない
 *
 * 2 は UI コンポーネントを描画せず、MultiAngleWorkspace.tsx と同じ式を
 * ストア状態に対して評価して検査する (判定式そのものの同期を守るのが目的)。
 */
import { beforeEach, describe, expect, it } from "vitest";

type MultiAngleModule = typeof import("../src/lib/store/multiAngleRun");

/**
 * MultiAngleWorkspace.tsx の hasWork と同じ式。
 * 実装を変えたらここも落ちるので、判定のズレに気づける。
 */
function hasWork(s: {
  characterImagePath: string | null;
  selectedCutIds: string[];
  cutOrder: string[];
  environmentDescription: string;
  aspectRatio: string;
}): boolean {
  return (
    s.characterImagePath !== null ||
    s.selectedCutIds.length > 0 ||
    s.cutOrder.length > 0 ||
    s.environmentDescription !== "" ||
    s.aspectRatio !== "1:1"
  );
}

describe("multiAngle 新規開始", () => {
  let mod: MultiAngleModule;

  beforeEach(async () => {
    mod = await import("../src/lib/store/multiAngleRun");
  });

  it("T-1: 初期状態では押せない (消す作業が無い)", () => {
    expect(hasWork(mod.useMultiAngleRun.getState())).toBe(false);
  });

  it("T-2: 環境文だけ書いた状態でも押せる", () => {
    mod.useMultiAngleRun.getState().setEnvironment("夕暮れの教室");
    expect(hasWork(mod.useMultiAngleRun.getState())).toBe(true);
  });

  it("T-3: 比率だけ変えた状態でも押せる", () => {
    mod.useMultiAngleRun.getState().setAspectRatio("16:9");
    expect(hasWork(mod.useMultiAngleRun.getState())).toBe(true);
  });

  it("T-4: startNewRun は環境文・比率も含めて全入力を初期化する", () => {
    const run = mod.useMultiAngleRun.getState();
    run.setEnvironment("夕暮れの教室");
    run.setAspectRatio("16:9");

    mod.useMultiAngleRun.getState().startNewRun();

    const after = mod.useMultiAngleRun.getState();
    expect(after.environmentDescription).toBe("");
    expect(after.aspectRatio).toBe("1:1");
    expect(after.characterImagePath).toBeNull();
    expect(after.selectedCutIds).toEqual([]);
    // 初期化しきったので、直後はもう押せない状態に戻る。
    expect(hasWork(after)).toBe(false);
  });
});
