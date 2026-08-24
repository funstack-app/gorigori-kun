// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  writeUpload: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("../src/lib/ipc", () => ({
  filmProjects: {
    read: ipcMocks.read,
    write: ipcMocks.write,
  },
  higgsfieldMcp: {
    status: vi.fn(),
    generateBatch: vi.fn(),
  },
  images: {
    revealInFinder: vi.fn(),
    writeUpload: ipcMocks.writeUpload,
  },
}));

vi.mock("../src/lib/store/toasts", () => {
  const useToasts = (selector: (state: typeof toastMocks) => unknown) => selector(toastMocks);
  useToasts.getState = () => toastMocks;
  return { useToasts };
});

vi.mock("../src/lib/store/auth", () => ({
  useAuth: { getState: () => ({ refresh: vi.fn(), account: null }) },
}));

vi.mock("../src/lib/store/activeProject", () => ({
  useActiveProject: { getState: () => ({ activeProjectId: null }) },
}));

vi.mock("../src/lib/store/batches", () => ({
  useBatches: {
    getState: () => ({
      batches: [],
      startBatch: vi.fn(),
      applyEvent: vi.fn(),
      removeBatch: vi.fn(),
    }),
  },
}));

vi.mock("../src/lib/store/projects", () => ({
  useProjects: { getState: () => ({ addItem: vi.fn() }) },
}));

vi.mock("../src/lib/scene/useVideoSceneGeneration", () => ({
  paramsToVideoArgs: () => ({}),
}));

vi.mock("../src/lib/videoModels", () => ({
  clampDurationForModel: (_modelId: string, duration: number) => duration,
  findVideoModel: (modelId: string) => ({
    id: modelId,
    label: "テスト動画モデル",
    jobSetType: "test-video-model",
    duration: { kind: "integer", min: 1, max: 15 },
    defaultAspectRatio: "16:9",
    extraParams: {},
  }),
}));

vi.mock("../src/components/ReferenceLibraryModal", () => ({
  ReferenceLibraryModal: () => null,
}));

vi.mock("../src/components/SafeImage", () => ({
  SafeImage: () => null,
}));

vi.mock("../src/components/skills/multiAngle/CharacterPresetPickerModal", () => ({
  CharacterPresetPickerModal: () => null,
}));

import type { FilmProject } from "../src/lib/film/types";
import {
  FREE_PROMPT_BLOCK_ID,
  GenerationPhasePanel,
} from "../src/components/skills/film/GenerationPhasePanel";
import { canEnterGenerationPhase } from "../src/lib/film/generationPhaseGate";
import { useFilmGenRun } from "../src/lib/store/filmGenRun";
import { useFilmProjectStore } from "../src/lib/store/filmProject";

const initialFilmGenState = useFilmGenRun.getState();
const initialFilmProjectState = useFilmProjectStore.getState();

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function projectForGeneration(videoServiceId: string): FilmProject {
  const approvedAt = "2026-08-25T00:00:00.000Z";
  return {
    id: `project-${videoServiceId}`,
    title: "雨上がりの駅",
    theme: "言えなかった気持ちを渡す",
    mode: "film",
    assetServiceId: "gpt-image-2",
    videoServiceId,
    phase: 5,
    approvals: {
      logline: { approvedAt },
      beatsheet: { approvedAt },
      treatment: { approvedAt },
      scenelist: { approvedAt },
      blocks: { approvedAt },
      look: { approvedAt },
    },
    script: {
      logline: "駅で気持ちを渡す",
      beatsheet: "出会う、迷う、渡す",
      treatment: "雨上がりの駅で再会する",
      scenes: [{
        id: "S1",
        location: "夜の駅前",
        purpose: "再会",
        characterNames: ["ユウ"],
        durationSeconds: 5,
      }],
      blocks: [{
        id: "B1",
        sceneId: "S1",
        durationSeconds: 5,
        visual: "赤い傘を閉じる",
        performance: "ためらってから笑う",
        dialogue: "待ってた",
        sound: "雨だれ",
        foreshadowIds: [],
      }],
      blockScriptText: "S1/B1 赤い傘を閉じる",
    },
    assets: [],
    foreshadow: [],
    stylePrefix: "一貫した色調・自然光・実写系。作品テーマ: 言えなかった気持ちを渡す",
    lookMasterPath: null,
    lookMasterDescription: "",
    takes: [],
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonWithin(scope: ParentNode, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`ボタンがありません: ${label}`);
  return button;
}

async function renderGeneration(project: FilmProject) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(GenerationPhasePanel, { project }));
  });
}

