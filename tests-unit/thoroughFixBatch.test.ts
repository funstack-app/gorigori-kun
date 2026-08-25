import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RecordedCommand = { cmd: string; args: Record<string, unknown> };

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
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("状態遷移が時間内に完了しませんでした");
}

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function installIpc(
  handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {},
): RecordedCommand[] {
  const commands: RecordedCommand[] = [];
  mockIPC(async (cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    commands.push({ cmd, args });
    if (handlers[cmd]) return handlers[cmd](args);
    if (cmd === "turn_record") {
      const input = args.args as Record<string, unknown>;
      return { id: `turn-${commands.length}`, ...input, createdAt: 100 };
    }
    if (cmd === "image_record") {
      const input = args.args as Record<string, unknown>;
      return { id: `image-${commands.length}`, ...input, createdAt: 101 };
    }
    if (cmd === "generation_info_for_image") return null;
    if (cmd === "projects_write") return null;
    return undefined;
  });
  return commands;
}

function remoteSelection(
  providerId: string,
  kind: "image" | "video",
  modelId: string,
  passModel = true,
) {
  return {
    providerId,
    providerLabel: providerId,
    toolName: kind === "video" ? "generate_video" : "generate_image",
    inputSchemaJson: "{}",
    kind,
    model: {
      id: modelId,
      name: modelId,
      kind,
      passModel,
    },
  } as const;
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  vi.restoreAllMocks();
});

describe("R2: フロントの生エラー短文化", () => {
  it("film・動画・remote登録の各出口が共通の短文化を通る", () => {
    const film = source("src/lib/store/filmGenRun.ts");
    const video = source("src/lib/scene/useVideoSceneGeneration.ts");
    const remote = source("src/lib/store/remoteMcpGen.ts");

    expect(film).toContain('import { humanizeError } from "../humanizeError"');
    expect(film).toContain(': humanizeError(raw)');
    expect(video).toContain('import { humanizeError } from "../humanizeError"');
    expect(video).toContain("uniqueReasons.map((reason) => humanizeError(reason))");
    expect(video).toContain("${humanizeError(errorMessage)}");
    expect(remote).toContain("friendlyRemoteMcpError(error, 120)");
  });

  it("登録失敗の worker.error に生JSONを残さない", async () => {
    const images = await import("../src/lib/store/images");
    vi.spyOn(images, "registerGeneratedMedia").mockRejectedValue(
      new Error(
        JSON.stringify({
          error: { message: "履歴の登録に失敗しました", schema: { secret: "raw" } },
        }),
      ),
    );
    installIpc({ remote_mcp_generate: () => ({ savedPaths: [], errors: [] }) });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    const { useBatches } = await import("../src/lib/store/batches");
    useRemoteMcpGen.getState().setSelection(
      "image",
      remoteSelection("krea", "image", "flux-1-1-pro"),
    );

    const started = await useRemoteMcpGen.getState().start({
      kind: "image",
      prompt: "白いお餅",
      count: 1,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);

    useRemoteMcpGen.getState().applyEvent({
      requestId: started.requestId,
      providerId: "krea",
      phase: "done",
      savedPaths: ["/generated/mochi.png"],
    });
    await waitUntil(
      () => useRemoteMcpGen.getState().jobs[started.requestId].registrationCompleted === true,
    );

    const batch = useBatches.getState().batches.find(
      (candidate) => candidate.batchId === started.requestId,
    );
    const failedWorker = batch?.workers.find((worker) => worker.status === "failed");
    expect(failedWorker && "error" in failedWorker ? failedWorker.error : "").toContain(
      "履歴の登録に失敗しました",
    );
    expect(failedWorker && "error" in failedWorker ? failedWorker.error : "").not.toContain("{");
    expect(failedWorker && "error" in failedWorker ? failedWorker.error : "").not.toContain(
      "schema",
    );
  });
});

describe("R3/F5: 動画失敗枠の元ジョブ再生成", () => {
  it("元ジョブと同じ provider/model/input を使い、count だけ1にする", async () => {
    const commands = installIpc({
      remote_mcp_generate: () => ({ savedPaths: [], errors: [] }),
    });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    useRemoteMcpGen.getState().setSelection(
      "video",
      remoteSelection("krea", "video", "krea-video-1"),
    );

    const original = await useRemoteMcpGen.getState().start({
      kind: "video",
      prompt: "夕暮れの海辺を歩く",
      count: 3,
      durationSeconds: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      startImagePath: "/refs/start.png",
      referenceImagePaths: ["/refs/person.png"],
    });
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error(original.message);

    const retried = await useRemoteMcpGen.getState().regenerateOne(original.requestId);
    expect(retried.ok).toBe(true);

    const paidCalls = commands.filter((command) => command.cmd === "remote_mcp_generate");
    expect(paidCalls).toHaveLength(2);
    expect(paidCalls[1].args).toMatchObject({
      providerId: "krea",
      model: "krea-video-1",
      prompt: "夕暮れの海辺を歩く",
      count: 1,
      durationSeconds: 8,
      aspect: "16:9",
      referencePaths: ["/refs/start.png", "/refs/person.png"],
      kind: "video",
    });
    expect("retry" in useRemoteMcpGen.getState()).toBe(false);
  });

  it("Higgsfield元ジョブの再生成も remoteMcp.generate へ count=1 で配線する", async () => {
    const commands = installIpc({
      higgsfield_mcp_generate_batch: () => ({
        generatedPaths: ["/generated/original.mp4"],
        failedCount: 0,
        errors: [],
      }),
      remote_mcp_generate: () => ({ savedPaths: [], errors: [] }),
    });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    useRemoteMcpGen.getState().setSelection(
      "video",
      remoteSelection("higgsfield", "video", "kling3_0"),
    );
    const original = await useRemoteMcpGen.getState().start({
      kind: "video",
      prompt: "同じ人物が振り返る",
      count: 2,
      durationSeconds: 5,
      aspectRatio: "16:9",
      referenceImagePaths: ["/refs/person.png"],
    });
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error(original.message);

    await expect(
      useRemoteMcpGen.getState().regenerateOne(original.requestId),
    ).resolves.toMatchObject({ ok: true });

    expect(
      commands.filter((command) => command.cmd === "higgsfield_mcp_generate_batch"),
    ).toHaveLength(1);
    const remoteCalls = commands.filter((command) => command.cmd === "remote_mcp_generate");
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].args).toMatchObject({
      providerId: "higgsfield",
      model: "kling3_0",
      prompt: "同じ人物が振り返る",
      count: 1,
      durationSeconds: 5,
      aspect: "16:9",
      referencePaths: ["/refs/person.png"],
      kind: "video",
    });
  });

  it("元ジョブが無い remote 動画枠では再生成ボタンを出さない結線になっている", () => {
    const workspace = source("src/components/GenerationWorkspace.tsx");
    const videoPanel = source("src/components/VideoConstructedPromptPanel.tsx");
    expect(workspace).toContain(
      'source === "remoteMcp" && worker.mediaType === "video"',
    );
    expect(workspace).toContain("state.jobs[requestId]");
    expect(workspace).toContain("if (!job) return null");
    expect(workspace).toContain("state.regenerateOne");
    expect(videoPanel).not.toContain("動画生成は必ず Higgsfield MCP");
    expect(videoPanel).toContain("接続先モデルを選んだ生成は remoteMcpGen 側が担当する");
  });
});

