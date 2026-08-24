import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { images } from "../src/lib/ipc";
import {
  createEditSession,
  type EditSession,
} from "../src/lib/store/editSession";
import { useEditor } from "../src/components/edit/editor/editorStore";
import { EditorHistory } from "../src/components/edit/editor/history";
import {
  applyEditedVersion,
  applyRegionEditedVersion,
  EDITOR_RECOVERY_ERROR,
  openImageForEditing,
  runVersionOperation,
  type VersionOperationLock,
} from "../src/components/edit/editor/useEditor";

const fabricMock = vi.hoisted(() => {
  type PendingImage = {
    started: Promise<void>;
    markStarted: () => void;
    image: Promise<unknown>;
    resolve: () => void;
  };

  const failedPaths = new Set<string>();
  const openedPaths: string[] = [];
  const pendingPaths = new Map<string, PendingImage>();

  const pathFromUrl = (url: string) => {
    const decoded = decodeURIComponent(url);
    const marker = decoded.indexOf("/images/");
    return marker >= 0 ? decoded.slice(marker) : decoded;
  };

  const makeImage = (path: string) => ({
    __path: path,
    width: 640,
    height: 480,
    set(values: Record<string, unknown>) {
      Object.assign(this, values);
    },
  });

  return {
    failedPaths,
    openedPaths,
    pendingPaths,
    pathFromUrl,
    makeImage,
    reset() {
      failedPaths.clear();
      openedPaths.length = 0;
      pendingPaths.clear();
    },
    defer(path: string) {
      let markStarted = () => {};
      let resolveImage = (_image: unknown) => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const image = new Promise<unknown>((resolve) => {
        resolveImage = resolve;
      });
      const pending: PendingImage = {
        started,
        markStarted,
        image,
        resolve: () => resolveImage(makeImage(path)),
      };
      pendingPaths.set(path, pending);
      return pending;
    },
  };
});

vi.mock("fabric", () => ({
  FabricImage: {
    fromURL: (url: string) => {
      const path = fabricMock.pathFromUrl(url);
      fabricMock.openedPaths.push(path);
      if (fabricMock.failedPaths.has(path)) {
        return Promise.reject(new Error(`画像読込失敗: ${path}`));
      }
      const pending = fabricMock.pendingPaths.get(path);
      if (pending) {
        pending.markStarted();
        return pending.image;
      }
      return Promise.resolve(fabricMock.makeImage(path));
    },
  },
}));

type VersionHarness = ReturnType<typeof createVersionHarness>;

