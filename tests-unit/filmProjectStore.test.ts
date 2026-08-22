import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock("../src/lib/ipc", () => ({
  filmProjects: {
    read: ipcMocks.read,
    write: ipcMocks.write,
  },
}));

import { useFilmProjectStore } from "../src/lib/store/filmProject";

async function waitForLatestWrite(): Promise<string> {
  await vi.waitFor(() => expect(ipcMocks.write).toHaveBeenCalled());
  const calls = ipcMocks.write.mock.calls;
  return calls[calls.length - 1]?.[0] as string;
}

describe("filmProject store", () => {
  beforeEach(async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    ipcMocks.read.mockReset().mockResolvedValue("");
    ipcMocks.write.mockReset().mockResolvedValue(undefined);
    useFilmProjectStore.setState({
      projects: [],
      activeProjectId: null,
      filmProjectsFileState: "missing",
    });
    await useFilmProjectStore.getState().initialize();
    ipcMocks.write.mockClear();
  });

  it("createProject はS1の初期値をそろえる", async () => {
    const project = useFilmProjectStore
      .getState()
      .createProject("  春の駅  ", "  言えなかった気持ちを渡す  ", "seedance-2.5");

    expect(project).toMatchObject({
      title: "春の駅",
      theme: "言えなかった気持ちを渡す",
      mode: "film",
      // 2026-08-22 サービス選択の分離: アセット(画像)と動画を別フィールドで持つ
      videoServiceId: "seedance-2.5",
      assetServiceId: "gpt-image-2",
      phase: 1,
      approvals: {
        logline: null,
        beatsheet: null,
        treatment: null,
        scenelist: null,
        look: null,
      },
      script: [],
      assets: [],
      foreshadow: [],
      stylePrefix: "",
      lookMasterPath: null,
      takes: [],
    });
    expect(useFilmProjectStore.getState().activeProjectId).toBe(project.id);
    await waitForLatestWrite();
  });

  it("setPhase はアクティブな作品だけを進める", async () => {
    const project = useFilmProjectStore
      .getState()
      .createProject("春の駅", "気持ちを渡す", "seedance-2.5");
    await waitForLatestWrite();
    ipcMocks.write.mockClear();

    useFilmProjectStore.getState().setPhase(4);

    expect(
      useFilmProjectStore.getState().projects.find((item) => item.id === project.id)?.phase,
    ).toBe(4);
    await waitForLatestWrite();
  });

  it("{version:1, projects:[...]} のJSONで保存し、同じ内容を読み戻す", async () => {
    const created = useFilmProjectStore
      .getState()
      .createProject("春の駅", "気持ちを渡す", "seedance-2.5");
    const serialized = await waitForLatestWrite();

    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      projects: [created],
    });
    expect(ipcMocks.write).toHaveBeenLastCalledWith(serialized, false);

    useFilmProjectStore.setState({ projects: [], activeProjectId: null });
    ipcMocks.read.mockResolvedValue(serialized);
    await useFilmProjectStore.getState().initialize();

    expect(useFilmProjectStore.getState().projects).toEqual([created]);
    expect(useFilmProjectStore.getState().activeProjectId).toBe(created.id);
  });
});
