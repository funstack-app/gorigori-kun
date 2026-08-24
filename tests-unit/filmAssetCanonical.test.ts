import { describe, expect, it } from "vitest";

import { buildCanonicalImageAdoption } from "../src/components/skills/film/AssetFactoryPanel";
import { createDefaultStressTest } from "../src/lib/film/assetFactory";
import type { FilmAsset, FilmProject } from "../src/lib/film/types";
import { useFilmProjectStore } from "../src/lib/store/filmProject";

function makeAsset(type: FilmAsset["type"]): FilmAsset {
  return {
    id: type === "character" ? "CH-01" : "PR-01",
    name: type === "character" ? "主人公" : "鍵",
    type,
    importance: "primary",
    blockIds: ["B-01"],
    status: "planned",
    pairKey: null,
    pairSide: null,
    promptDraft: "採用テスト",
    generatedImagePaths: [],
    lastGeneratedPrompt: null,
    canonicalImagePath: null,
    ngNotes: [],
    stressTest: type === "character" ? createDefaultStressTest() : null,
    locked: false,
  };
}

describe("④アセット工場の既存画像正典化", () => {
  it("既存の人物画像を正典にし、人物チェックへ進む状態にする", () => {
    const adopted = buildCanonicalImageAdoption(makeAsset("character"), "/images/hero.webp");

    expect(adopted.canonicalImagePath).toBe("/images/hero.webp");
    expect(adopted.status).toBe("reviewed");
    expect(adopted.locked).toBe(false);
    expect(adopted.stressTest?.primaryRound.status).toBe("idle");
    expect(adopted.generatedImagePaths).toEqual([]);
  });

  it("人物以外の既存画像は採用と同時に確定する", () => {
    const adopted = buildCanonicalImageAdoption(makeAsset("prop"), "/images/key.png");

    expect(adopted.canonicalImagePath).toBe("/images/key.png");
    expect(adopted.status).toBe("locked");
    expect(adopted.locked).toBe(true);
    expect(adopted.generatedImagePaths).toEqual([]);
  });

  it("正典採用後も approvals.look が不変", () => {
    const asset = makeAsset("character");
    const lookApproval = { approvedAt: "2026-08-24T00:00:00.000Z" };
    const project: FilmProject = {
      id: "film-canonical-store-test",
      title: "正典採用テスト",
      theme: "承認を守る",
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
        look: lookApproval,
      },
      script: [],
      assets: [asset],
      foreshadow: [],
      stylePrefix: "",
      lookMasterPath: null,
      takes: [],
    };
    const previousProjects = useFilmProjectStore.getState().projects;
    const previousActiveProjectId = useFilmProjectStore.getState().activeProjectId;
    try {
      useFilmProjectStore.setState({
        projects: [project],
        activeProjectId: project.id,
      });

      useFilmProjectStore.getState().updateAssetFactoryAsset(
        asset.id,
        (current) => buildCanonicalImageAdoption(current, "/images/hero.webp"),
      );

      const updated = useFilmProjectStore.getState().projects[0];
      expect(updated.assets[0].canonicalImagePath).toBe("/images/hero.webp");
      expect(updated.approvals.look).toEqual(lookApproval);
    } finally {
      useFilmProjectStore.setState({
        projects: previousProjects,
        activeProjectId: previousActiveProjectId,
      });
    }
  });
});