function createVersionHarness(basePath = "/images/original.png") {
  let session = createEditSession(basePath);
  let canvasPath = basePath;
  let uploadPath = "/images/region-saved.png";
  let uploadError: Error | null = null;
  let restoreFailuresRemaining = 0;
  let recoveryDisabled = false;
  let pendingRegionPatch: {
    started: Promise<void>;
    markStarted: () => void;
    wait: Promise<void>;
    resolve: () => void;
  } | null = null;
  const lock: VersionOperationLock = { current: false };
  const inFlightChanges: boolean[] = [];
  const objects: Array<Record<string, unknown>> = [];

  const canvas = {
    viewportTransform: [1, 0, 0, 1, 0, 0],
    __ggBaseSize: { width: 640, height: 480 },
    toJSON: () => ({ path: canvasPath, objects: [...objects] }),
    loadFromJSON: (snapshot: unknown) => {
      if (restoreFailuresRemaining > 0) {
        restoreFailuresRemaining -= 1;
        throw new Error("キャンバス復元失敗");
      }
      const restored = snapshot as { path: string; objects?: Array<Record<string, unknown>> };
      canvasPath = restored.path;
      objects.splice(0, objects.length, ...(restored.objects ?? []));
    },
    clear: () => {
      canvasPath = "<cleared>";
      objects.length = 0;
    },
    add: (image: { __path?: string }) => {
      canvasPath = image.__path ?? "<unknown>";
      objects.push(image as Record<string, unknown>);
    },
    getObjects: () => objects,
    getWidth: () => 1000,
    getHeight: () => 800,
    setViewportTransform: (transform: number[]) => {
      canvas.viewportTransform = [...transform];
    },
    discardActiveObject: () => {},
    requestRenderAll: () => {},
  };

  useEditor.setState({
    canvas,
    sourceImagePath: basePath,
    history: new EditorHistory(),
    canUndo: false,
    canRedo: false,
    historySuppressed: false,
    error: null,
  });
  useEditor.getState().resetHistory();

  mockIPC(async (command) => {
    if (command === "images_write_upload") {
      if (uploadError) throw uploadError;
      return uploadPath;
    }
    throw new Error(`予期しないTauri IPCです: ${command}`);
  });
  mockConvertFileSrc("macos");

  const applyWithoutLock = async (
    path: string,
    mode: "add" | "switch",
    label?: string,
    forceReload = false,
  ) =>
    applyEditedVersion({
      session,
      path,
      mode,
      label,
      openImageForEditing,
      forceReload,
      onRecoveryFailure: () => {
        recoveryDisabled = true;
      },
      commit: (sourceImagePath, nextSession) => {
        useEditor.getState().setSourceImagePath(sourceImagePath);
        session = nextSession;
      },
    });

  const apply = async (path: string, mode: "add" | "switch", label?: string) =>
    runVersionOperation(lock, (inFlight) => inFlightChanges.push(inFlight), () =>
      applyWithoutLock(path, mode, label),
    );

  const editRegion = async () => {
    const sessionBeforeEdit = session;
    return runVersionOperation(lock, (inFlight) => inFlightChanges.push(inFlight), () =>
      applyRegionEditedVersion({
        canvas,
        applyPatch: async () => {
          if (pendingRegionPatch) {
            pendingRegionPatch.markStarted();
            await pendingRegionPatch.wait;
          }
          canvasPath = `${canvasPath}#region-patch`;
          useEditor.getState().pushHistory();
          return true;
        },
        saveVersion: () =>
          images.writeUpload("edit-region.png", new Uint8Array([1, 2, 3])),
        applyVersion: (path) => applyWithoutLock(path, "add", "囲んで直す"),
        rollbackSession: () => {
          session = sessionBeforeEdit;
        },
        recoveryPath: sessionBeforeEdit.currentPath ?? basePath,
        reloadVersion: (path) =>
          openImageForEditing(path, {
            recoveryPath: null,
            onRecoveryFailure: () => {},
          }),
        onRecoveryFailure: () => {
          recoveryDisabled = true;
        },
      }),
    );
  };

  const select = async (path: string) => {
    const result = await runVersionOperation(lock, (inFlight) => inFlightChanges.push(inFlight), () =>
      applyWithoutLock(path, "switch", undefined, recoveryDisabled),
    );
    if (result === true && recoveryDisabled) {
      recoveryDisabled = false;
      useEditor.getState().setError(null);
    }
    return result;
  };

  return {
    apply,
    editRegion,
    editCanvas(suffix = "canvas-operation") {
      canvasPath = `${canvasPath}#${suffix}`;
      useEditor.getState().pushHistory();
    },
    failImage(path: string) {
      fabricMock.failedPaths.add(path);
    },
    allowImage(path: string) {
      fabricMock.failedPaths.delete(path);
    },
    failNextRestores(count = 1) {
      restoreFailuresRemaining = count;
    },
    deferRegionPatch() {
      let markStarted = () => {};
      let resolve = () => {};
      const started = new Promise<void>((done) => {
        markStarted = done;
      });
      const wait = new Promise<void>((done) => {
        resolve = done;
      });
      pendingRegionPatch = { started, markStarted, wait, resolve };
      return pendingRegionPatch;
    },
    failUpload(message = "保存失敗") {
      uploadError = new Error(message);
    },
    setUploadPath(path: string) {
      uploadPath = path;
    },
    get canvasPath() {
      return canvasPath;
    },
    get openedPaths() {
      return fabricMock.openedPaths;
    },
    get inFlight() {
      return lock.current;
    },
    get inFlightChanges() {
      return inFlightChanges;
    },
    get recoveryDisabled() {
      return recoveryDisabled;
    },
    get session(): EditSession {
      return session;
    },
    select,
  };
}