describe("R4: remote 経路の @imgN 解決", () => {
  it("画像remoteも cleanedPrompt とメンション参照だけを渡す", () => {
    const image = source("src/lib/scene/useSceneGeneration.ts");
    const remoteBlock = image.slice(
      image.indexOf("const generateSelected"),
      image.indexOf("return {", image.indexOf("const generateSelected")),
    );
    expect(remoteBlock).toContain("resolveImageMentions(effectivePrompt, composerReferences)");
    expect(remoteBlock).toContain("const prompt = mentionResult.cleanedPrompt.trim()");
    expect(remoteBlock).toContain("mentionResult.mentioned.map((mention) => mention.path)");
    expect(remoteBlock).toContain("referenceImagePaths: effectiveRefPaths");
  });

  it("動画remoteも本文を掃除し、メンション時は元画像を重ねて渡さない", () => {
    const video = source("src/components/VideoConstructedPromptPanel.tsx");
    const remoteBlock = video.slice(
      video.indexOf("const runSelectedGeneration"),
      video.indexOf("return (", video.indexOf("const runSelectedGeneration")),
    );
    expect(remoteBlock).toContain("resolveImageMentions(effectivePrompt, references)");
    expect(remoteBlock).toContain("prompt: mentionResult.cleanedPrompt.trim()");
    expect(remoteBlock).toContain("mentionedPaths.length > 0 ? undefined : sourceImagePath");
    expect(remoteBlock).toContain("mentionedPaths.length > 0");
  });
});

describe("R5: Higgsfield動画の固有パラメータ", () => {
  it("実測モデルの既定 mode/sound/genre/modelVariant を復元する", async () => {
    const commands = installIpc({
      higgsfield_mcp_generate_batch: (raw) => {
        const args = raw.args as Record<string, unknown>;
        return {
          generatedPaths: [`/generated/${String(args.model)}.mp4`],
          failedCount: 0,
          errors: [],
        };
      },
    });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");

    useRemoteMcpGen.getState().setSelection(
      "video",
      remoteSelection("higgsfield", "video", "kling3_0"),
    );
    await expect(
      useRemoteMcpGen.getState().start({ kind: "video", prompt: "走る人物", count: 1 }),
    ).resolves.toMatchObject({ ok: true });

    useRemoteMcpGen.getState().setSelection(
      "video",
      remoteSelection("higgsfield", "video", "seedance_2_0"),
    );
    await expect(
      useRemoteMcpGen.getState().start({ kind: "video", prompt: "飛ぶ鳥", count: 1 }),
    ).resolves.toMatchObject({ ok: true });

    useRemoteMcpGen.getState().setSelection(
      "video",
      remoteSelection("higgsfield", "video", "veo3_1"),
    );
    await expect(
      useRemoteMcpGen.getState().start({ kind: "video", prompt: "静かな森", count: 1 }),
    ).resolves.toMatchObject({ ok: true });

    const generated = commands
      .filter((command) => command.cmd === "higgsfield_mcp_generate_batch")
      .map((command) => command.args.args as Record<string, unknown>);
    expect(generated[0]).toMatchObject({ model: "kling3_0", mode: "std", sound: "on" });
    expect(generated[1]).toMatchObject({
      model: "seedance_2_0",
      mode: "std",
      genre: "auto",
      resolution: "720p",
    });
    expect(generated[2]).toMatchObject({
      model: "veo3_1",
      modelVariant: "veo-3-1-fast",
    });
    expect(generated[2]).not.toHaveProperty("quality");
  });
});

