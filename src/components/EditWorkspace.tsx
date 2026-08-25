import { useCallback, useEffect, useRef, useState } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import {
  addEditCandidates,
  createEditSession,
} from "../lib/store/editSession";
import { beginDirectRun } from "../lib/store/generationStatus";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { AdjustPanel } from "./edit/AdjustPanel";
import { CropPanel } from "./edit/CropPanel";
import {
  EditCandidateStrip,
  isVersionSelectDisabled,
} from "./edit/EditCandidateStrip";
import {
  buildEraseInstruction,
  DEFAULT_EDIT_CANDIDATE_COUNT,
  type RegionEditMode,
  EditChatBar,
} from "./edit/EditChatBar";
import { EditFloatingPanel } from "./edit/EditFloatingPanel";
import { EditHistoryRail } from "./edit/EditHistoryRail";
import { EditToolRail, type EditToolId } from "./edit/EditToolRail";
import { EditorCanvas } from "./edit/EditorCanvas";
import { ExportDialog } from "./edit/ExportDialog";
import type { NormalizedBbox } from "./edit/RegionSelectOverlay";
import {
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

/** 1枚の画像を、候補から選びながら版として育てる編集画面。 */
export function EditWorkspace() {
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const busyTool = useEditor((state) => state.busyTool);
  const pendingOpenPath = useEditor((state) => state.pendingOpenPath);
  const {
    chooseImage,
    exportImageAs,
    applyAdjust,
    cropToRegion,
    rotateOrFlip,
    removeBackgroundOnCanvas,
    saveAsArtwork,
    saveCanvasVersion,
    applyRedlineFix,
    openImageForEditing,
  } = useEditorActions();

  const [instruction, setInstruction] = useState("");
  const [candidateCount, setCandidateCount] = useState(DEFAULT_EDIT_CANDIDATE_COUNT);
  const [regionMode, setRegionMode] = useState<RegionEditMode>("replace");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [versionInFlight, setVersionInFlight] = useState(false);
  const versionInFlightRef = useRef(false);
  const [versionRecoveryRequired, setVersionRecoveryRequired] = useState(false);
  const [savingArtwork, setSavingArtwork] = useState(false);
  const [region, setRegion] = useState<NormalizedBbox | null>(null);
  const [tool, setTool] = useState<EditToolId>("ai");
  const [adjust, setAdjust] = useState<AdjustValues>(NEUTRAL_ADJUST);
  const [exportOpen, setExportOpen] = useState(false);
  const [removingBg, setRemovingBg] = useState(false);
  const [editSession, setEditSession] = useState(() => createEditSession(sourceImagePath));
  const editSessionRef = useRef(editSession);

  const needsRegion = tool === "region" || tool === "crop";

  useEffect(() => {
    setEditSession((current) => {
      if (!sourceImagePath) {
        const next = createEditSession(null);
        editSessionRef.current = next;
        return next;
      }
      const belongsToCurrentSession =
        current.basePath === sourceImagePath ||
        current.versions.some((version) => version.path === sourceImagePath);
      const next = belongsToCurrentSession ? current : createEditSession(sourceImagePath);
      editSessionRef.current = next;
      return next;
    });
  }, [sourceImagePath]);

  useEffect(() => {
    setRegion(null);
    setTool("ai");
    setRegionMode("replace");
    setAdjust(NEUTRAL_ADJUST);
  }, [sourceImagePath]);

  const selectTool = (next: EditToolId) => {
    setTool(next);
    setRegion(null);
    setRegionMode("replace");
    setError(null);
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
    if (busy || removingBg || versionInFlightRef.current) return;
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
      setError(`${action}ませんでした。キャンバス下のメッセージを確認してください。`);
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
    setAdjust(NEUTRAL_ADJUST);
    setTool("ai");
    useToasts.getState().push({
      kind: "success",
      text: "切り抜いた画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  /** スライダー中は値だけを変え、離した時に初めて画像へ反映して版にする。 */
  const changeAdjust = (patch: Partial<AdjustValues>) => {
    setAdjust((current) => ({ ...current, ...patch }));
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
    setAdjust(NEUTRAL_ADJUST);
    useToasts.getState().push({
      kind: "success",
      text: "調整した画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  const commitAdjust = () => {
    void runAdjust(adjust);
  };

  const applyPreset = (values: AdjustValues) => {
    setAdjust(values);
    void runAdjust(values);
  };

  const resetAdjust = () => {
    setAdjust(NEUTRAL_ADJUST);
  };

  const runTransform = async (kind: TransformKind) => {
    const labelByKind: Record<TransformKind, string> = {
      "rotate-left": "90°左回転",
      "rotate-right": "90°右回転",
      "flip-h": "左右反転",
      "flip-v": "上下反転",
    };
    setError(null);
    const result = await applyCanvasOperationAsVersion(
      labelByKind[kind],
      "edit-transform",
      () => rotateOrFlip(kind),
    );
    if (result !== "applied") {
      reportCanvasOperationFailure(result, "向きを変えられ");
      return;
    }
    setAdjust(NEUTRAL_ADJUST);
    useToasts.getState().push({
      kind: "success",
      text: "向きを変えた画像を新しい版にしました。右の履歴から戻せます。",
      ttlMs: 4200,
    });
  };

  const runRemoveBackground = async () => {
    if (removingBg || versionInFlightRef.current || versionRecoveryRequired) return;
    setRemovingBg(true);
    setError(null);
    try {
      const resultPath = await removeBackgroundOnCanvas();
      if (!resultPath) {
        setError("背景を透過できませんでした。キャンバス下のメッセージを確認してください。");
      } else if (await applyVersion(resultPath, "add", "背景透過")) {
        useToasts.getState().push({
          kind: "success",
          text: "背景を透過しました。右の履歴から前の版に戻せます。",
          ttlMs: 4000,
        });
        setAdjust(NEUTRAL_ADJUST);
        setTool("ai");
      } else {
        setError("背景透過の結果を読み込めませんでした。前の版を表示しています。");
      }
    } catch (caught) {
      setError(`背景を透過できませんでした: ${String(caught)}`);
    } finally {
      setRemovingBg(false);
    }
  };

  const runExport = async (format: ExportFormat, size: ExportSize) => {
    setError(null);
    setExportOpen(false);
    await exportImageAs(format, size);
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
  const editorCanvas = useEditor((state) => state.canvas);
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
        setError("作品にできませんでした。キャンバス下のメッセージを確認してください。");
      }
    } catch (caught) {
      setError(`作品にできませんでした: ${String(caught)}`);
    } finally {
      setSavingArtwork(false);
    }
  };

  const runRegion = async () => {
    const prompt =
      regionMode === "erase"
        ? buildEraseInstruction(instruction)
        : instruction.trim();
    if (
      !sourceImagePath ||
      !prompt ||
      !region ||
      busy ||
      versionInFlightRef.current ||
      versionRecoveryRequired
    ) return;

    setBusy(true);
    setError(null);
    try {
      const liveCanvas = useEditor.getState().canvas;
      const sessionBeforeEdit = editSessionRef.current;
      if (!liveCanvas) {
        setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
        return;
      }
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
      if (result === null) return;
      if (result === "applied") {
        useToasts.getState().push({
          kind: "success",
          text: "囲んだところだけ直して、新しい版にしました。",
          ttlMs: 5200,
        });
        setInstruction("");
        setRegion(null);
      } else if (result === "version-failed") {
        setError("編集結果を保存できなかったため、変更を取り消しました。");
      } else if (result === "patch-failed") {
        setError("直せませんでした。キャンバス下のメッセージを確認してください。");
      }
    } catch (caught) {
      setError(`直せませんでした: ${String(caught)}`);
    } finally {
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
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt,
      references: [{ path: sourceImagePath, name: basename(sourceImagePath) }],
      count: candidateCount,
    });

    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: candidateCount,
        cwd: threads.cwd,
        refImagePaths: [sourceImagePath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
      });
      const generatedPaths = result.generatedPaths.filter((path) => Boolean(path?.trim()));
      if (generatedPaths.length > 0) {
        setEditSession((current) => {
          const next = addEditCandidates(current, generatedPaths);
          editSessionRef.current = next;
          return next;
        });
        track.markCompleted();
        useToasts.getState().push({
          kind: "success",
          text: `候補が${generatedPaths.length}枚できました。左下から1枚選んでください。`,
          ttlMs: 4800,
        });
        setInstruction("");
      } else {
        const detail = result.errors?.[0];
        setError(detail ? `直せませんでした: ${detail}` : "直せませんでした。");
        track.fail(detail ?? "編集に失敗しました");
      }
      if (result.failedCount > 0 && generatedPaths.length > 0) {
        setError(`一部の候補を作れませんでした。できた${generatedPaths.length}枚から選べます。`);
      }
    } catch (caught) {
      useBatches.getState().removeBatch(tempId);
      setError(`直せませんでした: ${String(caught)}`);
      track.fail(String(caught));
    } finally {
      track.done();
      setBusy(false);
    }
  };

  const run = async () => {
    if (tool === "region") await runRegion();
    else if (tool === "ai") await runWholeImage();
  };

  const canRun =
    Boolean(
      sourceImagePath &&
        (instruction.trim() || (tool === "region" && regionMode === "erase")),
    ) &&
    (tool === "ai" || (tool === "region" && region !== null)) &&
    !busy &&
    busyTool === null &&
    !versionInFlight &&
    !versionRecoveryRequired;
  const panelBusy =
    busy || removingBg || busyTool !== null || versionInFlight || versionRecoveryRequired;
  const versionSelectDisabled = isVersionSelectDisabled({
    generationBusy: busy,
    backgroundRemovalBusy: removingBg,
    toolBusy: busyTool !== null,
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
              className="rounded-md border border-indigo-400/50 bg-indigo-500/15 px-3 py-1.5 text-[11px] font-black text-indigo-100 hover:border-indigo-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              作品にする
            </button>
            <button
              type="button"
              onClick={() => setExportOpen(true)}
              disabled={panelBusy}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              書き出し
            </button>
            <button
              type="button"
              onClick={() => void chooseImage()}
              disabled={versionSelectDisabled}
              className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-indigo-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              別の画像にする
            </button>
          </>
        ) : null}
      </header>

      <div
        data-tour="editing-canvas"
        aria-disabled={versionRecoveryRequired}
        onKeyDownCapture={(event) => {
          if (!versionRecoveryRequired) return;
          const target = event.target as HTMLElement;
          if (target.closest("[data-edit-version-select]")) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        className={`relative flex min-h-0 flex-1 overflow-hidden bg-[#121212] [&>main]:!bg-[#121212] [&_.bg-pink-500]:!bg-indigo-500 [&_.border-pink-400\/50]:!border-indigo-400\/50 [&_.text-pink-300]:!text-indigo-300 ${
          versionRecoveryRequired ? "pointer-events-none" : ""
        }`}
      >
        <EditorCanvas
          panOnEmpty={!needsRegion}
          regionSelect={
            sourceImagePath && needsRegion
              ? {
                  value: region,
                  onChange: setRegion,
                  disabled: panelBusy,
                  hint:
                    tool === "crop"
                      ? "残したいところをドラッグで囲む"
                      : "直したいところをドラッグで囲む",
                }
              : undefined
          }
        />

        {sourceImagePath ? (
          <>
            {tool === "adjust" ? (
              <EditFloatingPanel title="調整" onClose={() => selectTool("ai")}>
                <AdjustPanel
                  values={adjust}
                  onChange={changeAdjust}
                  onCommit={commitAdjust}
                  onPreset={applyPreset}
                  onReset={resetAdjust}
                  onTransform={(kind) => void runTransform(kind)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : tool === "crop" ? (
              <EditFloatingPanel title="切り抜き" onClose={() => selectTool("ai")}>
                <CropPanel
                  region={region}
                  onApply={() => void runCrop()}
                  onClear={() => setRegion(null)}
                  busy={panelBusy}
                />
              </EditFloatingPanel>
            ) : null}

            {editSession.basePath && editSession.currentPath ? (
              <>
                <EditCandidateStrip
                  basePath={editSession.basePath}
                  candidates={editSession.candidates}
                  currentPath={editSession.currentPath}
                  disabled={versionSelectDisabled}
                  downloadDisabled={panelBusy}
                  onSelect={(path) => void selectSessionImage(path)}
                  onDownload={() => setExportOpen(true)}
                />
                <EditHistoryRail
                  basePath={editSession.basePath}
                  versions={editSession.versions}
                  currentPath={editSession.currentPath}
                  disabled={versionSelectDisabled}
                  onSelect={(path) => void selectSessionImage(path)}
                />
              </>
            ) : null}

            <div className="absolute bottom-6 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
              {displayedError ? (
                <p className="w-[min(560px,calc(100vw-2rem))] rounded-lg border border-red-500/40 bg-[#1b1111]/95 px-3 py-2 text-[11px] font-bold leading-4 text-red-200 shadow-xl">
                  {displayedError}
                </p>
              ) : null}
              <EditChatBar
                value={instruction}
                activeTool={tool}
                candidateCount={candidateCount}
                regionMode={regionMode}
                busy={busy || versionInFlight}
                interactionDisabled={versionRecoveryRequired}
                disabled={!canRun}
                onChange={setInstruction}
                onSubmit={() => void run()}
                onCandidateCountChange={setCandidateCount}
                onRegionModeChange={setRegionMode}
              />
              <EditToolRail
                activeTool={tool}
                disabled={panelBusy}
                removingBackground={removingBg}
                onSelect={selectTool}
                onRemoveBackground={() => void runRemoveBackground()}
              />
            </div>
          </>
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
