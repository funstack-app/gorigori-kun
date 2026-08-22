import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RecordedCommand = { cmd: string; args: Record<string, unknown> };

function installRegistrationMock(): RecordedCommand[] {
  const commands: RecordedCommand[] = [];
  mockIPC(async (cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    commands.push({ cmd, args });
    if (cmd === "turn_record") {
      const input = args.args as Record<string, unknown>;
      return { id: "turn-video-1", ...input, createdAt: 100 };
    }
    if (cmd === "image_record") {
      const input = args.args as Record<string, unknown>;
      return { id: `image-${commands.length}`, ...input, createdAt: 101 };
    }
    if (cmd === "generation_info_for_image") return null;
    if (cmd === "projects_write") return null;
    // plugin-fs の stat はテスト環境では失敗してよい。登録側は保存済み path を
    // 正として mtime/size の安全な既定値へフォールバックする。
    return undefined;
  });
  return commands;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  });
});

describe("生成動画の明示登録", () => {
  it("同じ保存パスをライブラリ・履歴・選択中プロジェクトへ1件ずつ登録する", async () => {
    const commands = installRegistrationMock();
    const { useSessions } = await import("../src/lib/store/sessions");
    const { useProjects } = await import("../src/lib/store/projects");
    const { useActiveProject } = await import("../src/lib/store/activeProject");
    const { registerGeneratedMedia, useImages } = await import(
      "../src/lib/store/images"
    );

    useSessions.setState({ activeSessionId: "session-1" });
    useProjects.setState({
      projects: [
        {
          id: "project-1",
          name: "動画案件",
          status: "active",
          items: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    useActiveProject.getState().setActive("project-1");

    const result = await registerGeneratedMedia({
      paths: ["/generated/higgsfield/movie.mp4", "/generated/higgsfield/movie.mp4"],
      mediaType: "video",
      prompt: "人物が振り返る",
      providerId: "higgsfield",
      providerLabel: "Higgsfield",
      modelId: "kling-3",
      refImagePaths: ["/characters/a.png"],
      durationSeconds: 5,
    });

    expect(result).toMatchObject({
      libraryCount: 1,
      historyCount: 1,
      projectCount: 1,
      hadActiveProject: true,
      warnings: [],
    });
    expect(useImages.getState().items).toEqual([
      expect.objectContaining({
        path: "/generated/higgsfield/movie.mp4",
        mediaType: "video",
        durationSeconds: 5,
      }),
    ]);
    expect(
      useProjects.getState().projects[0].items.map((item) => item.imagePath),
    ).toEqual(["/generated/higgsfield/movie.mp4"]);

    const imageRecord = commands.find((entry) => entry.cmd === "image_record");
    expect(imageRecord?.args.args).toMatchObject({
      turnId: "turn-video-1",
      path: "/generated/higgsfield/movie.mp4",
      mediaType: "video",
      durationSeconds: 5,
    });
  });

  it("remote_mcp の done で登録し、同じ done の再送では履歴を二重作成しない", async () => {
    const commands = installRegistrationMock();
    const { useSessions } = await import("../src/lib/store/sessions");
    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    const { useImages } = await import("../src/lib/store/images");

    useSessions.setState({ activeSessionId: "session-1" });
    useRemoteMcpGen.setState((state) => ({
      jobs: {
        ...state.jobs,
        "request-1": {
          requestId: "request-1",
          providerId: "runway",
          providerLabel: "Runway",
          toolName: "generate_video",
          toolTitle: "動画生成",
          kind: "video",
          phase: "running",
          paramsJson: "{}",
          selection: {
            providerId: "runway",
            providerLabel: "Runway",
            toolName: "generate_video",
            toolTitle: "動画生成",
            inputSchemaJson: "{}",
            kind: "video",
          },
          input: {
            kind: "video",
            prompt: "波打ち際を歩く",
            count: 1,
            durationSeconds: 5,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      },
      latestRequestId: { ...state.latestRequestId, video: "request-1" },
    }));

    const done = {
      requestId: "request-1",
      providerId: "runway",
      phase: "done" as const,
      savedPaths: ["/generated/higgsfield/runway.mp4"],
    };
    useRemoteMcpGen.getState().applyEvent(done);
    await waitUntil(
      () => useRemoteMcpGen.getState().jobs["request-1"].registrationCompleted === true,
    );

    const completed = useRemoteMcpGen.getState().jobs["request-1"];
    expect(completed.phase).toBe("done");
    expect(completed.message).toContain("ライブラリ1件・履歴1件");
    expect(useImages.getState().knownPaths.has("/generated/higgsfield/runway.mp4")).toBe(true);

    useRemoteMcpGen.getState().applyEvent(done);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commands.filter((entry) => entry.cmd === "turn_record")).toHaveLength(1);
    expect(commands.filter((entry) => entry.cmd === "image_record")).toHaveLength(1);
  });
});
