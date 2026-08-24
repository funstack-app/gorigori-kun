import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SheetCutState } from "../src/lib/character/types";
import type {
  CharacterSheetRunSnapshot,
} from "../src/lib/store/characterSheetRunPersist";
import type { SheetJob, SheetJobStatus } from "../src/lib/store/characterSheetRun";
import type { KeyValueStore } from "../src/lib/store/persistGuard";

function makeCut(
  cutId: string,
  status: SheetCutState["status"] = "completed",
): SheetCutState {
  return {
    cutId,
    label: cutId,
    role: cutId,
    status,
    ...(status === "completed" ? { imagePath: `/out/${cutId}.png` } : {}),
    ...(status === "failed" ? { reason: "元から失敗" } : {}),
  };
}

function makeJob(
  jobId: string,
  status: SheetJobStatus = "completed",
  cuts: Record<string, SheetCutState> = {
    "character-sheet": makeCut("character-sheet"),
  },
): SheetJob {
  return {
    jobId,
    jobMode: "character",
    activeRunId: `run-${jobId}`,
    input: {
      characterName: "保存キャラ",
      characterImagePaths: ["/img/saved.png"],
      attributes: "保存属性",
      aspectRatio: "3:4",
      sheetPromptMode: "custom",
      customSheetPrompt: "保存プロンプト",
      sheetBackground: "white",
      regenerateTargetPresetId: null,
    },
    cuts,
    cutOrder: Object.keys(cuts),
    cutStartedAt: {},
    status,
    slotPhase: status === "running" ? "active" : "unknown",
    createdAt: 100,
  };
}

