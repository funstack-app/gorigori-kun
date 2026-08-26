import { useCallback, useEffect, useRef, useState } from "react";

import { editExport, images as imagesIpc } from "../lib/ipc";
import { EDIT_DIRECT_SOURCE_TAG_PREFIX } from "../lib/store/batches";
import {
  addEditCandidates,
  createEditSession,
} from "../lib/store/editSession";
import { beginDirectRun } from "../lib/store/generationStatus";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { AdjustPanel } from "./edit/AdjustPanel";
import {
  ResizeActionBar,
  ResizePanel,
  type ResizeMode,
} from "./edit/CropPanel";
import { isVersionSelectDisabled } from "./edit/EditCandidateStrip";
import {
  buildEraseInstruction,
  DEFAULT_EDIT_CANDIDATE_COUNT,
  type RegionEditMode,
  type RegionSelectionMode,
  EditChatBar,
} from "./edit/EditChatBar";
import { EditFloatingPanel } from "./edit/EditFloatingPanel";
import { EditHistoryRail } from "./edit/EditHistoryRail";
import {
  MagnificToolPanel,
  type MagnificPanelTool,
} from "./edit/MagnificToolPanels";
import { EditToolRail, type EditToolId } from "./edit/EditToolRail";
import { EditorCanvas, EditorZoomControls } from "./edit/EditorCanvas";
import type { BrushSelectOverlayHandle } from "./edit/BrushSelectOverlay";
import { ExportDialog } from "./edit/ExportDialog";
import { RestylePanel } from "./edit/RestylePanel";
import type { NormalizedBbox } from "./edit/RegionSelectOverlay";
import {
  buildCameraPrompt,
  buildExpandPrompt,
  buildRelightPrompt,
  buildRestylePrompt,
  centeredCropRegion,
  cropPixelSizeForAspect,
  MAGNIFIC_ASPECT_RATIOS,
  parseAspectRatio,
  type CropAspectRatio,
  type MagnificAspectRatio,
} from "./edit/editToolLogic";
import {
  isNeutralAdjust,
  NEUTRAL_ADJUST,
  type AdjustValues,
} from "./edit/editor/adjustFilters";
import type { TransformKind } from "./edit/editor/canvasTransforms";
import { useEditor } from "./edit/editor/editorStore";
import type { ExportFormat, ExportSize } from "./edit/editor/exportImage";
import {
  applyEditedVersion,
  applyRegionEditedVersion,
  EDITOR_RECOVERY_ERROR,
  runVersionOperation,
  setEditorRecoveryFailureHandler,
  useEditorActions,
} from "./edit/editor/useEditor";

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type GeneratedPanelTool = Extract<EditToolId, MagnificPanelTool>;
type GeneratedEditTool = GeneratedPanelTool | "expand" | "restyle";

const GENERATED_TOOL_LABELS: Record<GeneratedEditTool, string> = {
  expand: "画像拡張",
  restyle: "リスタイル",
  camera: "カメラ",
  relight: "ライティング",
};

const GENERATED_TOOL_SUCCESS_TEXT: Record<GeneratedEditTool, string> = {
  expand: "広げた画像",
  restyle: "リスタイルした画像",
  camera: "カメラを変えた画像",
  relight: "光を調整した画像",
};

function isGeneratedPanelTool(tool: EditToolId): tool is GeneratedPanelTool {
  return tool === "camera" || tool === "relight";
}

