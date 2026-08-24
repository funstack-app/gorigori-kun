import { beforeEach, describe, expect, it } from "vitest";

import {
  createPendingRegulationRecheck,
  replaceImageForRecheck,
  selectFrozenRecheckRules,
  type RecheckResultStatus,
} from "../src/lib/regulation/recheck";
import { useRegulationCheckRun } from "../src/lib/store/regulationCheckRun";

beforeEach(() => {
  useRegulationCheckRun.setState({
    imagePaths: [],
    pendingRechecks: [],
    resultState: null,
    running: false,
  });
});

describe("規格チェックの修正版差し替え", () => {
  it("元画像だけを修正版へ差し替え、並び順と元配列を変えない", () => {
    const imagePaths = ["/input/a.png", "/input/b.png", "/input/c.png"];

    const replaced = replaceImageForRecheck(
      imagePaths,
      "/input/b.png",
      "/revised/b-v2.png",
    );

    expect(replaced).toEqual([
      "/input/a.png",
      "/revised/b-v2.png",
      "/input/c.png",
    ]);
    expect(imagePaths).toEqual(["/input/a.png", "/input/b.png", "/input/c.png"]);
  });

  it("該当する元画像がなければ内容を変えない", () => {
    expect(
      replaceImageForRecheck(["/input/a.png"], "/input/missing.png", "/revised/x.png"),
    ).toEqual(["/input/a.png"]);
  });
});

describe("再検品待ちの消込", () => {
  it("同じ画像の待ち情報は最新ルールへ更新され、完了後に画像単位で消せる", () => {
    const run = useRegulationCheckRun.getState();
    run.queuePendingRecheck({
      imagePath: "/input/a.png",
      ruleSetId: "meta-ads",
      customRule: "初版",
      sentAt: 1,
    });
    run.queuePendingRecheck({
      imagePath: "/input/a.png",
      ruleSetId: "google-ads",
      customRule: "改訂版",
      sentAt: 2,
    });
    run.queuePendingRecheck({
      imagePath: "/input/b.png",
      ruleSetId: "line-ads",
      customRule: "別画像",
      sentAt: 3,
    });

    expect(useRegulationCheckRun.getState().pendingRechecks).toEqual([
      {
        imagePath: "/input/a.png",
        ruleSetId: "google-ads",
        customRule: "改訂版",
        sentAt: 2,
      },
      {
        imagePath: "/input/b.png",
        ruleSetId: "line-ads",
        customRule: "別画像",
        sentAt: 3,
      },
    ]);

    useRegulationCheckRun.getState().removePendingRecheck("/input/a.png");

    expect(useRegulationCheckRun.getState().pendingRechecks).toEqual([
      {
        imagePath: "/input/b.png",
        ruleSetId: "line-ads",
        customRule: "別画像",
        sentAt: 3,
      },
    ]);
  });

  it("結果後に画面ルールを変えても、検査時に凍結したルールで再検品する", () => {
    const run = useRegulationCheckRun.getState();
    run.setResultState({
      ruleSetId: "meta-ads",
      customRule: "検査時のルール",
      ruleSet: { id: "meta-ads", name: "Meta広告", rules: [] },
      results: [],
    });
    const changedScreenRules = {
      ruleSetId: "google-ads",
      customRule: "結果後に変更したルール",
    };
    run.setRuleSetId(changedScreenRules.ruleSetId);

    // 画面変更後に送っても、pending は resultState の検査時ルールから作る。
    const pending = createPendingRegulationRecheck(
      "/input/a.png",
      useRegulationCheckRun.getState().resultState!,
      10,
    );
    useRegulationCheckRun.getState().queuePendingRecheck(pending);
    const queued = useRegulationCheckRun.getState().pendingRechecks[0];

    expect(selectFrozenRecheckRules(queued)).toEqual({
      ruleSetId: "meta-ads",
      customRule: "検査時のルール",
    });
    expect(selectFrozenRecheckRules(queued)).not.toEqual(changedScreenRules);
  });

  it("再検品結果が error のとき pending を残し、成功時だけ消す", () => {
    const run = useRegulationCheckRun.getState();
    run.queuePendingRecheck({
      imagePath: "/revised/a.png",
      ruleSetId: "meta-ads",
      customRule: "凍結ルール",
      sentAt: 20,
    });
    const failedResult: RecheckResultStatus = {
      imagePath: "/revised/a.png",
      error: "AI判定に失敗",
      aiPending: false,
    };

    useRegulationCheckRun
      .getState()
      .completePendingRecheck("/revised/a.png", failedResult);
    expect(useRegulationCheckRun.getState().pendingRechecks).toHaveLength(1);

    useRegulationCheckRun.getState().completePendingRecheck("/revised/a.png", {
      imagePath: "/revised/a.png",
      error: null,
      aiPending: false,
    });
    expect(useRegulationCheckRun.getState().pendingRechecks).toEqual([]);
  });

  it("画像の単体削除とすべて外すで、該当 pending も消す", () => {
    const run = useRegulationCheckRun.getState();
    run.setImagePaths(["/input/a.png", "/input/b.png"]);
    run.queuePendingRecheck({
      imagePath: "/input/a.png",
      ruleSetId: "meta-ads",
      customRule: "A",
      sentAt: 30,
    });
    run.queuePendingRecheck({
      imagePath: "/input/b.png",
      ruleSetId: "google-ads",
      customRule: "B",
      sentAt: 31,
    });

    useRegulationCheckRun.getState().removeImage("/input/a.png");
    expect(useRegulationCheckRun.getState().imagePaths).toEqual(["/input/b.png"]);
    expect(useRegulationCheckRun.getState().pendingRechecks).toEqual([
      expect.objectContaining({ imagePath: "/input/b.png" }),
    ]);

    useRegulationCheckRun.getState().clearImages();
    expect(useRegulationCheckRun.getState().imagePaths).toEqual([]);
    expect(useRegulationCheckRun.getState().pendingRechecks).toEqual([]);
  });
});
