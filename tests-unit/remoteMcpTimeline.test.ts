import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("状態遷移が時間内に完了しませんでした");
}

async function stores() {
  const { useBatches } = await import("../src/lib/store/batches");
  const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
  return { useBatches, useRemoteMcpGen };
}

function installRegistrationCommands(
  generate: () => Promise<{ generatedPaths: string[]; failedCount: number; errors: string[] }>,
) {
  mockIPC(async (cmd, rawArgs) => {
    if (cmd === "higgsfield_mcp_generate_batch") return generate();
    if (cmd === "turn_record") {
      const args = (rawArgs ?? {}) as { args?: Record<string, unknown> };
      return { id: "turn-remote-1", ...(args.args ?? {}), createdAt: 100 };
    }
    if (cmd === "image_record") {
      const args = (rawArgs ?? {}) as { args?: Record<string, unknown> };
      return { id: "image-remote-1", ...(args.args ?? {}), createdAt: 101 };
    }
    if (cmd === "generation_info_for_image") return null;
    if (cmd === "projects_write") return null;
    return undefined;
  });
}

async function selectHiggsfieldVideo() {
  const { useBatches, useRemoteMcpGen } = await stores();
  useRemoteMcpGen.getState().setSelection("video", {
    providerId: "higgsfield",
    providerLabel: "HiggsField",
    toolName: "generate_video",
    toolTitle: "動画生成",
    inputSchemaJson: "{}",
    kind: "video",
    model: {
      id: "kling-3",
      name: "Kling 3.0",
      label: "Kling 3.0",
      kind: "video",
      passModel: true,
    },
  });
  return { useBatches, useRemoteMcpGen };
}

async function selectKreaImage() {
  const { useBatches, useRemoteMcpGen } = await stores();
  useRemoteMcpGen.getState().setSelection("image", {
    providerId: "krea",
    providerLabel: "Krea",
    toolName: "generate_image",
    inputSchemaJson: "{}",
    kind: "image",
    model: {
      id: "flux-1-1-pro",
      name: "FLUX 1.1 Pro",
      kind: "image",
      passModel: true,
    },
  });
  return { useBatches, useRemoteMcpGen };
}