describe("F1/F3/F4: remote開始の安全柵", () => {
  it("直接経路で標準モデルしか無い場合は再取得を案内し、生成を呼ばない", async () => {
    const commands = installIpc({
      remote_mcp_generate: () => ({ savedPaths: [], errors: [] }),
    });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    useRemoteMcpGen.getState().setSelection(
      "image",
      remoteSelection("krea", "image", "krea-standard", false),
    );

    await expect(
      useRemoteMcpGen.getState().start({ kind: "image", prompt: "お餅" }),
    ).resolves.toEqual({
      ok: false,
      message:
        "モデル一覧を取得できていません。モデル一覧の「再取得」をしてから選び直してください",
    });
    expect(commands.filter((command) => command.cmd === "remote_mcp_generate")).toHaveLength(0);
  });

  it("start の素早い二度押しでも有料生成は1回だけ呼ぶ", async () => {
    const generation = deferred<{ savedPaths: string[]; errors: string[] }>();
    const commands = installIpc({ remote_mcp_generate: () => generation.promise });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    useRemoteMcpGen.getState().setSelection(
      "image",
      remoteSelection("krea", "image", "flux-1-1-pro"),
    );

    const first = useRemoteMcpGen.getState().start({ kind: "image", prompt: "丸いお餅" });
    const second = await useRemoteMcpGen
      .getState()
      .start({ kind: "image", prompt: "丸いお餅" });
    expect(second).toEqual({
      ok: false,
      message: "生成の開始処理中です。完了するまでお待ちください。",
    });
    await waitUntil(
      () => commands.filter((command) => command.cmd === "remote_mcp_generate").length === 1,
    );
    generation.resolve({ savedPaths: [], errors: [] });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(commands.filter((command) => command.cmd === "remote_mcp_generate")).toHaveLength(1);
  });

  it("startSelectedVideos の素早い二度押しでも有料生成は1回だけ呼ぶ", async () => {
    const generation = deferred<{ savedPaths: string[]; errors: string[] }>();
    const commands = installIpc({ remote_mcp_generate: () => generation.promise });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    useRemoteMcpGen.getState().setVideoSelections([
      remoteSelection("krea", "video", "krea-video-1"),
    ]);

    const first = useRemoteMcpGen
      .getState()
      .startSelectedVideos({ kind: "video", prompt: "揺れる木", count: 1 });
    const second = await useRemoteMcpGen
      .getState()
      .startSelectedVideos({ kind: "video", prompt: "揺れる木", count: 1 });
    expect(second.ok).toBe(false);
    await waitUntil(
      () => commands.filter((command) => command.cmd === "remote_mcp_generate").length === 1,
    );
    generation.resolve({ savedPaths: [], errors: [] });
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(commands.filter((command) => command.cmd === "remote_mcp_generate")).toHaveLength(1);
  });

  it("slotResults が無い旧イベントでも枠2失敗を実スロットへ置く", async () => {
    installIpc({ remote_mcp_generate: () => ({ savedPaths: [], errors: [] }) });
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    const { useBatches } = await import("../src/lib/store/batches");
    useRemoteMcpGen.getState().setSelection(
      "image",
      remoteSelection("krea", "image", "flux-1-1-pro"),
    );
    const started = await useRemoteMcpGen.getState().start({
      kind: "image",
      prompt: "三つのお餅",
      count: 3,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);

    useRemoteMcpGen.getState().applyEvent({
      requestId: started.requestId,
      providerId: "krea",
      phase: "done",
      savedPaths: ["/generated/one.png", "/generated/three.png"],
      errors: ["枠2: 焼き上がりませんでした"],
    });
    await waitUntil(
      () =>
        useBatches.getState().batches.find((batch) => batch.batchId === started.requestId)
          ?.status === "completed",
    );

    const batch = useBatches.getState().batches.find(
      (candidate) => candidate.batchId === started.requestId,
    );
    expect(batch?.workers).toEqual([
      expect.objectContaining({ idx: 1, status: "completed", path: "/generated/one.png" }),
      expect.objectContaining({ idx: 2, status: "failed" }),
      expect.objectContaining({ idx: 3, status: "completed", path: "/generated/three.png" }),
    ]);
  });
});
