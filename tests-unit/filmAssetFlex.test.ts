import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ZoomableImage } from "../src/components/skills/film/AssetFactoryPanel";
import {
  DEFAULT_ASSET_CANDIDATE_COUNT,
  acquireAssetRunRight,
  areAllAssetPromptsDrafted,
  beginAssetGeneration,
  createAssetDraftAbortRegistry,
  inspectGeneratedAssetCandidates,
  releaseAssetRunRight,
  runAssetTaskPool,
  saveAssetPromptDraft,
} from "../src/lib/film/assetFactory";
import type { AssetLedgerEntry, FilmAsset, FilmProject } from "../src/lib/film/types";
import { useFilmProjectStore } from "../src/lib/store/filmProject";

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

function lockedAsset(): FilmAsset {
  return {
    id: "PR-01",
    name: "鍵",
    type: "prop",
    importance: "primary",
    blockIds: ["B1"],
    status: "locked",
    pairKey: null,
    pairSide: null,
    promptDraft: "古びた真鍮の鍵",
    generatedImagePaths: ["candidate-a.png", "candidate-b.png"],
    lastGeneratedPrompt: "古びた真鍮の鍵",
    canonicalImagePath: "candidate-b.png",
    ngNotes: ["最初の案は新しすぎた"],
    stressTest: null,
    locked: true,
  };
}

function projectWith(sourceAsset: FilmAsset): FilmProject {
  return {
    id: "film-asset-flex-test",
    title: "素材柔軟化テスト",
    theme: "状態を保持する",
    mode: "film",
    assetServiceId: "gpt-image-2",
    videoServiceId: "seedance-2.5",
    phase: 4,
    approvals: {
      logline: null,
      beatsheet: null,
      treatment: null,
      scenelist: null,
      blocks: null,
      look: { approvedAt: "2026-08-25T00:00:00.000Z" },
    },
    script: [],
    assets: [sourceAsset],
    foreshadow: [],
    stylePrefix: "soft light",
    lookMasterPath: "look-master.png",
    takes: [],
  };
}

describe("④素材づくりの並列プール", () => {
  it("同時3件で走り、1件失敗しても残りを最後まで処理する", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirstWave = () => {};
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    const started: number[] = [];

    const running = runAssetTaskPool(
      [1, 2, 3, 4, 5],
      async (item) => {
        started.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (item <= 3) await firstWave;
          if (item === 2) throw new Error("2だけ失敗");
          return item * 10;
        } finally {
          active -= 1;
        }
      },
      3,
    );

    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    expect(maxActive).toBe(3);
    releaseFirstWave();

    const results = await running;
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("停止判定後は未着手の仕事を開始しない", async () => {
    let stopped = false;
    const started: number[] = [];

    const results = await runAssetTaskPool(
      [1, 2, 3],
      async (item) => {
        started.push(item);
        stopped = true;
        return item;
      },
      3,
      () => stopped,
    );

    expect(started).toEqual([1]);
    expect(results).toHaveLength(1);
  });
});

describe("④素材づくりの二重実行ガード", () => {
  it("一括中の順番待ち素材は、同一素材の個別下書き実行を拒否する", () => {
    const draftingAssetIds = new Set<string>();

    expect(acquireAssetRunRight(draftingAssetIds, "CH-01")).toBe(true);
    expect(acquireAssetRunRight(draftingAssetIds, "CH-01")).toBe(false);

    releaseAssetRunRight(draftingAssetIds, "CH-01");
    expect(acquireAssetRunRight(draftingAssetIds, "CH-01")).toBe(true);
  });

  it("個別下書きが後から始まっても、一括用コントローラを中止できる", () => {
    const registry = createAssetDraftAbortRegistry();
    const batchController = registry.startBatch();
    const individualController = registry.startIndividual("LO-01");

    expect(batchController).not.toBeNull();
    expect(individualController).not.toBeNull();
    registry.abortBatch();

    expect(batchController?.signal.aborted).toBe(true);
    expect(individualController?.signal.aborted).toBe(false);
  });

  it("同一素材の画像生成は、完了して権利を戻すまで二重開始を拒否する", () => {
    const generatingAssetIds = new Set<string>();

    expect(acquireAssetRunRight(generatingAssetIds, "CH-01")).toBe(true);
    expect(acquireAssetRunRight(generatingAssetIds, "CH-01")).toBe(false);

    releaseAssetRunRight(generatingAssetIds, "CH-01");
    expect(acquireAssetRunRight(generatingAssetIds, "CH-01")).toBe(true);
  });
});

describe("④素材づくりの候補枚数", () => {
  it("既定は1枚で、1〜3枚の希望より少なくても完成分を候補にする", () => {
    expect(DEFAULT_ASSET_CANDIDATE_COUNT).toBe(1);
    expect(inspectGeneratedAssetCandidates(["only.png"], 3)).toEqual({
      paths: ["only.png"],
      missingCount: 2,
      isPartial: true,
    });
    expect(inspectGeneratedAssetCandidates(["a.png", "b.png"], 2)).toEqual({
      paths: ["a.png", "b.png"],
      missingCount: 0,
      isPartial: false,
    });
  });

  it("0枚だけは検品できないため失敗にする", () => {
    expect(() => inspectGeneratedAssetCandidates([], 1)).toThrow(/1枚も完成/u);
  });

  it("別素材が未下書きでも、保存済みの素材は生成開始できる", () => {
    const drafted = saveAssetPromptDraft(asset(), "主人公の人物シート");
    expect(areAllAssetPromptsDrafted([drafted, asset({ id: "LO-01" })])).toBe(false);
    expect(beginAssetGeneration(drafted).status).toBe("generating");
  });
});

describe("④素材づくりの拡大表示", () => {
  it("候補画像はクリックではなくダブルクリックで拡大を開く", () => {
    const onZoom = vi.fn();
    const button = ZoomableImage({
      path: "candidate.png",
      alt: "候補",
      className: "preview",
      onZoom,
    }) as ReactElement<{
      onClick?: () => void;
      onDoubleClick?: () => void;
    }>;

    expect(button.props.onClick).toBeUndefined();
    button.props.onDoubleClick?.();
    expect(onZoom).toHaveBeenCalledWith("candidate.png");
  });
});

describe("④素材づくりの確定解除", () => {
  it("lockedだけを外し、採用画像・候補・下書き・後工程の承認を保持する", () => {
    const sourceAsset = lockedAsset();
    const sourceProject = projectWith(sourceAsset);
    const previousProjects = useFilmProjectStore.getState().projects;
    const previousActiveProjectId = useFilmProjectStore.getState().activeProjectId;
    try {
      useFilmProjectStore.setState({
        projects: [sourceProject],
        activeProjectId: sourceProject.id,
      });

      useFilmProjectStore.getState().unlockAssetCanonical(sourceAsset.id);

      const updated = useFilmProjectStore.getState().projects[0];
      expect(updated.assets[0]).toEqual({ ...sourceAsset, locked: false });
      expect(updated.approvals.look).toEqual(sourceProject.approvals.look);
      expect(updated.lookMasterPath).toBe(sourceProject.lookMasterPath);
    } finally {
      useFilmProjectStore.setState({
        projects: previousProjects,
        activeProjectId: previousActiveProjectId,
      });
    }
  });
});
