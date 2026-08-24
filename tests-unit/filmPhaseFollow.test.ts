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

async function waitForLatestWrite(): Promise<void> {
  await vi.waitFor(() => expect(ipcMocks.write).toHaveBeenCalled());
}

function activeProject(projectId: string) {
  const project = useFilmProjectStore
    .getState()
    .projects.find((item) => item.id === projectId);
  if (!project) throw new Error("テスト対象のフィルム企画が見つかりません");
  return project;
}

function createScriptProject() {
  return useFilmProjectStore
    .getState()
    .createProject("春の駅", "言えなかった気持ちを渡す", "seedance-2.5", {
      startInScript: true,
    });
}

function approveThroughBlocks(): void {
  const store = useFilmProjectStore.getState();
  store.saveLogline("春の駅で、言えなかった気持ちを渡す。");
  expect(store.approveStage("logline")).toBe(true);
  store.saveBeatsheet("出会う。迷う。気持ちを渡す。");
  expect(store.approveStage("beatsheet")).toBe(true);
  store.saveTreatment("主人公は春の駅で相手を待ち、最後に手紙を渡す。");
  expect(store.approveStage("treatment")).toBe(true);
  store.saveScenelist("SCENE 1: 春の駅", [{} as never]);
  expect(store.approveStage("scenelist")).toBe(true);
  store.saveBlocks("BLOCK 1: 手紙を渡す", [{} as never]);
  expect(store.approveStage("blocks")).toBe(true);
}

describe("AIフィルムの工程自動追従", () => {
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

  it("途中の承認ではphase 2を保ち、blocks承認成功でphase 3へ進む", async () => {
    const project = createScriptProject();
    const store = useFilmProjectStore.getState();

    store.saveLogline("春の駅で、言えなかった気持ちを渡す。");
    expect(store.approveStage("logline")).toBe(true);
    expect(activeProject(project.id).phase).toBe(2);

    store.saveBeatsheet("出会う。迷う。気持ちを渡す。");
    expect(store.approveStage("beatsheet")).toBe(true);
    expect(activeProject(project.id).phase).toBe(2);

    store.saveTreatment("主人公は春の駅で相手を待ち、最後に手紙を渡す。");
    expect(store.approveStage("treatment")).toBe(true);
    expect(activeProject(project.id).phase).toBe(2);

    store.saveScenelist("SCENE 1: 春の駅", [{} as never]);
    expect(store.approveStage("scenelist")).toBe(true);
    expect(activeProject(project.id).phase).toBe(2);

    store.saveBlocks("BLOCK 1: 手紙を渡す", [{} as never]);
    expect(store.approveStage("blocks")).toBe(true);
    expect(activeProject(project.id).phase).toBe(3);
    await waitForLatestWrite();
  });

  it("phase 4以上でblocksを再承認してもphaseを下げない", async () => {
    const project = createScriptProject();
    approveThroughBlocks();

    for (const phase of [4, 6] as const) {
      useFilmProjectStore.getState().setPhase(phase);
      expect(useFilmProjectStore.getState().approveStage("blocks")).toBe(true);
      expect(activeProject(project.id).phase).toBe(phase);
    }
    await waitForLatestWrite();
  });

  it("blocks承認の取り消しは既存どおりphase 2へ戻す", async () => {
    const project = createScriptProject();
    approveThroughBlocks();
    expect(activeProject(project.id).phase).toBe(3);

    expect(useFilmProjectStore.getState().revokeStageApproval("blocks")).toBe(true);
    expect(activeProject(project.id).phase).toBe(2);
    expect(activeProject(project.id).approvals.blocks).toBeNull();
    await waitForLatestWrite();
  });
});
