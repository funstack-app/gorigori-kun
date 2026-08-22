import { beforeEach, describe, expect, it } from "vitest";

import { useCharacterSheetRun } from "../src/lib/store/characterSheetRun";
import { useComicRun } from "../src/lib/store/comicRun";
import { useRegulationCheckRun } from "../src/lib/store/regulationCheckRun";
import { useScene3dRun } from "../src/lib/store/scene3dRun";
import { useSceneRecreateRun } from "../src/lib/store/sceneRecreateRun";
import {
  endStickerGeneration,
  tryBeginStickerGeneration,
  useStickerRun,
} from "../src/lib/store/stickerRun";

describe("スキル走行状態のタブ切替保持", () => {
  beforeEach(() => {
    useStickerRun.setState({
      phase: "setup",
      cuts: [],
      running: false,
      generationStartedAt: 0,
      notClearedPaths: new Set(),
    });
    useComicRun.setState({
      phase: "input",
      storyPages: [],
      pageResults: [],
      generatingStory: false,
      storyStartedAt: undefined,
      storyProgress: undefined,
      generatingPages: false,
      storyTemplateId: null,
      editingPage: null,
      recoveringPage: null,
      panelReeditSubmitting: false,
      panelReeditStartedAt: undefined,
      panelReeditRunError: null,
    });
    useScene3dRun.setState({
      sceneImagePath: null,
      motionLibraryOpen: false,
      captureBusy: null,
      captureError: null,
      captureStartedAt: null,
      motionGenerating: false,
      motionGenerationError: null,
      motionGenerationStartedAt: null,
      directorBusy: false,
      directorError: null,
      directorNote: null,
      directorProgress: null,
      directorStartedAt: null,
    });
    useSceneRecreateRun.setState({
      keyframes: [],
      status: "idle",
      describeDone: 0,
      analysis: null,
      startedAt: null,
      extractMsg: null,
      runToken: 0,
    });
    useRegulationCheckRun.setState({
      imagePaths: [],
      running: false,
      resultState: null,
      runToken: 0,
    });
    useCharacterSheetRun.setState({
      attributeExtracting: false,
      characterSubmitting: false,
    });
  });

  it("スタンプは画面インスタンスなしでも波とカット状態を保持する", () => {
    expect(tryBeginStickerGeneration()).toBe(true);
    expect(tryBeginStickerGeneration()).toBe(false);
    useStickerRun.getState().setPhase("generate");
    useStickerRun.getState().setCuts([
      {
        index: 1,
        entry: { id: "sticker-1", label: "ありがとう", role: "thanks", promptFragment: "" },
        status: "running",
      },
    ]);

    expect(useStickerRun.getState().running).toBe(true);
    expect(useStickerRun.getState().cuts[0].status).toBe("running");
    endStickerGeneration();
    expect(useStickerRun.getState().running).toBe(false);
  });

  it("漫画は構成生成とページ結果を同じストアで保持する", () => {
    const run = useComicRun.getState();
    run.setGeneratingStory(true);
    run.setStoryStartedAt(1234);
    run.setPhase("pages");
    run.setPageResults([{ page: 1, generating: true, startedAt: 1234 }]);
    run.setEditingPage(1);
    run.setPanelReeditSubmitting(true);
    run.setPanelReeditStartedAt(1234);
    expect(run.tryBeginPageRecovery(1)).toBe(true);
    expect(run.tryBeginPageRecovery(2)).toBe(false);

    const restored = useComicRun.getState();
    expect(restored.generatingStory).toBe(true);
    expect(restored.phase).toBe("pages");
    expect(restored.pageResults[0]).toMatchObject({ page: 1, generating: true });
    expect(restored.editingPage).toBe(1);
    expect(restored.panelReeditSubmitting).toBe(true);
    expect(restored.recoveringPage).toBe(1);
    restored.endPageRecovery(1);
    expect(useComicRun.getState().recoveringPage).toBeNull();
  });

  it("3Dシーンはモーションと監督生成の進捗を保持する", () => {
    const run = useScene3dRun.getState();
    run.setSceneImagePath("/tmp/scene.png");
    run.setMotionLibraryOpen(true);
    run.setMotionGenerating(true);
    run.setMotionGenerationStartedAt(2000);
    run.setDirectorBusy(true);
    run.setDirectorProgress("カメラを配置中…");

    expect(useScene3dRun.getState()).toMatchObject({
      sceneImagePath: "/tmp/scene.png",
      motionLibraryOpen: true,
      motionGenerating: true,
      motionGenerationStartedAt: 2000,
      directorBusy: true,
      directorProgress: "カメラを配置中…",
    });
  });

  it("シーン再現は古いrunだけを無視し、現行の進捗を保持する", () => {
    const first = useSceneRecreateRun.getState().beginRun();
    const second = useSceneRecreateRun.getState().beginRun();
    useSceneRecreateRun.getState().setStatus("describing");
    useSceneRecreateRun.getState().setDescribeDone(2);

    expect(useSceneRecreateRun.getState().isCurrentRun(first)).toBe(false);
    expect(useSceneRecreateRun.getState().isCurrentRun(second)).toBe(true);
    expect(useSceneRecreateRun.getState()).toMatchObject({
      status: "describing",
      describeDone: 2,
    });
  });

  it("規格チェックは途中結果を保持し、明示クリアだけがrunを失効させる", () => {
    const token = useRegulationCheckRun.getState().beginRun();
    useRegulationCheckRun.getState().setRunning(true);
    useRegulationCheckRun.getState().setImagePaths(["/tmp/a.png"]);

    expect(useRegulationCheckRun.getState().isCurrentRun(token)).toBe(true);
    expect(useRegulationCheckRun.getState().running).toBe(true);
    useRegulationCheckRun.getState().invalidateRun();
    expect(useRegulationCheckRun.getState().isCurrentRun(token)).toBe(false);
    expect(useRegulationCheckRun.getState().running).toBe(false);
  });

  it("キャラ登録は抽出・起動要求中の連打ガードを保持する", () => {
    const run = useCharacterSheetRun.getState();
    run.setAttributeExtracting(true);
    run.setCharacterSubmitting(true);

    expect(useCharacterSheetRun.getState()).toMatchObject({
      attributeExtracting: true,
      characterSubmitting: true,
    });
  });
});