function makeSnapshot(
  overrides: Partial<CharacterSheetRunSnapshot> = {},
): CharacterSheetRunSnapshot {
  const job = makeJob("saved-job");
  return {
    version: 1,
    mode: "character",
    step: 3,
    characterName: "保存キャラ",
    characterImagePaths: ["/img/saved.png"],
    attributes: "保存属性",
    aspectRatio: "3:4",
    sheetPromptMode: "custom",
    customSheetPrompt: "保存プロンプト",
    sheetBackground: "white",
    regenerateTargetPresetId: null,
    jobs: { [job.jobId]: job },
    jobOrder: [job.jobId],
    focusedJobId: job.jobId,
    savedAt: 123,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("キャラクターシート作業状態のファイル保存 (N2)", () => {
  it("N2-1: 正常なsnapshotだけを受け入れ、version・jobs・参照画像の破損を拒否する", async () => {
    const { parseCharacterSheetRunSnapshot } = await import(
      "../src/lib/store/characterSheetRunPersist"
    );
    const valid = makeSnapshot();

    expect(parseCharacterSheetRunSnapshot(valid)).toMatchObject({ ok: true });
    expect(parseCharacterSheetRunSnapshot({ ...valid, version: 2 })).toMatchObject({
      ok: false,
    });
    expect(parseCharacterSheetRunSnapshot({ ...valid, jobs: [] })).toMatchObject({
      ok: false,
    });
    expect(
      parseCharacterSheetRunSnapshot({
        ...valid,
        characterImagePaths: ["/img/ok.png", 1],
      }),
    ).toMatchObject({ ok: false });
  });

  it("N2-2: 起動時にrunningジョブと未完了カットだけを中断失敗へ正規化する", async () => {
    const { normalizeSnapshotOnLoad } = await import(
      "../src/lib/store/characterSheetRunPersist"
    );
    const running = makeJob("running-job", "running", {
      pending: makeCut("pending", "pending"),
      running: makeCut("running", "running"),
      completed: makeCut("completed", "completed"),
      failed: makeCut("failed", "failed"),
    });
    const completed = makeJob("completed-job", "completed");
    const snapshot = makeSnapshot({
      jobs: { [running.jobId]: running, [completed.jobId]: completed },
      jobOrder: [running.jobId, completed.jobId],
      focusedJobId: running.jobId,
    });

    const normalized = normalizeSnapshotOnLoad(snapshot);

    expect(normalized.jobs[running.jobId]).toMatchObject({
      status: "failed",
      slotPhase: "unknown",
    });
    expect(normalized.jobs[running.jobId].cuts.pending).toMatchObject({
      status: "failed",
      reason: "アプリ終了により中断されました",
    });
    expect(normalized.jobs[running.jobId].cuts.running).toMatchObject({
      status: "failed",
      reason: "アプリ終了により中断されました",
    });
    expect(normalized.jobs[running.jobId].cuts.completed).toEqual(
      running.cuts.completed,
    );
    expect(normalized.jobs[running.jobId].cuts.failed).toEqual(running.cuts.failed);
    expect(normalized.jobs[completed.jobId]).toEqual(completed);
  });

  it("N2-3: メモリ内KeyValueStoreでsaveからloadまで同じsnapshotを往復する", async () => {
    const { createCharacterSheetRunGuard } = await import(
      "../src/lib/store/characterSheetRunPersist"
    );
    const values = new Map<string, unknown>();
    const store: KeyValueStore = {
      get: async <T,>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => {
        values.set(key, value);
      },
      save: vi.fn(async () => {}),
    };
    const guard = createCharacterSheetRunGuard(async () => store);
    const snapshot = makeSnapshot();

    expect((await guard.load()).status).toBe("absent");
    expect(await guard.save(snapshot)).toBe(true);
    const loaded = await guard.load();

    expect(loaded.status).toBe("ok");
    expect(loaded.status === "ok" && loaded.value).toEqual(snapshot);
  });

  it("N2-4: hydrateはpristineなら全復元し、入力済みなら下書きを守って台帳だけを足す", async () => {
    let persist = await import("../src/lib/store/characterSheetRunPersist");
    const pristineSnapshot = makeSnapshot();
    vi.spyOn(persist.characterSheetRunGuard, "load").mockResolvedValue({
      status: "ok",
      value: pristineSnapshot,
    });
    let storeModule = await import("../src/lib/store/characterSheetRun");

    await storeModule.useCharacterSheetRun.getState().hydrate();
    let state = storeModule.useCharacterSheetRun.getState();
    expect(state).toMatchObject({
      hydrated: true,
      mode: pristineSnapshot.mode,
      step: pristineSnapshot.step,
      characterName: pristineSnapshot.characterName,
      characterImagePaths: pristineSnapshot.characterImagePaths,
      attributes: pristineSnapshot.attributes,
      jobs: pristineSnapshot.jobs,
      jobOrder: pristineSnapshot.jobOrder,
      focusedJobId: pristineSnapshot.focusedJobId,
      runIndex: {},
    });

    vi.restoreAllMocks();
    vi.resetModules();
    persist = await import("../src/lib/store/characterSheetRunPersist");
    const restoredJob = makeJob("restored-job");
    const mergeSnapshot = makeSnapshot({
      mode: "expression",
      step: 3,
      characterName: "ディスクの下書き",
      characterImagePaths: ["/img/disk.png"],
      jobs: { [restoredJob.jobId]: restoredJob },
      jobOrder: [restoredJob.jobId],
      focusedJobId: restoredJob.jobId,
    });
    vi.spyOn(persist.characterSheetRunGuard, "load").mockResolvedValue({
      status: "ok",
      value: mergeSnapshot,
    });
    storeModule = await import("../src/lib/store/characterSheetRun");

    const current = storeModule.useCharacterSheetRun.getState();
    current.setCharacterName("画面の下書き");
    current.setCharacterImages(["/img/current.png"]);
    const currentJobId = storeModule.useCharacterSheetRun
      .getState()
      .beginRun("character", "run-current", [
        { cutId: "current", label: "current", role: "current" },
      ]);
    await storeModule.useCharacterSheetRun.getState().hydrate();
    state = storeModule.useCharacterSheetRun.getState();

    expect(state.characterName).toBe("画面の下書き");
    expect(state.characterImagePaths).toEqual(["/img/current.png"]);
    expect(state.mode).toBe("character");
    expect(state.step).toBe(2);
    expect(state.jobs[currentJobId].activeRunId).toBe("run-current");
    expect(state.jobs[restoredJob.jobId]).toEqual(restoredJob);
    expect(state.jobOrder).toEqual([currentJobId, restoredJob.jobId]);
    expect(state.focusedJobId).toBe(currentJobId);
    expect(state.runIndex).toEqual({ "run-current": currentJobId });
    expect(state.runIndex[restoredJob.activeRunId]).toBeUndefined();
    expect(state.hydrated).toBe(true);
  });

  it("N2補正1: hydrate前に始めたrunのイベントだけが復元後も届く", async () => {
    const persist = await import("../src/lib/store/characterSheetRunPersist");
    const restoredJob = makeJob("restored-job");
    vi.spyOn(persist.characterSheetRunGuard, "load").mockResolvedValue({
      status: "ok",
      value: makeSnapshot({
        jobs: { [restoredJob.jobId]: restoredJob },
        jobOrder: [restoredJob.jobId],
        focusedJobId: restoredJob.jobId,
      }),
    });
    const { useCharacterSheetRun } = await import(
      "../src/lib/store/characterSheetRun"
    );
    const currentJobId = useCharacterSheetRun
      .getState()
      .beginRun("character", "run-current", [
        { cutId: "current", label: "current", role: "current" },
      ]);

    await useCharacterSheetRun.getState().hydrate();
    useCharacterSheetRun.getState().applyEvent({
      kind: "cutCompleted",
      runId: "run-current",
      cutId: "current",
      role: "current",
      imagePath: "/out/current.png",
    });
    useCharacterSheetRun.getState().applyEvent({
      kind: "cutCompleted",
      runId: restoredJob.activeRunId,
      cutId: "character-sheet",
      role: "character-sheet",
      imagePath: "/out/restored-late.png",
    });

    const state = useCharacterSheetRun.getState();
    expect(state.jobs[currentJobId].cuts.current).toMatchObject({
      status: "completed",
      imagePath: "/out/current.png",
    });
    expect(state.jobs[restoredJob.jobId].cuts["character-sheet"].imagePath).toBe(
      "/out/character-sheet.png",
    );
    expect(state.runIndex).toEqual({ "run-current": currentJobId });
    expect(state.runIndex[restoredJob.activeRunId]).toBeUndefined();
  });

  it("N2補正2: hydrate中にattributesだけ編集しても保存値で上書きしない", async () => {
    const persist = await import("../src/lib/store/characterSheetRunPersist");
    const restoredJob = makeJob("restored-job");
    const snapshot = makeSnapshot({
      jobs: { [restoredJob.jobId]: restoredJob },
      jobOrder: [restoredJob.jobId],
      focusedJobId: restoredJob.jobId,
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    vi.spyOn(persist.characterSheetRunGuard, "load").mockImplementation(async () => {
      await loadGate;
      return { status: "ok", value: snapshot };
    });
    const { useCharacterSheetRun } = await import(
      "../src/lib/store/characterSheetRun"
    );

    const hydrate = useCharacterSheetRun.getState().hydrate();
    useCharacterSheetRun.getState().setAttributes("画面で入力した属性");
    releaseLoad();
    await hydrate;

    const state = useCharacterSheetRun.getState();
    expect(state.attributes).toBe("画面で入力した属性");
    expect(state.characterName).toBe("");
    expect(state.mode).toBeNull();
    expect(state.step).toBe(1);
    expect(state.jobs[restoredJob.jobId]).toEqual(restoredJob);
    expect(state.jobOrder).toEqual([restoredJob.jobId]);
  });

  it("N2-5: hydrated前は保存せず、以後の連続変更を300ms後の1回にまとめる", async () => {
    vi.useFakeTimers();
    const persist = await import("../src/lib/store/characterSheetRunPersist");
    vi.spyOn(persist.characterSheetRunGuard, "load").mockResolvedValue({
      status: "absent",
    });
    const save = vi
      .spyOn(persist.characterSheetRunGuard, "save")
      .mockResolvedValue(true);
    const { useCharacterSheetRun } = await import(
      "../src/lib/store/characterSheetRun"
    );

    useCharacterSheetRun.getState().setCharacterName("復元前");
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();

    await useCharacterSheetRun.getState().hydrate();
    useCharacterSheetRun.getState().setCharacterName("復元後");
    useCharacterSheetRun.getState().setAttributes("連続変更");
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      characterName: "復元後",
      attributes: "連続変更",
    });
  });
});
