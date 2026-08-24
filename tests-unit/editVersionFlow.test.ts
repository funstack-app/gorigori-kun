import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createEditSession, type EditSession } from "../src/lib/store/editSession";
import { useEditor } from "../src/components/edit/editor/editorStore";
import { EditorHistory } from "../src/components/edit/editor/history";
import {
  applyEditedVersion,
  type OpenImageForEditingOptions,
} from "../src/components/edit/editor/useEditor";

type VersionHarness = ReturnType<typeof createVersionHarness>;

function createVersionHarness(basePath = "/images/original.png") {
  let session = createEditSession(basePath);
  let canvasPath = basePath;
  const failedPaths = new Set<string>();
  const openedPaths: string[] = [];
  const canvas = {
    toJSON: () => ({ path: canvasPath }),
  };

  useEditor.setState({
    canvas,
    sourceImagePath: basePath,
    history: new EditorHistory(),
    canUndo: false,
    canRedo: false,
  });
  useEditor.getState().resetHistory();

  const openImageForEditing = vi.fn(
    async (path: string, options: OpenImageForEditingOptions = {}): Promise<boolean> => {
      openedPaths.push(path);
      if (failedPaths.has(path)) return false;
      canvasPath = path;
      useEditor.getState().resetHistory();
      if (options.commitSourcePath !== false) {
        useEditor.getState().setSourceImagePath(path);
      }
      return true;
    },
  );

  const apply = async (path: string, mode: "add" | "switch", label?: string) =>
    applyEditedVersion({
      session,
      path,
      mode,
      label,
      openImageForEditing,
      commit: (sourceImagePath, nextSession) => {
        useEditor.getState().setSourceImagePath(sourceImagePath);
        session = nextSession;
      },
    });

  return {
    apply,
    editCanvas(suffix = "canvas-operation") {
      canvasPath = `${canvasPath}#${suffix}`;
      useEditor.getState().pushHistory();
    },
    fail(path: string) {
      failedPaths.add(path);
    },
    get canvasPath() {
      return canvasPath;
    },
    get openedPaths() {
      return openedPaths;
    },
    get session(): EditSession {
      return session;
    },
  };
}

describe("AI編集版とキャンバスUndoの結合", () => {
  let harness: VersionHarness;

  beforeEach(() => {
    mockIPC((command) => {
      throw new Error(`予期しないTauri IPCです: ${command}`);
    });
    harness = createVersionHarness();
  });

  it("(a) 囲み編集から前版へ戻った後の再編集は、戻った版のpathを使う", async () => {
    await expect(harness.apply("/images/region-1.png", "add", "囲んで直す")).resolves.toBe(true);
    expect(useEditor.getState().sourceImagePath).toBe("/images/region-1.png");
    harness.editCanvas();
    expect(useEditor.getState().canUndo).toBe(true);

    await expect(harness.apply("/images/original.png", "switch")).resolves.toBe(true);
    const secondRegionInput = useEditor.getState().sourceImagePath;
    expect(secondRegionInput).toBe("/images/original.png");

    await expect(harness.apply("/images/region-2.png", "add", "囲んで直す")).resolves.toBe(true);
    expect(harness.session.currentPath).toBe("/images/region-2.png");
    expect(harness.openedPaths).toEqual([
      "/images/region-1.png",
      "/images/original.png",
      "/images/region-2.png",
    ]);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it("(b) 背景透過から履歴で戻るとsourceImagePath・currentPath・キャンバスが一致する", async () => {
    await harness.apply("/images/no-bg.png", "add", "背景透過");
    await harness.apply("/images/original.png", "switch");

    expect(useEditor.getState().sourceImagePath).toBe("/images/original.png");
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.canvasPath).toBe("/images/original.png");
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it("(c) 候補切替から囲み編集し、履歴で前版へ戻っても3状態が揃う", async () => {
    await harness.apply("/images/candidate-1.png", "add", "ことばで直す");
    await harness.apply("/images/original.png", "switch");
    await harness.apply("/images/candidate-1.png", "switch");

    const regionInput = useEditor.getState().sourceImagePath;
    expect(regionInput).toBe("/images/candidate-1.png");
    await harness.apply("/images/region-from-candidate.png", "add", "囲んで直す");
    await harness.apply("/images/candidate-1.png", "switch");

    expect(useEditor.getState().sourceImagePath).toBe("/images/candidate-1.png");
    expect(harness.session.currentPath).toBe("/images/candidate-1.png");
    expect(harness.canvasPath).toBe("/images/candidate-1.png");
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it("(d) 版切替の読込失敗ではcurrentPath・選択サムネ・source・キャンバスを変えない", async () => {
    await harness.apply("/images/edit-1.png", "add", "ことばで直す");
    const beforeSession = harness.session;
    const beforeSource = useEditor.getState().sourceImagePath;
    harness.editCanvas("text-layer");
    const beforeCanvas = harness.canvasPath;
    expect(useEditor.getState().canUndo).toBe(true);
    harness.fail("/images/original.png");

    await expect(harness.apply("/images/original.png", "switch")).resolves.toBe(false);

    expect(harness.session).toBe(beforeSession);
    expect(harness.session.currentPath).toBe("/images/edit-1.png");
    expect(harness.session.candidates).toEqual(["/images/edit-1.png"]);
    expect(useEditor.getState().sourceImagePath).toBe(beforeSource);
    expect(harness.canvasPath).toBe(beforeCanvas);
    expect(useEditor.getState().canUndo).toBe(true);
  });
});