describe("remoteMcpGen の生成タイムライン", () => {
  beforeEach(() => localStorage.clear());

  it("開始直後に requestId の走行中カードを置き、完了時に同じカードへ実データを入れる", async () => {
    const generation = deferred<{
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
    }>();
    installRegistrationCommands(() => generation.promise);
    const { useBatches, useRemoteMcpGen } = await selectHiggsfieldVideo();

    const start = useRemoteMcpGen.getState().start({
      kind: "video",
      prompt: "海辺を歩く人物",
      count: 2,
      durationSeconds: 5,
    });

    const runningBatch = useBatches.getState().batches[0];
    const requestId = useRemoteMcpGen.getState().latestRequestId.video;
    expect(requestId).toBeTruthy();
    expect(runningBatch).toMatchObject({
      batchId: requestId,
      source: "remoteMcp",
      provider: "higgsfield",
      providerLabel: "HiggsField",
      modelDisplayName: "Kling 3.0",
      mediaType: "video",
      count: 2,
      status: "running",
    });
    expect(runningBatch.workers.map((worker) => worker.status)).toEqual([
      "running",
      "running",
    ]);

    generation.resolve({
      generatedPaths: ["/generated/remote/one.mp4", "/generated/remote/two.mp4"],
      failedCount: 0,
      errors: [],
    });
    await expect(start).resolves.toEqual({ ok: true, requestId });

    const batches = useBatches.getState().batches;
    expect(batches).toHaveLength(1);
    expect(batches[0].batchId).toBe(requestId);
    expect(batches[0].status).toBe("completed");
    expect(batches[0].workers).toEqual([
      expect.objectContaining({ status: "completed", path: "/generated/remote/one.mp4" }),
      expect.objectContaining({ status: "completed", path: "/generated/remote/two.mp4" }),
    ]);
  });

  it("失敗時は humanize 済み理由を同じカードに残し、閉じると削除できる", async () => {
    installRegistrationCommands(async () => {
      throw new Error("quota exhausted");
    });
    const { useBatches, useRemoteMcpGen } = await selectHiggsfieldVideo();

    const result = await useRemoteMcpGen.getState().start({
      kind: "video",
      prompt: "夜の街を走る車",
      count: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok || !result.requestId) throw new Error("requestId 付きの失敗を期待");
    const batch = useBatches.getState().batches[0];
    expect(batch.batchId).toBe(result.requestId);
    expect(batch.status).toBe("completed");
    expect(batch.workers).toEqual([
      expect.objectContaining({ status: "failed", error: result.message }),
    ]);

    useBatches.getState().removeBatch(result.requestId);
    expect(useBatches.getState().batches).toEqual([]);
  });

  it("比較生成は各モデルの requestId ごとに1枚ずつカードを作る", async () => {
    let generated = 0;
    installRegistrationCommands(async () => {
      generated += 1;
      return {
        generatedPaths: [`/generated/remote/compare-${generated}.mp4`],
        failedCount: 0,
        errors: [],
      };
    });
    const { useBatches, useRemoteMcpGen } = await selectHiggsfieldVideo();
    const first = useRemoteMcpGen.getState().selections.video;
    if (!first?.model) throw new Error("比較元モデルがありません");
    useRemoteMcpGen.getState().setVideoSelections([
      first,
      {
        ...first,
        model: {
          ...first.model,
          id: "wan-2-6",
          name: "Wan 2.6",
          label: "Wan 2.6",
        },
      },
    ]);

    await expect(
      useRemoteMcpGen.getState().startSelectedVideos({
        kind: "video",
        prompt: "同じ場面を比較する",
        count: 3,
        compareEach: true,
      }),
    ).resolves.toMatchObject({ ok: true });

    const batches = useBatches.getState().batches;
    const requestIds = Object.keys(useRemoteMcpGen.getState().jobs);
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.batchId).sort()).toEqual(requestIds.sort());
    expect(batches.map((batch) => batch.count)).toEqual([1, 1]);
    expect(batches.map((batch) => batch.modelDisplayName)).toEqual([
      "Kling 3.0",
      "Wan 2.6",
    ]);
    expect(batches.every((batch) => batch.status === "completed")).toBe(true);
  });

  it("slotResults を枠番号どおり成功・失敗へ写像する", async () => {
    installRegistrationCommands(async () => ({
      generatedPaths: [],
      failedCount: 0,
      errors: [],
    }));
    const { useBatches, useRemoteMcpGen } = await selectKreaImage();
    const result = await useRemoteMcpGen.getState().start({
      kind: "image",
      prompt: "三つのお餅",
      count: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    useRemoteMcpGen.getState().applyEvent({
      requestId: result.requestId,
      providerId: "krea",
      phase: "done",
      savedPaths: ["/generated/remote/mochi-1.png", "/generated/remote/mochi-3.png"],
      errors: ["枠2: 焼き上がりませんでした"],
      slotResults: [
        { slot: 1, status: "done", savedPath: "/generated/remote/mochi-1.png" },
        { slot: 2, status: "failed", error: "焼き上がりませんでした" },
        { slot: 3, status: "done", savedPath: "/generated/remote/mochi-3.png" },
      ],
    });
    await waitUntil(
      () =>
        useBatches.getState().batches.find((batch) => batch.batchId === result.requestId)
          ?.status === "completed",
    );

    const batch = useBatches
      .getState()
      .batches.find((candidate) => candidate.batchId === result.requestId);
    expect(batch?.workers).toEqual([
      expect.objectContaining({
        idx: 1,
        status: "completed",
        path: "/generated/remote/mochi-1.png",
      }),
      expect.objectContaining({ idx: 2, status: "failed" }),
      expect.objectContaining({
        idx: 3,
        status: "completed",
        path: "/generated/remote/mochi-3.png",
      }),
    ]);
    expect(batch?.failedCount).toBe(1);
    expect(useRemoteMcpGen.getState().jobs[result.requestId].registrationWarnings).toContain(
      "枠2: 焼き上がりませんでした",
    );
  });

  it("同じ slotResults スナップショットを2回受けても worker を二重適用しない", async () => {
    installRegistrationCommands(async () => ({
      generatedPaths: [],
      failedCount: 0,
      errors: [],
    }));
    const { useBatches, useRemoteMcpGen } = await selectKreaImage();
    const result = await useRemoteMcpGen.getState().start({
      kind: "image",
      prompt: "三つのお餅",
      count: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    const snapshot = {
      requestId: result.requestId,
      providerId: "krea",
      phase: "running" as const,
      slotResults: [
        { slot: 1, status: "done" as const, savedPath: "/generated/remote/idempotent.png" },
        { slot: 2, status: "failed" as const, error: "一時エラー" },
        { slot: 3, status: "running" as const },
      ],
    };
    useRemoteMcpGen.getState().applyEvent(snapshot);
    const batchesAfterFirstSnapshot = useBatches.getState();
    const workersAfterFirstSnapshot = batchesAfterFirstSnapshot.batches.find(
      (batch) => batch.batchId === result.requestId,
    )?.workers;

    useRemoteMcpGen.getState().applyEvent(snapshot);
    expect(useBatches.getState()).toBe(batchesAfterFirstSnapshot);
    expect(
      useBatches.getState().batches.find((batch) => batch.batchId === result.requestId)?.workers,
    ).toEqual(workersAfterFirstSnapshot);
    expect(useRemoteMcpGen.getState().jobs[result.requestId].appliedSlots).toEqual({
      1: "done",
      2: "failed",
    });

    useBatches.getState().removeBatch(result.requestId);
  });

  it("共通 remote MCP の done イベントでも同じ画像カードを完了へ置き換える", async () => {
    installRegistrationCommands(async () => ({
      generatedPaths: [],
      failedCount: 0,
      errors: [],
    }));
    const { useBatches, useRemoteMcpGen } = await stores();
    useRemoteMcpGen.getState().setSelection("image", {
      providerId: "krea",
      providerLabel: "Krea",
      toolName: "generate_image",
      inputSchemaJson: "{}",
      kind: "image",
      model: {
        id: "flux-1-1-pro",
        name: "FLUX 1.1 Pro",
        kind: "image",
        passModel: true,
      },
    });

    const result = await useRemoteMcpGen.getState().start({
      kind: "image",
      prompt: "白い背景のお餅",
      count: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(useBatches.getState().batches[0]).toMatchObject({
      batchId: result.requestId,
      status: "running",
      providerLabel: "Krea",
      modelDisplayName: "FLUX 1.1 Pro",
    });

    useRemoteMcpGen.getState().applyEvent({
      requestId: result.requestId,
      providerId: "krea",
      phase: "done",
      savedPaths: ["/generated/remote/mochi.png"],
    });
    await waitUntil(
      () => useBatches.getState().batches[0]?.status === "completed",
    );

    expect(useBatches.getState().batches).toHaveLength(1);
    expect(useBatches.getState().batches[0].workers).toEqual([
      expect.objectContaining({
        status: "completed",
        path: "/generated/remote/mochi.png",
      }),
    ]);
  });
});