describe("AI編集版とキャンバスUndoの結合", () => {
  let harness: VersionHarness;

  beforeEach(() => {
    fabricMock.reset();
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
    harness.failImage("/images/original.png");

    await expect(harness.apply("/images/original.png", "switch")).resolves.toBe(false);

    expect(harness.session).toBe(beforeSession);
    expect(harness.session.currentPath).toBe("/images/edit-1.png");
    expect(harness.session.candidates).toEqual(["/images/edit-1.png"]);
    expect(useEditor.getState().sourceImagePath).toBe(beforeSource);
    expect(harness.canvasPath).toBe(beforeCanvas);
    expect(useEditor.getState().canUndo).toBe(true);
  });

  it("囲み編集の保存失敗では、キャンバス・path・サムネ・Undo履歴が編集前と完全一致する", async () => {
    harness.editCanvas("existing-layer");
    const beforeSession = harness.session;
    const beforeSource = useEditor.getState().sourceImagePath;
    const beforeCanvas = harness.canvasPath;
    const beforeHistory = useEditor.getState().history;
    const beforeCanUndo = useEditor.getState().canUndo;
    harness.failUpload();

    await expect(harness.editRegion()).resolves.toBe("version-failed");

    expect(harness.session).toBe(beforeSession);
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.session.candidates).toEqual([]);
    expect(useEditor.getState().sourceImagePath).toBe(beforeSource);
    expect(harness.canvasPath).toBe(beforeCanvas);
    expect(useEditor.getState().history).toBe(beforeHistory);
    expect(useEditor.getState().canUndo).toBe(beforeCanUndo);
    expect(useEditor.getState().error).toBeNull();
  });

  it("囲み編集の新版読込失敗でも、キャンバス・path・サムネ・Undo履歴が編集前と完全一致する", async () => {
    harness.editCanvas("existing-layer");
    const beforeSession = harness.session;
    const beforeSource = useEditor.getState().sourceImagePath;
    const beforeCanvas = harness.canvasPath;
    const beforeHistory = useEditor.getState().history;
    const beforeCanUndo = useEditor.getState().canUndo;
    harness.setUploadPath("/images/load-fail.png");
    harness.failImage("/images/load-fail.png");

    await expect(harness.editRegion()).resolves.toBe("version-failed");

    expect(harness.session).toBe(beforeSession);
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.session.candidates).toEqual([]);
    expect(useEditor.getState().sourceImagePath).toBe(beforeSource);
    expect(harness.canvasPath).toBe(beforeCanvas);
    expect(useEditor.getState().history).toBe(beforeHistory);
    expect(useEditor.getState().canUndo).toBe(beforeCanUndo);
    expect(useEditor.getState().error).toBeNull();
  });

  it("版の読み込み中に押した別候補は無視される", async () => {
    await harness.apply("/images/candidate-1.png", "add", "ことばで直す");
    await harness.apply("/images/candidate-2.png", "add", "ことばで直す");
    await harness.apply("/images/original.png", "switch");
    const slowLoad = fabricMock.defer("/images/candidate-1.png");
    const openedBeforeClicks = harness.openedPaths.length;

    const firstClick = harness.apply("/images/candidate-1.png", "switch");
    await slowLoad.started;
    expect(harness.inFlight).toBe(true);

    await expect(harness.apply("/images/candidate-2.png", "switch")).resolves.toBeNull();
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.openedPaths.slice(openedBeforeClicks)).toEqual(["/images/candidate-1.png"]);

    slowLoad.resolve();
    await expect(firstClick).resolves.toBe(true);
    expect(harness.session.currentPath).toBe("/images/candidate-1.png");
    expect(harness.inFlight).toBe(false);
    expect(harness.inFlightChanges.slice(-2)).toEqual([true, false]);
  });

  it("復元失敗時は現在の版をファイルから再読込して立て直す", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.failUpload();
    harness.failNextRestores();

    await expect(harness.editRegion()).resolves.toBe("version-failed");

    expect(harness.openedPaths).toEqual(["/images/original.png"]);
    expect(harness.canvasPath).toBe("/images/original.png");
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.recoveryDisabled).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "囲み編集前のキャンバス復元に失敗したため、現在の版を再読込します。",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("復元も再読込も失敗すると無効化し、版クリックの再読込成功で復帰する", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.failUpload();
    harness.failNextRestores();
    harness.failImage("/images/original.png");

    await expect(harness.editRegion()).resolves.toBe("recovery-failed");

    expect(harness.recoveryDisabled).toBe(true);
    expect(useEditor.getState().error).toBe(EDITOR_RECOVERY_ERROR);
    expect(harness.session.currentPath).toBe("/images/original.png");

    harness.allowImage("/images/original.png");
    await expect(harness.select("/images/original.png")).resolves.toBe(true);

    expect(harness.recoveryDisabled).toBe(false);
    expect(useEditor.getState().error).toBeNull();
    expect(harness.canvasPath).toBe("/images/original.png");
    expect(harness.openedPaths).toEqual([
      "/images/original.png",
      "/images/original.png",
    ]);
    expect(consoleError).toHaveBeenCalledWith(
      "現在の版の再読込にも失敗したため、編集を無効化します。",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("囲み編集のパッチ実行中に押した候補は全工程ロックで無視される", async () => {
    await harness.apply("/images/candidate-1.png", "add", "ことばで直す");
    await harness.apply("/images/original.png", "switch");
    const patch = harness.deferRegionPatch();
    const openedBeforeClicks = harness.openedPaths.length;

    const regionEdit = harness.editRegion();
    await patch.started;
    expect(harness.inFlight).toBe(true);

    await expect(harness.apply("/images/candidate-1.png", "switch")).resolves.toBeNull();
    expect(harness.session.currentPath).toBe("/images/original.png");
    expect(harness.openedPaths).toHaveLength(openedBeforeClicks);

    patch.resolve();
    await expect(regionEdit).resolves.toBe("applied");
    expect(harness.session.currentPath).toBe("/images/region-saved.png");
    expect(harness.inFlight).toBe(false);
  });
});