async function prepareProjectStore() {
  ipcMocks.read.mockResolvedValue("");
  ipcMocks.write.mockResolvedValue(undefined);
  await useFilmProjectStore.getState().initialize();
  ipcMocks.write.mockClear();
}

function markBlocksApproved(projectId: string, stylePrefix = "") {
  useFilmProjectStore.setState((state) => ({
    projects: state.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            phase: 3,
            stylePrefix,
            approvals: {
              ...project.approvals,
              blocks: { approvedAt: "2026-08-25T00:00:00.000Z" },
            },
          }
        : project),
  }));
}

beforeEach(() => {
  (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  ipcMocks.read.mockReset();
  ipcMocks.write.mockReset();
  ipcMocks.writeUpload.mockReset();
  toastMocks.push.mockReset();
  useFilmGenRun.setState({
    ...initialFilmGenState,
    runs: {},
    connectionStatus: "ready",
    connectionReason: null,
  }, true);
  useFilmProjectStore.setState({
    ...initialFilmProjectState,
    projects: [],
    activeProjectId: null,
    filmProjectsFileState: "missing",
    filmProjectsSaveError: null,
  }, true);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("AIフィルムのクイックレーン", () => {
  it("blocks承認だけで③をスキップし、既定の共通指定を保存してphase 4へ進む", async () => {
    await prepareProjectStore();
    const created = useFilmProjectStore.getState().createProject(
      "雨上がりの駅",
      "言えなかった気持ちを渡す",
      "seedance-2.5",
    );
    markBlocksApproved(created.id);

    expect(useFilmProjectStore.getState().approveLookLenient()).toBe(true);

    const updated = useFilmProjectStore.getState().projects.find((item) => item.id === created.id);
    expect(updated?.phase).toBe(4);
    expect(updated?.approvals.look).not.toBeNull();
    expect(updated?.lookMasterPath).toBeNull();
    expect(updated?.assets).toEqual([]);
    expect(updated?.stylePrefix).toBe(
      "一貫した色調・自然光・実写系。作品テーマ: 言えなかった気持ちを渡す",
    );
    await vi.waitFor(() => expect(ipcMocks.write).toHaveBeenCalled());
  });

  it("blocks未承認ではスキップできず、既存の共通指定は上書きしない", async () => {
    await prepareProjectStore();
    const created = useFilmProjectStore.getState().createProject(
      "雨上がりの駅",
      "気持ちを渡す",
      "seedance-2.5",
    );

    expect(useFilmProjectStore.getState().approveLookLenient()).toBe(false);
    markBlocksApproved(created.id, "手作業で保存した共通指定");
    expect(useFilmProjectStore.getState().approveLookLenient()).toBe(true);

    const updated = useFilmProjectStore.getState().projects.find((item) => item.id === created.id);
    expect(updated?.stylePrefix).toBe("手作業で保存した共通指定");
  });

  it("既存approveLookは見た目・共通指定・素材が空なら引き続き失敗する", async () => {
    await prepareProjectStore();
    const created = useFilmProjectStore.getState().createProject(
      "雨上がりの駅",
      "気持ちを渡す",
      "seedance-2.5",
    );
    markBlocksApproved(created.id);

    expect(useFilmProjectStore.getState().approveLook()).toBe(false);
    const unchanged = useFilmProjectStore.getState().projects.find((item) => item.id === created.id);
    expect(unchanged?.phase).toBe(3);
    expect(unchanged?.approvals.look).toBeNull();
    expect(unchanged?.stylePrefix).toBe("");
  });

  it("approveLookLenient後は素材ゼロでも⑤へ進める", async () => {
    await prepareProjectStore();
    const created = useFilmProjectStore.getState().createProject(
      "雨上がりの駅",
      "気持ちを渡す",
      "seedance-2.5",
    );
    markBlocksApproved(created.id);

    expect(useFilmProjectStore.getState().approveLookLenient()).toBe(true);
    const updated = useFilmProjectStore.getState().projects.find((item) => item.id === created.id);

    expect(updated?.assets).toEqual([]);
    expect(updated && canEnterGenerationPhase(updated)).toBe(true);
  });

  it("look未承認の新規企画は素材ゼロのまま⑤へ進めない", async () => {
    await prepareProjectStore();
    const created = useFilmProjectStore.getState().createProject(
      "雨上がりの駅",
      "気持ちを渡す",
      "seedance-2.5",
    );

    expect(created.approvals.look).toBeNull();
    expect(created.assets).toEqual([]);
    expect(canEnterGenerationPhase(created)).toBe(false);
  });

  it("素材あり企画は従来どおり主要素材の確定を⑤の条件にする", () => {
    const project = projectForGeneration("seedance-2.5");
    const primaryAsset: FilmProject["assets"][number] = {
      id: "A1",
      type: "prop",
      name: "赤い傘",
      description: "主人公が持つ赤い傘",
      importance: "primary",
      usageBlockIds: ["B1"],
      status: "planned",
      promptDraft: "濡れた赤い傘を実写で",
      generatedImagePaths: [],
      canonicalImagePath: null,
      locked: false,
    };

    expect(canEnterGenerationPhase({ ...project, assets: [primaryAsset] })).toBe(false);
    expect(canEnterGenerationPhase({
      ...project,
      assets: [{ ...primaryAsset, status: "locked", locked: true }],
    })).toBe(true);
  });

  it("自由プロンプトを既存生成アクションへ渡し、結果を新しい順に表示してtakesを変えない", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce("/tmp/free-old.mp4")
      .mockResolvedValueOnce("/tmp/free-new.mp4");
    const saveBlockVideoTake = vi.fn(() => true);
    useFilmGenRun.setState({ generate, refreshConnection: vi.fn(async () => undefined) });
    useFilmProjectStore.setState({ saveBlockVideoTake });
    const project = projectForGeneration("kling-3.0");
    await renderGeneration(project);

    const card = container?.querySelector('[data-testid="free-prompt-generation-card"]');
    const blockList = [...(container?.querySelectorAll("h3") ?? [])]
      .find((heading) => heading.textContent === "ブロック一覧")?.parentElement;
    expect(card).not.toBeNull();
    expect(blockList).not.toBeNull();
    expect(card?.compareDocumentPosition(blockList as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const textarea = card?.querySelector('textarea[aria-label="自由プロンプト"]');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await act(async () => setTextareaValue(textarea as HTMLTextAreaElement, "一つ目の生プロンプト"));
    await act(async () => buttonWithin(card as ParentNode, "自由プロンプトで生成").click());

    expect(generate).toHaveBeenLastCalledWith({
      projectId: project.id,
      blockId: FREE_PROMPT_BLOCK_ID,
      serviceId: "kling-3.0",
      durationSeconds: 5,
    });
    expect(card?.textContent).toContain("/tmp/free-old.mp4");

    await act(async () => setTextareaValue(textarea as HTMLTextAreaElement, "二つ目の生プロンプト"));
    await act(async () => buttonWithin(card as ParentNode, "自由プロンプトで生成").click());

    const text = card?.textContent ?? "";
    expect(text.indexOf("/tmp/free-new.mp4")).toBeLessThan(text.indexOf("/tmp/free-old.mp4"));
    expect(saveBlockVideoTake).not.toHaveBeenCalled();
    expect(project.takes).toEqual([]);
  });

  it("packetサービスでは生成せず、自由プロンプトのコピー導線に切り替わる", async () => {
    const generate = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    useFilmGenRun.setState({ generate, refreshConnection: vi.fn(async () => undefined) });
    const project = projectForGeneration("seedance-2.5");
    await renderGeneration(project);

    const card = container?.querySelector('[data-testid="free-prompt-generation-card"]');
    const textarea = card?.querySelector('textarea[aria-label="自由プロンプト"]');
    await act(async () => setTextareaValue(textarea as HTMLTextAreaElement, "そのまま渡すプロンプト"));
    await act(async () => buttonWithin(card as ParentNode, "プロンプトをコピー").click());

    expect(writeText).toHaveBeenCalledWith("そのまま渡すプロンプト");
    expect(generate).not.toHaveBeenCalled();
    expect(buttonWithin(card as ParentNode, "できた動画を取り込む").disabled).toBe(false);
  });
});