function readEditorImageSize(canvas: unknown): { width: number; height: number } | null {
  const size = (canvas as { __ggBaseSize?: { width: number; height: number } } | null)
    ?.__ggBaseSize;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** 1枚の画像を、候補から選びながら版として育てる編集画面。 */
export function EditWorkspace() {
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const busyTool = useEditor((state) => state.busyTool);
  const pendingOpenPath = useEditor((state) => state.pendingOpenPath);
  const editorCanvas = useEditor((state) => state.canvas);
  const editorRevision = useEditor((state) => state.revision);
  const imageSize = readEditorImageSize(editorCanvas);
  void editorRevision;
  const {
    chooseImage,
    exportImageAs,
    applyAdjust,
    cropToRegion,
    rotateOrFlip,
    saveAsArtwork,
    saveCanvasVersion,
    applyRedlineFix,
    openImageForEditing,
  } = useEditorActions();

  const [instruction, setInstruction] = useState("");
  const [candidateCount, setCandidateCount] = useState(DEFAULT_EDIT_CANDIDATE_COUNT);
  const [regionMode, setRegionMode] = useState<RegionEditMode>("replace");
  const [regionSelectionMode, setRegionSelectionMode] =
    useState<RegionSelectionMode>("rectangle");
  const [brushSize, setBrushSize] = useState(40);
  const [brushEraser, setBrushEraser] = useState(false);
  const [brushHasStrokes, setBrushHasStrokes] = useState(false);
  const brushOverlayRef = useRef<BrushSelectOverlayHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionInFlight, setVersionInFlight] = useState(false);
  const versionInFlightRef = useRef(false);
  const [versionRecoveryRequired, setVersionRecoveryRequired] = useState(false);
  const [savingArtwork, setSavingArtwork] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [region, setRegion] = useState<NormalizedBbox | null>(null);
  const [tool, setTool] = useState<EditToolId>("ai");
  const [resizeMode, setResizeMode] = useState<ResizeMode>("expand");
  const [cropAspect, setCropAspect] = useState<CropAspectRatio>("1:1");
  const [expandAspect, setExpandAspect] = useState<MagnificAspectRatio>("16:9");
  const [cropWidth, setCropWidth] = useState(1);
  const [cropHeight, setCropHeight] = useState(1);
  const [expandPrompt, setExpandPrompt] = useState("");
  const [adjust, setAdjust] = useState<AdjustValues>(NEUTRAL_ADJUST);
  const adjustRef = useRef<AdjustValues>(NEUTRAL_ADJUST);
  const adjustPreviewTokenRef = useRef(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [generatedEditBusyTool, setGeneratedEditBusyTool] =
    useState<GeneratedEditTool | null>(null);
  const [editSession, setEditSession] = useState(() => createEditSession(sourceImagePath));
  const editSessionRef = useRef(editSession);

  const needsRegion = tool === "region";

  const clearBrushSelection = useCallback(() => {
    brushOverlayRef.current?.clear();
    setBrushHasStrokes(false);
  }, []);

  useEffect(() => {
    const current = editSessionRef.current;
    const belongsToCurrentSession = Boolean(
      sourceImagePath &&
        (current.basePath === sourceImagePath ||
          current.versions.some((version) => version.path === sourceImagePath)),
    );
    setEditSession(() => {
      if (!sourceImagePath) {
        const next = createEditSession(null);
        editSessionRef.current = next;
        return next;
      }
      const next = belongsToCurrentSession ? current : createEditSession(sourceImagePath);
      editSessionRef.current = next;
      return next;
    });
    // 実行のたびにツールパネルが閉じるのをやめる (2026-08-26 STΛCK実機FB)。
    // 同じ画像の版の行き来ではツール選択・パネル設定を維持し、別の画像を開いた
    // ときだけ全初期化する。範囲と調整スライダーは新しい版に焼き込み済みのため
    // 毎回リセットする (二重適用防止)。
    setRegion(null);
    clearBrushSelection();
    adjustPreviewTokenRef.current += 1;
    adjustRef.current = NEUTRAL_ADJUST;
    setAdjust(NEUTRAL_ADJUST);
    if (!belongsToCurrentSession) {
      setTool("ai");
      setRegionMode("replace");
      setRegionSelectionMode("rectangle");
      setBrushSize(40);
      setBrushEraser(false);
      setResizeMode("expand");
      setCropAspect("1:1");
      setExpandAspect("16:9");
      setExpandPrompt("");
    }
  }, [clearBrushSelection, sourceImagePath]);

  useEffect(() => {
    if (!imageSize) return;
    const size = cropPixelSizeForAspect(imageSize.width, imageSize.height, 1);
    setCropWidth(size.width);
    setCropHeight(size.height);
  }, [sourceImagePath, imageSize?.width, imageSize?.height]);

  /** 最新値だけが最後に残るよう、遅れて終わったプレビューは現在値で上書きする。 */
  const previewAdjust = (values: AdjustValues) => {
    const token = ++adjustPreviewTokenRef.current;
    adjustRef.current = values;
    setAdjust(values);
    void applyAdjust(values, false).then(() => {
      if (token !== adjustPreviewTokenRef.current) {
        void applyAdjust(adjustRef.current, false);
      }
    });
  };

  const selectTool = (next: EditToolId) => {
    if (tool === "adjust" && next !== "adjust" && !isNeutralAdjust(adjustRef.current)) {
      previewAdjust(NEUTRAL_ADJUST);
    }
    setTool(next);
    setRegion(null);
    clearBrushSelection();
    setRegionMode("replace");
    setError(null);
  };

  const setCropFrameFromPixels = (requestedWidth: number, requestedHeight: number) => {
    if (!imageSize) return;
    const next = centeredCropRegion(
      imageSize.width,
      imageSize.height,
      requestedWidth,
      requestedHeight,
    );
    if (!next) return;
    setRegion(next);
    setCropWidth(Math.max(1, Math.round(next[2] * imageSize.width)));
    setCropHeight(Math.max(1, Math.round(next[3] * imageSize.height)));
  };

  const selectCropAspect = (ratio: CropAspectRatio) => {
    setCropAspect(ratio);
    if (!imageSize) return;
    if (ratio === "custom") {
      setCropFrameFromPixels(cropWidth, cropHeight);
      return;
    }
    const aspect = parseAspectRatio(ratio) ?? 1;
    const size = cropPixelSizeForAspect(imageSize.width, imageSize.height, aspect);
    setCropFrameFromPixels(size.width, size.height);
  };

  const changeResizeMode = (next: ResizeMode) => {
    setResizeMode(next);
    if (next === "expand") {
      setRegion(null);
      return;
    }
    selectCropAspect(cropAspect);
  };

  const changeCropWidth = (width: number) => {
    setCropFrameFromPixels(width, cropHeight);
  };

  const changeCropHeight = (height: number) => {
    setCropFrameFromPixels(cropWidth, height);
  };

  const changeRegion = (next: NormalizedBbox | null) => {
    setRegion(next);
    if (!next || !imageSize || tool !== "crop") return;
    setCropWidth(Math.max(1, Math.round(next[2] * imageSize.width)));
    setCropHeight(Math.max(1, Math.round(next[3] * imageSize.height)));
  };

  const handleVersionRecoveryFailure = useCallback((_caught: unknown) => {
    setVersionRecoveryRequired(true);
    setError(EDITOR_RECOVERY_ERROR);
    useToasts.getState().push({
      kind: "error",
      text: EDITOR_RECOVERY_ERROR,
      ttlMs: 7000,
    });
  }, []);

  useEffect(() => {
    setEditorRecoveryFailureHandler(handleVersionRecoveryFailure);
    return () => setEditorRecoveryFailureHandler(null);
  }, [handleVersionRecoveryFailure]);

  const applyVersionWithoutLock = async (
    path: string,
    mode: "add" | "switch",
    label?: string,
    options: { showFailureToast?: boolean; forceReload?: boolean } = {},
  ): Promise<boolean> => {
    let recoveryFailed = false;
    const applied = await applyEditedVersion({
      session: editSessionRef.current,
      path,
      mode,
      label,
      openImageForEditing,
      forceReload: options.forceReload,
      onRecoveryFailure: (caught) => {
        recoveryFailed = true;
        handleVersionRecoveryFailure(caught);
      },
      commit: (nextSourcePath, nextSession) => {
        useEditor.getState().setSourceImagePath(nextSourcePath);
        editSessionRef.current = nextSession;
        setEditSession(nextSession);
      },
    });
    if (!applied && !recoveryFailed && options.showFailureToast !== false) {
      useToasts.getState().push({
        kind: "error",
        text: "画像を読み込めませんでした。前の版を表示したままにしています。",
        ttlMs: 4800,
      });
    }
    return applied;
  };

  const applyVersion = async (
    path: string,
    mode: "add" | "switch",
    label?: string,
    options: { showFailureToast?: boolean; forceReload?: boolean } = {},
  ): Promise<boolean> => {
    const applied = await runVersionOperation(
      versionInFlightRef,
      setVersionInFlight,
      () => applyVersionWithoutLock(path, mode, label, options),
    );
    return applied ?? false;
  };

  /** 未選択候補はここで初めて版になる。既存版と元画像は表示だけを切り替える。 */
  const selectSessionImage = async (path: string) => {
    if (
      busy ||
      generatedEditBusyTool !== null ||
      versionInFlightRef.current
    ) return;
    const session = editSessionRef.current;
    const isExistingVersion =
      path === session.basePath || session.versions.some((version) => version.path === path);
    const isCandidate = session.candidates.includes(path);
    if (!isExistingVersion && !isCandidate) return;

    const applied = await applyVersion(
      path,
      isExistingVersion ? "switch" : "add",
      isExistingVersion ? undefined : "ことばで直す",
      { forceReload: versionRecoveryRequired },
    );
    if (applied && versionRecoveryRequired) {
      setVersionRecoveryRequired(false);
      setError(null);
      useEditor.getState().setError(null);
    }
  };

  /**
   * ローカルのキャンバス操作を「操作→PNG保存→新版読込」の一まとまりにする。
   * どこかで失敗した場合は、D-1 の二段復元で操作前へ戻す。
   */
  const applyCanvasOperationAsVersion = async (
    label: string,
    namePrefix: string,
    operation: () => Promise<boolean>,
  ) => {
    if (!sourceImagePath || versionInFlightRef.current || versionRecoveryRequired) return null;
    const liveCanvas = useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
      return "patch-failed" as const;
    }
    const sessionBeforeEdit = editSessionRef.current;
    return runVersionOperation(versionInFlightRef, setVersionInFlight, () =>
      applyRegionEditedVersion({
        canvas: liveCanvas,
        applyPatch: operation,
        saveVersion: () => saveCanvasVersion(namePrefix),
        applyVersion: (path) =>
          applyVersionWithoutLock(path, "add", label, { showFailureToast: false }),
        rollbackSession: () => {
          editSessionRef.current = sessionBeforeEdit;
          setEditSession(sessionBeforeEdit);
        },
        recoveryPath: sessionBeforeEdit.currentPath ?? sourceImagePath,
        reloadVersion: (path) =>
          openImageForEditing(path, {
            recoveryPath: null,
            onRecoveryFailure: () => {},
          }),
        onRecoveryFailure: handleVersionRecoveryFailure,
      }),
    );
  };

  const reportCanvasOperationFailure = (
    result: Awaited<ReturnType<typeof applyCanvasOperationAsVersion>>,
    action: string,
  ) => {
    if (result === "version-failed") {
      setError(`${action}結果を版として保存できなかったため、変更を取り消しました。`);
    } else if (result === "patch-failed") {
      setError(`${action}ませんでした。画像を開き直してお試しください。`);
    }
  };

  const runCrop = async () => {
    if (!region) return;
    setError(null);
    const result = await applyCanvasOperationAsVersion(
      "切り抜き",
      "edit-crop",
      () => cropToRegion(region),
    );
    if (result !== "applied") {
      reportCanvasOperationFailure(result, "切り抜け");
      return;
    }
    setRegion(null);
    adjustRef.current = NEUTRAL_ADJUST;
    setAdjust(NEUTRAL_ADJUST);
    setTool("ai");
    useToasts.getState().push({
      kind: "success",
      text: "切り抜いた画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  const changeAdjust = (patch: Partial<AdjustValues>) => {
    previewAdjust({ ...adjustRef.current, ...patch });
  };

  const runAdjust = async (values: AdjustValues, label = "調整") => {
    setError(null);
    const result = await applyCanvasOperationAsVersion(
      label,
      "edit-adjust",
      () => applyAdjust(values, false),
    );
    if (result !== "applied") {
      reportCanvasOperationFailure(result, "調整でき");
      return;
    }
    adjustPreviewTokenRef.current += 1;
    adjustRef.current = NEUTRAL_ADJUST;
    setAdjust(NEUTRAL_ADJUST);
    useToasts.getState().push({
      kind: "success",
      text: "調整した画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  const applyPreset = (values: AdjustValues) => {
    previewAdjust(values);
  };

  const resetAdjust = () => {
    previewAdjust(NEUTRAL_ADJUST);
  };

  const runTransform = async (kind: TransformKind) => {
    const labelByKind: Record<TransformKind, string> = {
      "rotate-left": "90°左回転",
      "rotate-right": "90°右回転",
      "flip-h": "左右反転",
      "flip-v": "上下反転",
    };
    setError(null);
    // 未適用の色調プレビューは回転・反転へ混ぜない。「適用」だけが焼き込み口。
    adjustPreviewTokenRef.current += 1;
    adjustRef.current = NEUTRAL_ADJUST;
    setAdjust(NEUTRAL_ADJUST);
    const result = await applyCanvasOperationAsVersion(
      labelByKind[kind],
      "edit-transform",
      async () => {
        if (!(await applyAdjust(NEUTRAL_ADJUST, false))) return false;
        return rotateOrFlip(kind);
      },
    );
    if (result !== "applied") {
      reportCanvasOperationFailure(result, "向きを変えられ");
      return;
    }
    adjustRef.current = NEUTRAL_ADJUST;
    setAdjust(NEUTRAL_ADJUST);
    useToasts.getState().push({
      kind: "success",
      text: "向きを変えた画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  const runExport = async (format: ExportFormat, size: ExportSize) => {
    setError(null);
    setExportOpen(false);
    await exportImageAs(format, size);
  };

  const runGeneratedEdit = async (
    editTool: GeneratedEditTool,
    prompt: string,
    options: { aspect?: MagnificAspectRatio; enforceAspect?: boolean } = {},
  ) => {
    if (
      !sourceImagePath ||
      !prompt.trim() ||
      busy ||
      busyTool !== null ||
      generatedEditBusyTool !== null ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

    const label = GENERATED_TOOL_LABELS[editTool];
    const track = beginDirectRun("aiEdit", 1);
    const threads = useThreads.getState();
    setGeneratedEditBusyTool(editTool);
    setError(null);
    track.markStarted();
    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: 1,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
        sourceTag: `${EDIT_DIRECT_SOURCE_TAG_PREFIX}${track.id}`,
        maxAttempts: 1,
        ...options,
      });
      const resultPath = result.generatedPaths.find((path) => Boolean(path?.trim()));
      if (!resultPath) {
        track.fail(result.errors?.[0] ?? `${label}の結果画像を受け取れませんでした。`);
        return;
      }
      if (!(await applyVersion(resultPath, "add", label))) {
        track.fail(`${label}の結果を新しい版として読み込めませんでした。`);
        return;
      }
      track.markCompleted();
      if (editTool === "expand") setExpandPrompt("");
      if (editTool === "restyle") setInstruction("");
      adjustRef.current = NEUTRAL_ADJUST;
      setAdjust(NEUTRAL_ADJUST);
      useToasts.getState().push({
        kind: "success",
        text: `${GENERATED_TOOL_SUCCESS_TEXT[editTool]}を新しい版にしました。右の履歴から戻せます。`,
        ttlMs: 4400,
      });
    } catch (caught) {
      track.fail(String(caught));
    } finally {
      track.done();
      setGeneratedEditBusyTool(null);
    }
  };

  const runResize = async () => {
    if (resizeMode === "crop") {
      await runCrop();
      return;
    }
    await runGeneratedEdit("expand", buildExpandPrompt(expandAspect, expandPrompt), {
      aspect: expandAspect,
      enforceAspect: true,
    });
  };

  const runRestyle = async () => {
    const style = instruction.trim();
    if (!style) return;
    await runGeneratedEdit("restyle", buildRestylePrompt(style));
  };

  const runGeneratedPanelEdit = async (
    editTool: GeneratedPanelTool,
    params: Record<string, unknown>,
  ) => {
    const numberParam = (key: string, fallback: number) => {
      const value = params[key];
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    };
    if (editTool === "camera") {
      await runGeneratedEdit(
        editTool,
        buildCameraPrompt(
          numberParam("rotate", 45),
          numberParam("vertical", 0),
          numberParam("closeup", 5),
        ),
      );
      return;
    }
    await runGeneratedEdit(
      editTool,
      buildRelightPrompt(
        numberParam("azimuth", 0),
        numberParam("elevation", 0),
        numberParam("intensity", 5),
        typeof params.color === "string" ? params.color : "#ffffff",
      ),
    );
  };

  useEffect(() => {
    if (!pendingOpenPath) return;
    const path = pendingOpenPath;
    useEditor.getState().setPendingOpenPath(null);
    void openImageForEditing(path);
  }, [pendingOpenPath, openImageForEditing]);

  // タブ切替で戻るとキャンバスは作り直され空になるが、store には開いていた版が
  // 残っている (右上の版レールだけ表示される状態)。新しいキャンバスが空のままなら
  // 開いていた版を自動で再表示する。ifIdleOnly で通常読込とのレースを防ぐ。
  useEffect(() => {
    if (!editorCanvas) return;
    const state = useEditor.getState();
    if (!state.sourceImagePath || state.pendingOpenPath) return;
    const objects =
      (editorCanvas as { getObjects?: () => unknown[] }).getObjects?.() ?? [];
    if (objects.length > 0) return;
    void openImageForEditing(state.sourceImagePath, {
      ifIdleOnly: true,
      recoveryPath: null,
    });
  }, [editorCanvas, openImageForEditing]);

  const saveArtwork = async () => {
    if (savingArtwork) return;
    setSavingArtwork(true);
    setError(null);
    try {
      const saved = await saveAsArtwork();
      if (saved) {
        useToasts.getState().push({
          kind: "success",
          text: "作品にしました。制作タブのギャラリーに入っています。",
          ttlMs: 4000,
        });
      } else {
        setError("作品にできませんでした。画像を開き直してお試しください。");
      }
    } catch (caught) {
      setError(`作品にできませんでした: ${String(caught)}`);
    } finally {
      setSavingArtwork(false);
    }
  };

  const saveCurrentVersionToLibrary = async () => {
    if (!sourceImagePath || savingToLibrary) return;
    setSavingToLibrary(true);
    setError(null);
    try {
      await editExport.saveToLibrary(sourceImagePath);
      useToasts.getState().push({
        kind: "success",
        text: "ライブラリに保存しました",
        ttlMs: 4000,
      });
    } catch (caught) {
      setError(`ライブラリに保存できませんでした: ${String(caught)}`);
    } finally {
      setSavingToLibrary(false);
    }
  };

  /** ブラシの実寸マスクを既存 generateBatch へ渡し、結果を候補レールへ並べる。 */
  const runBrushRegion = async (prompt: string) => {
    if (
      !sourceImagePath ||
      !prompt ||
      !brushHasStrokes ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

    const maskDataUrl = brushOverlayRef.current?.getMaskDataUrl();
    if (!maskDataUrl) {
      setBrushHasStrokes(false);
      setError("直したいところをブラシで塗ってください。");
      return;
    }

    const threads = useThreads.getState();
    const tempId = `brush-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const track = beginDirectRun("aiEdit", candidateCount, tempId);
    setBusy(true);
    setError(null);
    track.markStarted();
    try {
      // マスクも生成結果も watcher 対象外の edit-session/ に置く。
      const maskPath = await editExport.writeSession(
        `brush-mask-${Date.now()}.png`,
        dataUrlToBytes(maskDataUrl),
      );
      const result = await imagesIpc.generateBatch({
        prompt,
        count: candidateCount,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        maskPaths: [maskPath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
        sourceTag: `${EDIT_DIRECT_SOURCE_TAG_PREFIX}${track.id}`,
      });
      const generatedPaths = result.generatedPaths.filter((path) => Boolean(path?.trim()));
      if (generatedPaths.length > 0) {
        setEditSession((current) => {
          const next = addEditCandidates(current, generatedPaths);
          editSessionRef.current = next;
          return next;
        });
        generatedPaths.forEach(() => track.markCompleted());
        useToasts.getState().push({
          kind: "success",
          text: `塗ったところを直した候補が${generatedPaths.length}枚できました。右の「候補」から選んでください。`,
          ttlMs: 5200,
        });
        setInstruction("");
        clearBrushSelection();
      } else {
        track.fail(result.errors?.[0] ?? "ブラシで選んだ部分を編集できませんでした。");
      }
      if (result.failedCount > 0 && generatedPaths.length > 0) {
        track.fail(result.errors?.[0] ?? "一部の編集候補を作れませんでした。");
      }
    } catch (caught) {
      track.fail(String(caught));
    } finally {
      track.done();
      setBusy(false);
    }
  };

  const runRegion = async () => {
    const prompt =
      regionMode === "erase"
        ? buildEraseInstruction(instruction)
        : instruction.trim();
    if (regionSelectionMode === "brush") {
      await runBrushRegion(prompt);
      return;
    }
    if (
      !sourceImagePath ||
      !prompt ||
      !region ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

    const liveCanvas = useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
      return;
    }

    const track = beginDirectRun("aiEdit", 1);
    setBusy(true);
    setError(null);
    track.markStarted();
    try {
      const sessionBeforeEdit = editSessionRef.current;
      const result = await runVersionOperation(
        versionInFlightRef,
        setVersionInFlight,
        () =>
          applyRegionEditedVersion({
            canvas: liveCanvas,
            applyPatch: () => applyRedlineFix(sourceImagePath, region, prompt),
            saveVersion: () => saveCanvasVersion("edit-region"),
            applyVersion: (path) =>
              applyVersionWithoutLock(path, "add", "囲んで直す", {
                showFailureToast: false,
              }),
            rollbackSession: () => {
              editSessionRef.current = sessionBeforeEdit;
              setEditSession(sessionBeforeEdit);
            },
            recoveryPath: sessionBeforeEdit.currentPath ?? sourceImagePath,
            reloadVersion: (path) =>
              openImageForEditing(path, {
                recoveryPath: null,
                onRecoveryFailure: () => {},
              }),
            onRecoveryFailure: handleVersionRecoveryFailure,
          }),
      );
      if (result === null) {
        track.fail("部分編集を開始できませんでした。");
        return;
      }
      if (result === "applied") {
        track.markCompleted();
        useToasts.getState().push({
          kind: "success",
          text: "囲んだところだけ直して、新しい版にしました。",
          ttlMs: 5200,
        });
        setInstruction("");
        setRegion(null);
      } else if (result === "version-failed") {
        track.fail("編集結果を保存できなかったため、変更を取り消しました。");
      } else if (result === "patch-failed") {
        const detail = useEditor.getState().error ?? "部分編集を実行できませんでした。";
        track.fail(detail);
        if (detail !== EDITOR_RECOVERY_ERROR) useEditor.getState().setError(null);
      } else if (result === "recovery-failed") {
        track.fail(EDITOR_RECOVERY_ERROR);
      }
    } catch (caught) {
      track.fail(String(caught));
    } finally {
      track.done();
      setBusy(false);
    }
  };

  /** 全体編集は結果を開かず、まず候補だけを並べる。 */
  const runWholeImage = async () => {
    const prompt = instruction.trim();
    if (
      tool !== "ai" ||
      !sourceImagePath ||
      !prompt ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

    const threads = useThreads.getState();
    const tempId = `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setBusy(true);
    setError(null);

    const track = beginDirectRun("aiEdit", candidateCount, tempId);
    track.markStarted();

    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: candidateCount,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
        sourceTag: `${EDIT_DIRECT_SOURCE_TAG_PREFIX}${track.id}`,
      });
      const generatedPaths = result.generatedPaths.filter((path) => Boolean(path?.trim()));
      if (generatedPaths.length > 0) {
        setEditSession((current) => {
          const next = addEditCandidates(current, generatedPaths);
          editSessionRef.current = next;
          return next;
        });
        generatedPaths.forEach(() => track.markCompleted());
        useToasts.getState().push({
          kind: "success",
          text: `候補が${generatedPaths.length}枚できました。右の「候補」から1枚選んでください。`,
          ttlMs: 4800,
        });
        setInstruction("");
      } else {
        const detail = result.errors?.[0];
        track.fail(detail ?? "編集に失敗しました");
      }
      if (result.failedCount > 0 && generatedPaths.length > 0) {
        track.fail(result.errors?.[0] ?? "一部の編集候補を作れませんでした。");
      }
    } catch (caught) {
      track.fail(String(caught));
    } finally {
      track.done();
      setBusy(false);
    }
  };

  const run = async () => {
    if (tool === "region") await runRegion();
    else if (tool === "ai") await runWholeImage();
    else if (tool === "restyle") await runRestyle();
  };

  const regionSelectionReady =
    regionSelectionMode === "brush" ? brushHasStrokes : region !== null;
  const canRun =
    Boolean(
      sourceImagePath &&
        (instruction.trim() || (tool === "region" && regionMode === "erase")),
    ) &&
    (tool === "ai" ||
      tool === "restyle" ||
      (tool === "region" && regionSelectionReady)) &&
    !busy &&
    busyTool === null &&
    generatedEditBusyTool === null &&
    !versionInFlight &&
    !versionRecoveryRequired;
  const panelBusy =
    busy ||
    busyTool !== null ||
    generatedEditBusyTool !== null ||
    versionInFlight ||
    versionRecoveryRequired;
  const versionSelectDisabled = isVersionSelectDisabled({
    generationBusy: busy,
    toolBusy: busyTool !== null || generatedEditBusyTool !== null,
    versionInFlight,
    versionRecoveryRequired,
  });
  const displayedError = versionRecoveryRequired ? EDITOR_RECOVERY_ERROR : error;

  return (
    <div
      data-tour="editing-workspace"
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#121212]"
    >
      <header
        data-tour="editing-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#1b1b1b] px-3"
      >
        <span
          className="min-w-0 flex-1 truncate text-xs font-bold text-neutral-300"
          title={sourceImagePath ?? undefined}
        >
          {sourceImagePath ? basename(sourceImagePath) : "画像未選択"}
        </span>
        {sourceImagePath ? (
          <>
            <button
              type="button"
              onClick={() => void saveArtwork()}
              disabled={panelBusy || savingArtwork}
              className="rounded-md border border-pink-400/50 bg-pink-500/15 px-3 py-1.5 text-[11px] font-black text-pink-100 hover:border-pink-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              作品にする
            </button>
            <button
              type="button"
              onClick={() => void saveCurrentVersionToLibrary()}
              disabled={panelBusy || savingToLibrary}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              ライブラリに保存
            </button>
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              disabled={panelBusy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              書き出し
            </button>
            <button
              type="button"
              onClick={() => void chooseImage()}
              disabled={versionSelectDisabled}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              別の画像にする
            </button>
          </>
        ) : null}
      </header>

      <div
        className="flex min-h-0 flex-1 overflow-hidden bg-[#121212]"
        onKeyDownCapture={(event) => {
          if (!versionRecoveryRequired) return;
          const target = event.target as HTMLElement;
          if (target.closest("[data-edit-version-select]")) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div
          aria-disabled={versionRecoveryRequired}
          className={`flex min-w-0 flex-1 flex-col ${
            versionRecoveryRequired ? "pointer-events-none" : ""
          }`}
        >
          <div
            data-tour="editing-canvas"
            className="relative flex min-h-0 flex-1 overflow-hidden bg-[#121212] [&>main]:!bg-[#121212]"
          >
            <EditorCanvas
              regionSelect={
                sourceImagePath && needsRegion && regionSelectionMode === "rectangle"
                  ? {
                      value: region,
                      onChange: changeRegion,
                      disabled: panelBusy,
                      aspectRatio: null,
                      hint: "直したいところをドラッグで囲む",
                    }
                  : undefined
              }
              brushSelect={
                sourceImagePath && needsRegion && regionSelectionMode === "brush"
                  ? {
                      brushSize,
                      erasing: brushEraser,
                      disabled: panelBusy,
                      overlayRef: brushOverlayRef,
                      onHasStrokesChange: setBrushHasStrokes,
                    }
                  : undefined
              }
              cropFrame={
                sourceImagePath && tool === "crop"
                  ? {
                      mode: resizeMode,
                      value: region,
                      onChange: (bbox) => changeRegion(bbox),
                      aspectRatio:
                        cropAspect === "custom" ? null : parseAspectRatio(cropAspect),
                      expandAspect: parseAspectRatio(expandAspect) ?? 16 / 9,
                      onExpandAspectSnap: (ratio) => {
                        const hit = MAGNIFIC_ASPECT_RATIOS.find(
                          (candidate) =>
                            Math.abs((parseAspectRatio(candidate) ?? 0) - ratio) < 0.001,
                        );
                        if (hit) setExpandAspect(hit);
                      },
                      expandAspectChoices: MAGNIFIC_ASPECT_RATIOS.map(
                        (candidate) => parseAspectRatio(candidate) ?? 1,
                      ),
                      disabled: panelBusy,
                    }
                  : undefined
              }
            />

            {sourceImagePath && tool === "adjust" ? (
              <EditFloatingPanel title="調整" onClose={() => selectTool("ai")}>
                <AdjustPanel
                  imagePath={sourceImagePath}
                  values={adjust}
                  onChange={changeAdjust}
                  onApply={() => void runAdjust(adjustRef.current)}
                  onPreset={applyPreset}
                  onReset={resetAdjust}
                  onTransform={(kind) => void runTransform(kind)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : sourceImagePath && tool === "crop" ? (
              <EditFloatingPanel
                title="リサイズ"
                width="wide"
                onClose={() => selectTool("ai")}
              >
                <div className="[&_label>span]:hidden">
                  <ResizePanel
                    mode={resizeMode}
                    cropAspect={cropAspect}
                    expandAspect={expandAspect}
                    expandPrompt={expandPrompt}
                    busy={panelBusy}
                    onModeChange={changeResizeMode}
                    onCropAspectChange={selectCropAspect}
                    onExpandAspectChange={setExpandAspect}
                    onExpandPromptChange={setExpandPrompt}
                  />
                </div>
                {resizeMode === "expand" ? (
                  <p className="px-4 pb-2 text-[10px] font-bold leading-4 text-neutral-600">
                    画像拡張は8種類の比率に対応しています。カスタムpxは切り抜きで使えます。
                  </p>
                ) : null}
              </EditFloatingPanel>
            ) : sourceImagePath && tool === "restyle" ? (
              <EditFloatingPanel
                title="リスタイル"
                width="wide"
                onClose={() => selectTool("ai")}
              >
                <RestylePanel
                  imagePath={sourceImagePath}
                  value={instruction}
                  busy={panelBusy}
                  onSelect={setInstruction}
                />
              </EditFloatingPanel>
            ) : sourceImagePath && isGeneratedPanelTool(tool) ? (
              <EditFloatingPanel
                title={GENERATED_TOOL_LABELS[tool]}
                width="wide"
                onClose={() => selectTool("ai")}
              >
                <MagnificToolPanel
                  tool={tool}
                  imagePath={sourceImagePath}
                  busy={generatedEditBusyTool !== null || versionInFlight}
                  onRun={(params) => void runGeneratedPanelEdit(tool, params)}
                />
              </EditFloatingPanel>
            ) : null}
          </div>

          {sourceImagePath ? (
            <div
              data-edit-bottom-dock
              className="shrink-0 border-t border-[#2a2a2a] bg-[#151515] px-3 pb-2 pt-2"
            >
              {displayedError ? (
                <p
                  title={displayedError}
                  className="mx-auto mb-2 max-w-[560px] truncate rounded-md border border-red-500/35 bg-[#1b1111] px-3 py-1.5 text-[11px] font-bold text-red-200"
                >
                  {displayedError}
                </p>
              ) : null}
              <div className="flex justify-center">
                <EditChatBar
                  value={instruction}
                  activeTool={tool}
                  candidateCount={candidateCount}
                  regionMode={regionMode}
                  regionSelectionMode={regionSelectionMode}
                  brushSize={brushSize}
                  brushEraser={brushEraser}
                  brushHasStrokes={brushHasStrokes}
                  busy={busy || generatedEditBusyTool === "restyle" || versionInFlight}
                  interactionDisabled={versionRecoveryRequired}
                  disabled={!canRun}
                  resizeControls={
                    <ResizeActionBar
                      mode={resizeMode}
                      cropAspect={cropAspect}
                      expandAspect={expandAspect}
                      cropWidth={cropWidth}
                      cropHeight={cropHeight}
                      cropReady={region !== null}
                      busy={panelBusy}
                      connected
                      onCropAspectChange={selectCropAspect}
                      onExpandAspectChange={setExpandAspect}
                      onCropWidthChange={changeCropWidth}
                      onCropHeightChange={changeCropHeight}
                      onRun={() => void runResize()}
                    />
                  }
                  onChange={setInstruction}
                  onSubmit={() => void run()}
                  onCandidateCountChange={setCandidateCount}
                  onRegionModeChange={setRegionMode}
                  onRegionSelectionModeChange={setRegionSelectionMode}
                  onBrushSizeChange={setBrushSize}
                  onBrushEraserChange={setBrushEraser}
                  onBrushClear={clearBrushSelection}
                />
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
                <span aria-hidden />
                <EditToolRail
                  activeTool={tool}
                  disabled={panelBusy}
                  magnificConnected
                  onSelect={selectTool}
                />
                <div className="flex min-w-0 justify-end">
                  <EditorZoomControls />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {editSession.basePath && editSession.currentPath ? (
          <EditHistoryRail
            basePath={editSession.basePath}
            versions={editSession.versions}
            candidates={editSession.candidates}
            currentPath={editSession.currentPath}
            disabled={versionSelectDisabled}
            downloadDisabled={panelBusy}
            onSelect={(path) => void selectSessionImage(path)}
            onDownload={() => setExportOpen(true)}
          />
        ) : null}
      </div>

      {exportOpen && sourceImagePath ? (
        <ExportDialog
          onExport={(format, size) => void runExport(format, size)}
          onClose={() => setExportOpen(false)}
          busy={panelBusy}
        />
      ) : null}
    </div>
  );
}

export default EditWorkspace;
