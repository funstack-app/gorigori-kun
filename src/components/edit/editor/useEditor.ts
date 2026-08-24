import { open } from "@tauri-apps/plugin-dialog";

import {
  editGrab,
  editInpaint,
  editMagic,
  editModels,
  editOcr,
  editSam2,
  editSegment,
  editWords,
  editExport,
  codexVision,
  images,
} from "../../../lib/ipc";
import { segmentImage } from "../../../lib/segmentation";
import { useActiveProject } from "../../../lib/store/activeProject";
import { onEditModelProgress } from "../../../lib/edit/events";
import { useEditMagic } from "../../../lib/store/editMagic";
import { useEditModels } from "../../../lib/store/editModels";
import { useProjects } from "../../../lib/store/projects";
import { useThreads } from "../../../lib/store/threads";
import {
  addEditVersion,
  confirmEditCandidate,
  switchEditVersion,
  type EditSession,
} from "../../../lib/store/editSession";
import type { EditorTool } from "./editorStore";
import { OBJECT_COUNT_BY_MODE, useEditor } from "./editorStore";
import {
  addFillRectLayer,
  addImageLayerToCanvas,
  addMaskLayerFromBase64,
  addOverlayTextLayer,
  addTextLayer,
  addTextRegionsToCanvas,
  getCanvasBaseSize,
  readOverlayTextValues,
  updateOverlayTextLayer,
  addWordLayersToCanvas,
  applyWordsResultToCanvas,
  addShapeToCanvas,
  exportCanvasPngBase64,
  replaceLayerWithDataUrl,
  showSourceImagePreview,
  SOURCE_PREVIEW_ID,
  applyGrabResultToCanvas,
  applyMagicLayerToCanvas,
  applySegmentResultToCanvas,
  removeGrabPreviewOverlay,
  showGrabPreviewOverlay,
} from "./magicLayerToFabric";
import { EditorHistory, restoreCanvas, snapshotCanvas } from "./history";
import { applyAdjustToCanvas, type AdjustValues } from "./adjustFilters";
import {
  cropCanvasToRegion,
  flattenCanvas,
  transformCanvas,
  type TransformKind,
} from "./canvasTransforms";
import {
  saveExportedImage,
  type ExportFormat,
  type ExportSize,
} from "./exportImage";
import { groupSelectedLayers, objectId, ungroupLayer } from "./layerHelpers";
import { normalizeGenre, type LayerGenre } from "../../../lib/edit/genre";
import { resolveWord, splitWordsInput } from "../../../lib/edit/wordPresets";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

export type OpenImageForEditingOptions = {
  /** false のときは、読み込み確認だけ行い sourceImagePath の確定を呼び出し側へ任せる。 */
  commitSourcePath?: boolean;
  /** 読込失敗後のスナップショット復元にも失敗したとき、ファイルから開き直す版。null は再試行済み。 */
  recoveryPath?: string | null;
  /** ファイルからの開き直しにも失敗し、安全のため編集を止める必要があることを通知する。 */
  onRecoveryFailure?: (error: unknown) => void;
};

export type VersionOperationLock = { current: boolean };

export const EDITOR_RECOVERY_ERROR = "画面の復元に失敗しました。画像を開き直してください。";

let editorRecoveryFailureHandler: ((error: unknown) => void) | null = null;

/** useEditorActions から直接画像を開く経路でも、復元不能を画面側へ通知する。 */
export function setEditorRecoveryFailureHandler(
  handler: ((error: unknown) => void) | null,
): void {
  editorRecoveryFailureHandler = handler;
}

type RegionEditedVersionResult =
  | "applied"
  | "patch-failed"
  | "version-failed"
  | "recovery-failed";

type ApplyRegionEditedVersionOptions = {
  canvas: unknown;
  applyPatch: () => Promise<boolean>;
  saveVersion: () => Promise<string | null>;
  applyVersion: (path: string) => Promise<boolean>;
  rollbackSession: () => void;
  recoveryPath: string;
  reloadVersion: (path: string) => Promise<boolean>;
  onRecoveryFailure: (error: unknown) => void;
};

type ApplyEditedVersionOptions = {
  session: EditSession;
  path: string;
  mode: "add" | "switch";
  label?: string;
  openImageForEditing: (
    path: string,
    options?: OpenImageForEditingOptions,
  ) => Promise<boolean>;
  commit: (sourceImagePath: string, session: EditSession) => void;
  forceReload?: boolean;
  onRecoveryFailure?: (error: unknown) => void;
};

/**
 * AI 編集版の追加と既存版への切替に共通する、唯一の確定経路。
 * キャンバスへ読み込めた後だけ sourceImagePath と版選択を同時に進める。
 */
export async function applyEditedVersion({
  session,
  path,
  mode,
  label,
  openImageForEditing,
  commit,
  forceReload = false,
  onRecoveryFailure,
}: ApplyEditedVersionOptions): Promise<boolean> {
  const normalizedPath = path.trim();
  if (!normalizedPath) return false;

  const nextSession = (() => {
    if (mode === "switch") return switchEditVersion(session, normalizedPath);
    const added = addEditVersion(session, normalizedPath, label ? { label } : {});
    const confirmed = confirmEditCandidate(added, normalizedPath);
    // 生成側が既存版と同じ path を返した場合も、重複追加せずその版へ切り替える。
    return added === session
      ? switchEditVersion(confirmed, normalizedPath)
      : confirmed;
  })();

  // 選択済みの版をもう一度押した場合は、履歴を無用に消さない。
  if (nextSession === session && !forceReload) return session.currentPath === normalizedPath;

  const opened = await openImageForEditing(normalizedPath, {
    commitSourcePath: false,
    recoveryPath: session.currentPath,
    onRecoveryFailure,
  });
  if (!opened) return false;

  commit(normalizedPath, nextSession);
  return true;
}

/**
 * 版の読み込みを1件ずつにする。null は「すでに別の版を読み込み中なので無視」。
 * React 外の結合テストでも、画面と同じ連打防止経路を通せるよう小さく切り出す。
 */
export async function runVersionOperation<Result>(
  lock: VersionOperationLock,
  setInFlight: (inFlight: boolean) => void,
  operation: () => Promise<Result>,
): Promise<Result | null> {
  if (lock.current) return null;
  lock.current = true;
  setInFlight(true);
  try {
    return await operation();
  } finally {
    lock.current = false;
    setInFlight(false);
  }
}

/**
 * 囲み編集を「パッチ適用 → 統合画像の保存 → 新版の読み込み」の1取引にする。
 * 途中で失敗した場合は、処理前のキャンバス・パス・Undo履歴へまとめて戻す。
 */
export async function applyRegionEditedVersion({
  canvas,
  applyPatch,
  saveVersion,
  applyVersion,
  rollbackSession,
  recoveryPath,
  reloadVersion,
  onRecoveryFailure,
}: ApplyRegionEditedVersionOptions): Promise<RegionEditedVersionResult> {
  const beforeSnapshot = snapshotCanvas(canvas);
  if (beforeSnapshot === null) return "version-failed";

  const beforeState = useEditor.getState();
  const beforeSourcePath = beforeState.sourceImagePath;
  const beforeHistory = beforeState.history;
  const beforeCanUndo = beforeState.canUndo;
  const beforeCanRedo = beforeState.canRedo;
  const beforeHistorySuppressed = beforeState.historySuppressed;
  const beforeSelectedLayerId = beforeState.selectedLayerId;
  const beforeMessage = beforeState.message;
  const beforeError = beforeState.error;
  const beforeViewport = Array.isArray(
    (canvas as { viewportTransform?: number[] }).viewportTransform,
  )
    ? [...((canvas as { viewportTransform: number[] }).viewportTransform)]
    : null;
  const beforeBaseSize = (canvas as { __ggBaseSize?: { width: number; height: number } })
    .__ggBaseSize;

  // 取引中の履歴は仮の箱へ隔離する。失敗時は元の履歴オブジェクトをそのまま戻せる。
  const transactionHistory = new EditorHistory();
  transactionHistory.reset(beforeSnapshot);
  useEditor.setState({ history: transactionHistory, canUndo: false, canRedo: false });

  const rollback = async (): Promise<boolean> => {
    let restoreError: unknown = null;
    useEditor.getState().setHistorySuppressed(true);
    try {
      await restoreCanvas(canvas, beforeSnapshot);
      if (beforeViewport) {
        (canvas as { setViewportTransform?: (transform: number[]) => void })
          .setViewportTransform?.(beforeViewport);
      }
      (canvas as { __ggBaseSize?: { width: number; height: number } }).__ggBaseSize =
        beforeBaseSize;
      (canvas as { requestRenderAll?: () => void }).requestRenderAll?.();
    } catch (caught) {
      restoreError = caught;
      console.error(
        "囲み編集前のキャンバス復元に失敗したため、現在の版を再読込します。",
        caught,
      );
    } finally {
      useEditor.setState({
        history: beforeHistory,
        canUndo: beforeCanUndo,
        canRedo: beforeCanRedo,
        historySuppressed: beforeHistorySuppressed,
        sourceImagePath: beforeSourcePath,
        selectedLayerId: beforeSelectedLayerId,
        message: beforeMessage,
        error: beforeError,
      });
      useEditor.getState().bumpRevision();
      rollbackSession();
    }

    if (restoreError === null) return true;
    try {
      if (await reloadVersion(recoveryPath)) return true;
    } catch (caught) {
      console.error("現在の版の再読込処理で例外が発生しました。", caught);
    }

    const recoveryError = new Error(EDITOR_RECOVERY_ERROR);
    console.error("現在の版の再読込にも失敗したため、編集を無効化します。", recoveryError);
    useEditor.getState().setError(EDITOR_RECOVERY_ERROR);
    onRecoveryFailure(recoveryError);
    return false;
  };

  try {
    const patched = await applyPatch();
    if (!patched) {
      return (await rollback()) ? "patch-failed" : "recovery-failed";
    }
  } catch (caught) {
    console.error("囲み編集のパッチ適用に失敗したため、変更を取り消します。", caught);
    return (await rollback()) ? "patch-failed" : "recovery-failed";
  }

  try {
    const path = await saveVersion();
    if (!path || !(await applyVersion(path))) {
      return (await rollback()) ? "version-failed" : "recovery-failed";
    }
    return "applied";
  } catch (caught) {
    console.error("囲み編集の保存または版適用に失敗したため、変更を取り消します。", caught);
    return (await rollback()) ? "version-failed" : "recovery-failed";
  }
}

/**
 * 画像をキャンバスへ読み込み、成功したときだけ新版をベースラインにする実経路。
 * 読み込み途中で canvas が空になっても、失敗時は直前の表示へ復元する。
 */
export async function openImageForEditing(
  path: string,
  options: OpenImageForEditingOptions = {},
): Promise<boolean> {
  const liveCanvas = useEditor.getState().canvas ?? (await waitForEditorCanvas());
  if (!liveCanvas) {
    useEditor.getState().setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
    return false;
  }
  const previousSnapshot = snapshotCanvas(liveCanvas);
  const previousViewport = Array.isArray(
    (liveCanvas as { viewportTransform?: number[] }).viewportTransform,
  )
    ? [...((liveCanvas as { viewportTransform: number[] }).viewportTransform)]
    : null;
  const previousBaseSize = (
    liveCanvas as { __ggBaseSize?: { width: number; height: number } }
  ).__ggBaseSize;
  const recoveryPath =
    options.recoveryPath === undefined
      ? useEditor.getState().sourceImagePath
      : options.recoveryPath;
  try {
    await showSourceImagePreview(liveCanvas, path);
    useEditor.getState().resetHistory();
    if (options.commitSourcePath !== false) useEditor.getState().setSourceImagePath(path);
    useEditor.getState().bumpRevision();
    useEditor
      .getState()
      .setMessage("画像を開きました。下の入力欄に、直したいところをことばで書いてください。");
    return true;
  } catch (caught) {
    // showSourceImagePreview は読込前にキャンバスを空にするため、失敗時は直前の
    // スナップショットと表示位置を復元して「前の版を表示したまま」にする。
    if (previousSnapshot !== null) {
      try {
        await restoreCanvas(liveCanvas, previousSnapshot);
        if (previousViewport) {
          (liveCanvas as { setViewportTransform?: (transform: number[]) => void })
            .setViewportTransform?.(previousViewport);
        }
        (
          liveCanvas as { __ggBaseSize?: { width: number; height: number } }
        ).__ggBaseSize = previousBaseSize;
        (liveCanvas as { requestRenderAll?: () => void }).requestRenderAll?.();
        useEditor.getState().bumpRevision();
      } catch (restoreError) {
        console.error(
          "画像読込前のキャンバス復元に失敗したため、現在の版を再読込します。",
          restoreError,
        );
        let recovered = false;
        if (recoveryPath) {
          try {
            recovered = await openImageForEditing(recoveryPath, {
              commitSourcePath: options.commitSourcePath,
              recoveryPath: null,
              onRecoveryFailure: () => {},
            });
          } catch (recoveryError) {
            console.error("現在の版の再読込処理で例外が発生しました。", recoveryError);
          }
        }
        if (!recovered) {
          const recoveryError = new Error(EDITOR_RECOVERY_ERROR);
          console.error("現在の版の再読込にも失敗したため、編集を無効化します。", recoveryError);
          useEditor.getState().setError(EDITOR_RECOVERY_ERROR);
          (options.onRecoveryFailure ?? editorRecoveryFailureHandler)?.(recoveryError);
          return false;
        }
      }
    }
    useEditor.getState().setError(caught instanceof Error ? caught.message : String(caught));
    return false;
  }
}

export function useEditorActions() {
  const canvas = useEditor((state) => state.canvas);
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const activeTool = useEditor((state) => state.activeTool);
  const setActiveTool = useEditor((state) => state.setActiveTool);
  const setBusyTool = useEditor((state) => state.setBusyTool);
  const setSourceImagePath = useEditor((state) => state.setSourceImagePath);
  const setMessage = useEditor((state) => state.setMessage);
  const setError = useEditor((state) => state.setError);
  const setGrabPreview = useEditor((state) => state.setGrabPreview);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const pushHistory = useEditor((state) => state.pushHistory);
  const resetHistory = useEditor((state) => state.resetHistory);
  const activeProjectId = useActiveProject((state) => state.activeProjectId);
  const projects = useProjects((state) => state.projects);
  const projectName = projects.find((project) => project.id === activeProjectId)?.name ?? null;

  const run = async (tool: EditorTool) => {
    // 別ツールへ切り替えるとき、掴む確定待ちのプレビューは破棄する (残像防止)。
    if (tool !== "grab" && useEditor.getState().grabPreview) {
      if (canvas) removeGrabPreviewOverlay(canvas);
      setGrabPreview(null);
    }
    setActiveTool(tool);
    if (tool === "select") {
      setMessage("選択ツールに切り替えました。");
      return;
    }
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    if (tool === "shape") {
      setMessage("右のパネルから図形を選んで追加してください。");
      return;
    }
    if (tool === "image-add") {
      if (!canvas) {
        setError("キャンバスを初期化中です。");
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (typeof selected !== "string") return;
      await addImageLayerToCanvas(canvas, selected, selected.split(/[\\/]/).pop() ?? "画像");
      bumpRevision();
      pushHistory();
      setMessage("画像をレイヤーとして追加しました。");
      return;
    }
    if (tool === "words") {
      setMessage("右のパネルで切り出したい「ことば」を入力してください (例: 人物、ボール)。");
      return;
    }
    if (tool === "text-add") {
      await addTextLayer(canvas);
      bumpRevision();
      pushHistory();
      setMessage("テキストレイヤーを追加しました。");
      return;
    }
    if (!sourceImagePath) {
      setError("先に画像をドロップ、または画像を選んでください。");
      return;
    }

    setBusyTool(tool);
    setError(null);
    try {
      if (tool === "magic" || tool === "redo-decompose") {
        await runMagic(sourceImagePath, tool, projectName);
      } else if (tool === "bgremove") {
        setMessage("人物切り抜きを実行中…");
        const result = await editSegment.run(sourceImagePath, projectName);
        await applySegmentResultToCanvas(canvas, result);
        setMessage("人物切り抜きが完了しました。");
      } else if (tool === "text-detect") {
        setMessage("テキスト検出を実行中…");
        const regions = await editOcr.detect(sourceImagePath);
        await addTextRegionsToCanvas(canvas, regions);
        setMessage(`${regions.length}件のテキストを追加しました。`);
      } else if (tool === "clickseg") {
        setMessage("SAM2 を準備中…キャンバス上の対象をクリックしてください。");
        await editSam2.embed(sourceImagePath);
        setMessage("準備完了。切り抜きたい対象をキャンバス上でクリックしてください。");
      } else if (tool === "grab") {
        setGrabPreview(null);
        setMessage("マジックグラブを準備中…掴みたい対象をクリックしてください。");
        await editSam2.embed(sourceImagePath);
        setMessage("準備完了。掴みたい対象をキャンバス上でクリックしてください。");
      } else if (tool === "inpaint") {
        const maskPath = await open({
          multiple: false,
          filters: [{ name: "マスク画像", extensions: IMAGE_EXTS }],
        });
        if (typeof maskPath !== "string") {
          setMessage("領域消去をキャンセルしました。");
          return;
        }
        setMessage("領域消去を実行中…");
        const outputPath = await editInpaint.run(sourceImagePath, maskPath, projectName);
        await addImageLayerToCanvas(canvas, outputPath, "領域消去結果");
        setMessage("領域消去結果をレイヤーに追加しました。");
      }
      bumpRevision();
      // clickseg / grab は「準備 (embed)」だけで canvas を変えないので履歴を積まない。
      // 実際のマスク追加・掴み確定は handleCanvasClickForTool / confirmGrab 側で積む。
      // magic / redo-decompose は runMagic 内で resetHistory する (canvas 総入れ替え)。
      if (tool !== "clickseg" && tool !== "grab" && tool !== "magic" && tool !== "redo-decompose") {
        pushHistory();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  /** キャンバスに分解済みレイヤーがあるか (元画像プレビューとマスクは数えない)。 */
  const hasDecomposedLayers = () => {
    const objects =
      (canvas as { getObjects?: () => Array<{ get?: (key: string) => unknown }> } | null)
        ?.getObjects?.() ?? [];
    return objects.some(
      (object) =>
        object.get?.("id") !== SOURCE_PREVIEW_ID && object.get?.("layerKind") !== "mask",
    );
  };

  /**
   * ことばで分離 (SAM3) を実行する。raw はカンマ/空白区切りの入力
   * (日本語は wordPresets 辞書で英語プロンプトへ解決)。
   */
  const runWords = async (raw: string) => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    if (!sourceImagePath) {
      setError("先に画像をドロップ、または画像を選んでください。");
      return;
    }
    const inputs = splitWordsInput(raw);
    if (inputs.length === 0) {
      setError("切り出したい「ことば」を入力してください。");
      return;
    }
    const resolved = inputs.map(resolveWord);
    const untranslated = resolved.filter((w) => !w.translated);

    setBusyTool("words");
    setError(null);
    setMessage("ことばで分離を実行中… (初回はAIの読み込みに数十秒かかります)");
    try {
      // 初回分解はフルセット (背景補完+テキストレイヤー化)、以降の語の追加はレイヤー追記。
      const full = !hasDecomposedLayers();
      const result = await editWords.segment(
        sourceImagePath,
        resolved.map((w) => ({ prompt: w.prompt, label: w.label })),
        projectName,
        { mode: full ? "full" : "layersOnly" },
      );
      const added = full
        ? await applyWordsResultToCanvas(canvas, result)
        : await addWordLayersToCanvas(canvas, result);
      if (full) resetHistory();
      if (added > 0) {
        bumpRevision();
        pushHistory();
        setMessage(
          full
            ? `${result.layers.length}個の物体と文字${result.textLayers.length}件を切り出しました。文字はダブルクリックで打ち替えできます。`
            : `${added}個のレイヤーを切り出しました。右の一覧から選んで動かせます。`,
        );
      } else {
        setMessage(
          untranslated.length > 0
            ? "見つかりませんでした。辞書にない日本語は精度が下がります。英語 (例: dog) でも試してください。"
            : "見つかりませんでした。別のことばで試してください。",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  /**
   * ことばで分離の自動モード: Codex (ユーザーのChatGPT) に画像内の物体を全列挙させ、
   * その全キーワードを SAM3 に投げてレイヤー分割する。
   */
  const runWordsAuto = async () => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    if (!sourceImagePath) {
      setError("先に画像をドロップ、または画像を選んでください。");
      return;
    }
    setBusyTool("words");
    setError(null);
    setMessage("AIが画像を読み取り中… (写っているものを数え上げています)");
    try {
      const objects = await codexVision.listObjects(sourceImagePath);
      setMessage(
        `${objects.length}個のものを見つけました (${objects.map((o) => o.ja).join("、")})。切り出し中…`,
      );
      // Codex vision の category (実画像を見た大ジャンル判定) を SAM3 プロンプト単位で
      // キャンバス反映まで運ぶ。壊れた/欠落した category は決定論分類器へフォールバック。
      const genreByPrompt: Record<string, LayerGenre> = Object.fromEntries(
        objects.map((o) => [o.en, normalizeGenre(o.category, o.en, o.ja)]),
      );
      const full = !hasDecomposedLayers();
      const result = await editWords.segment(
        sourceImagePath,
        objects.map((o) => ({ prompt: o.en, label: o.ja })),
        projectName,
        { mode: full ? "full" : "layersOnly" },
      );
      const added = full
        ? await applyWordsResultToCanvas(canvas, result, genreByPrompt)
        : await addWordLayersToCanvas(canvas, result, genreByPrompt);
      if (full) resetHistory();
      if (added > 0) {
        bumpRevision();
        pushHistory();
        setMessage(
          full
            ? `${result.layers.length}個の物体と文字${result.textLayers.length}件を切り出しました。文字はダブルクリックで打ち替え、足りないものは「ことば」で追加できます。`
            : `${added}個のレイヤーを切り出しました。足りないものは「ことば」を入力して追加できます。`,
        );
      } else {
        setMessage("切り出せるものが見つかりませんでした。「ことば」を直接入力して試してください。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  /** 図形をキャンバス中央に追加する (ShapeToolPanel から)。 */
  const addShape = async (kind: "rect" | "circle" | "line" | "arrow", color: string) => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    await addShapeToCanvas(canvas, kind, color);
    bumpRevision();
    pushHistory();
    setMessage("図形を追加しました。ドラッグ・四隅で調整できます。");
  };

  /** 選択中の複数レイヤーを1グループに束ねる (Canva「グループ化」相当・差4)。 */
  const groupSelection = async () => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    const id = await groupSelectedLayers(canvas);
    if (!id) {
      setMessage("グループ化するには2つ以上のレイヤーを選んでください。");
      return;
    }
    bumpRevision();
    pushHistory();
    setMessage("レイヤーをグループ化しました。まとめて移動・拡縮できます。");
  };

  /** 指定 id のグループを解除して中身を個別レイヤーへ戻す (Canva「グループ解除」相当・差4)。 */
  const ungroupSelection = async (id: string) => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    const count = await ungroupLayer(canvas, id);
    if (count === 0) {
      setMessage("グループを選んでから解除してください。");
      return;
    }
    bumpRevision();
    pushHistory();
    setMessage(`グループを解除しました (${count}レイヤー)。`);
  };

  /**
   * 「セリフ・文字を直す」: 囲んだ範囲を単色で塗りつぶし、その上に文字を載せる。
   *
   * AI を一切通さない決定論経路。範囲指定の AI 修正でセリフを書き換えると
   * 文字が崩壊する (画像生成モデルは文字を描くのが構造的に苦手) ため、
   * 「下地を塗る + フォントで書く」に置き換える。即時・無料・文字化けゼロ。
   *
   * 塗りと文字は連続して add するが、履歴は最後に1回だけ積む。1回の「戻す」で
   * 塗りも文字もまとめて消えるのが、ユーザーの体感する「1操作」と一致する。
   *
   * 置いた直後は**その文字を選択状態にして返す** (2026-07-28 STΛCK 実機指摘)。
   * 置いた本人が続けて動かす・大きさを変えるのが自然な流れなのに、選択されて
   * いないと「置いた文字をもう一度探して掴む」ひと手間が挟まる。返り値の
   * レイヤー ID は、呼び出し側が右パネルを再編集フォームへ切り替えるのに使う。
   */
  const applyTextOverlay = async (
    bboxNorm: [number, number, number, number],
    options: {
      text: string;
      orientation: "vertical" | "horizontal";
      fontSize: number;
      color: string;
      fontFamily: string;
      fillColor: string;
    },
  ): Promise<string | null> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return null;
    }
    if (!isValidNormalizedBbox(bboxNorm)) {
      setError("塗る範囲が不正です。もう一度囲んでください。");
      return null;
    }
    const base = getCanvasBaseSize(liveCanvas);
    if (!base) {
      setError("元画像の寸法が取得できません。画像を開き直してください。");
      return null;
    }
    // 正規化 bbox → 元画像の実寸 (scene 座標)。実行時の表示倍率には依存しない。
    const rect = {
      left: bboxNorm[0] * base.width,
      top: bboxNorm[1] * base.height,
      width: bboxNorm[2] * base.width,
      height: bboxNorm[3] * base.height,
    };
    try {
      const fill = await addFillRectLayer(liveCanvas, rect, options.fillColor);
      // 文字が空なら下地だけ。その場合は下地を選択対象にする
      // (「置いたものが選ばれている」を、どちらの場合でも成り立たせる)。
      const placed = options.text.trim()
        ? await addOverlayTextLayer(liveCanvas, rect, {
            text: options.text,
            orientation: options.orientation,
            fontSize: options.fontSize,
            fill: options.color,
            fontFamily: options.fontFamily,
          })
        : fill;
      const target = liveCanvas as {
        setActiveObject?: (object: unknown) => void;
        requestRenderAll?: () => void;
      };
      target.setActiveObject?.(placed);
      target.requestRenderAll?.();
      const placedId = objectId(placed);
      useEditor.getState().setSelectedLayerId(placedId);
      bumpRevision();
      pushHistory();
      setMessage("文字を置きました。そのままドラッグで動かせます。『戻す』で元に戻せます。");
      return placedId;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  };

  /**
   * 置いた文字レイヤーを、あとから直す (内容・向き・大きさ・色・フォント)。
   *
   * 選択中のオブジェクトが文字でなければ何もせず false を返す
   * (右パネルは選択が文字のときだけ再編集フォームを出すので、通常は起きない)。
   *
   * 履歴は `commit` が true のときだけ積む。スライダーを動かしている最中の
   * 連続更新で履歴が数十個積まれると「戻す」が実質使えなくなるため、
   * 操作が終わった時点 (pointerup / blur) でのみ確定させる。
   */
  const updateSelectedTextLayer = (
    patch: Partial<{
      text: string;
      orientation: "vertical" | "horizontal";
      fontSize: number;
      color: string;
      fontFamily: string;
    }>,
    commit = false,
  ): boolean => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) return false;
    const target = (liveCanvas as { getActiveObject?: () => unknown }).getActiveObject?.();
    if (!target) return false;
    if (!readOverlayTextValues(target)) return false;
    updateOverlayTextLayer(liveCanvas, target, patch);
    bumpRevision();
    if (commit) pushHistory();
    return true;
  };

  /**
   * 「素材を重ねる」: 画像をレイヤーとしてキャンバス中央に追加する (AI 不使用・即時)。
   *
   * 休眠していた `run("image-add")` (このファイルの上の方・EditorToolbar 前提で
   * 起動できなくなっていた) と同じ addImageLayerToCanvas に載せる。違いは3つだけ:
   *   - path をこちらが受け取る (ファイル選択はライブラリ経由もあるため呼び出し側の責務)
   *   - **キャンバスの 1/3 に収まるまで縮めてから置く**。元画像より大きい素材を
   *     等倍で置くと画面外へはみ出し、掴む前に「消えた」と誤解される
   *   - 中央に置く。左上 (旧実装の left:80 top:80) は元画像の外に出ることがある
   *
   * 置いた直後は選択状態で返る (addImageLayerToCanvas が setActiveObject する)。
   * 呼び出し側は「選択・移動」へ戻すことで、置いたその場で掴める状態になる。
   */
  const addOverlayImage = async (imagePath: string): Promise<string | null> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return null;
    }
    try {
      const name = imagePath.split(/[\\/]/).pop() ?? "画像";
      const placed = await addImageLayerToCanvas(liveCanvas, imagePath, name);
      // 置いてから測って縮める。fabric の Image は読み込み後でないと実寸が分からない
      // ので、「先に計算してから置く」ことはできない。
      const base = getCanvasBaseSize(liveCanvas);
      const rawWidth = (placed as { width?: number }).width ?? 0;
      const rawHeight = (placed as { height?: number }).height ?? 0;
      if (base && rawWidth > 0 && rawHeight > 0) {
        // 長辺がキャンバスの 1/3 に収まる倍率。元から小さい素材は拡大しない
        // (勝手に引き伸ばすとぼやける)。
        const scale = Math.min(
          (base.width / 3) / rawWidth,
          (base.height / 3) / rawHeight,
          1,
        );
        const width = rawWidth * scale;
        const height = rawHeight * scale;
        (placed as { set?: (values: Record<string, unknown>) => void }).set?.({
          scaleX: scale,
          scaleY: scale,
          left: (base.width - width) / 2,
          top: (base.height - height) / 2,
        });
        (placed as { setCoords?: () => void }).setCoords?.();
        (liveCanvas as { requestRenderAll?: () => void }).requestRenderAll?.();
      }
      const placedId = objectId(placed);
      useEditor.getState().setSelectedLayerId(placedId);
      bumpRevision();
      pushHistory();
      setMessage("素材を重ねました。そのままドラッグで動かせます。『戻す』で元に戻せます。");
      return placedId;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  };

  /**
   * 「背景を透過」: 被写体を切り抜いて、ベース画像を透過 PNG に置き換える (AI ローカル処理)。
   *
   * ## OS で経路が分かれる (どちらも同じ「1クリックで透過」に見せる)
   *
   *   - macOS (Intel / Apple Silicon 共通): Vision API。`images_remove_background`
   *     → 同梱の `resources/removebg.swift` を叩く。モデル DL 不要
   *   - Windows: BiRefNet (ort/ONNX)。`segment_image` → 前景 PNG を受け取る。
   *     ort は Windows 限定依存のため、mac ではそもそもスタブが返る
   *     (`commands/edit_unsupported.rs`)。モデル未 DL なら呼び出し側が先に落とす
   *
   * 判定は `edit_platform_info()` (既存の OS 判定 API) の os で行う。ブラウザの
   * userAgent を見ないのは、Tauri の webview がプラットフォームによって別実装で、
   * Rust の `std::env::consts::OS` の方が実体に一致するため。
   *
   * ## なぜ「重ねる」ではなく「置き換える」なのか
   *
   * 透過は元画像そのものの加工であって、上に載せる素材ではない。重ねると
   * 下に不透明な元画像が残り続け、書き出しても透過にならない (見た目だけ透過)。
   *
   * ## 版として戻る仕組み
   *
   * ここでは透過 PNG の path までを返し、EditWorkspace の版確定経路で読み直す。
   * そのため透過前へ戻る操作はキャンバス Undo ではなく、右の版履歴が担う。
   * 入力は先に焼いてから渡すので、調整・置いた文字・重ねた素材も込みで切り抜かれる。
   */
  const removeBackgroundOnCanvas = async (): Promise<string | null> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return null;
    }
    const flat = flattenCanvas(liveCanvas);
    if (!flat) {
      setError("透過する画像がありません。画像を開き直してください。");
      return null;
    }

    setBusyTool("bgremove");
    setError(null);
    setMessage("背景を透過しています…");
    try {
      // 1) いまのキャンバスをファイルに落とす。どちらの経路も「path を受けて path を返す」
      //    Rust コマンドなので、先にディスクへ出す必要がある。
      const inputPath = await images.writeUpload(
        `nobg-src-${Date.now()}.png`,
        dataUrlToBytes(flat.dataUrl),
      );

      // 2) OS ごとの経路で切り抜く。返るのはどちらも透過 PNG の path。
      const platform = await editModels.platformInfo();
      let cutoutPath: string;
      if (platform.os === "windows" && platform.editAiAvailable) {
        // Windows は BiRefNet (ort)。モデルが未 DL だと Rust が
        // "model not downloaded: birefnet-general" という初心者に手の打てない
        // エラーを返すので、**呼ぶ前に**こちらで落として待つ。
        await ensureSegmentModel(setMessage);
        cutoutPath = (await segmentImage({ imagePath: inputPath, model: "u2net" }))
          .foregroundPath;
      } else if (platform.os === "macos") {
        cutoutPath = await images.removeBackground(inputPath);
      } else {
        // Windows 互換版 (旧CPU向け・ort 抜き)。BiRefNet が無く Vision も無い。
        // 例外を投げると生の英語エラーが出るので、ユーザー向け文言で静かに止める。
        setError("お使いの構成（互換版）では背景透過を利用できません");
        return null;
      }

      // 3) 結果 path だけを返す。版としての読み込み・状態更新・Undo リセットは
      //    EditWorkspace の applyEditedVersion に一本化する。
      return cutoutPath;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusyTool(null);
    }
  };

  /** キャンバスを統合PNGとして書き出す (保存先はユーザーが選ぶ)。 */
  const exportPng = async () => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return;
    }
    const base64 = exportCanvasPngBase64(canvas);
    if (!base64) {
      setError("書き出しデータの生成に失敗しました。");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      defaultPath: "gori-export.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (typeof target !== "string") {
      setMessage("書き出しをキャンセルしました。");
      return;
    }
    try {
      await editExport.png(target, base64);
      setMessage(`書き出しました: ${target}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /**
   * 「調整」の色調補正をベース画像へ反映する (AI 不使用・即時)。
   *
   * `commit` が true のときだけ履歴を積む。スライダーを動かしている最中は
   * false で呼び、離した時点 (pointerup) で true にする。動かしている間ずっと
   * 積むと1ドラッグで数十手になり「戻す」が実質使えなくなる
   * (updateSelectedTextLayer と同じ流儀)。
   */
  const applyAdjust = async (values: AdjustValues, commit = false): Promise<boolean> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return false;
    }
    const applied = await applyAdjustToCanvas(liveCanvas, values);
    if (!applied) {
      setError("調整できる画像がありません。画像を開き直してください。");
      return false;
    }
    bumpRevision();
    if (commit) pushHistory();
    return true;
  };

  /**
   * 囲んだ範囲でキャンバスを切り抜く (AI 不使用・即時)。
   *
   * 履歴は**リセットしない**。1回の「戻す」で切り抜く前の状態に戻れる
   * (切り抜きは取り返しのつく操作にしておく)。
   */
  const cropToRegion = async (
    bboxNorm: [number, number, number, number],
  ): Promise<boolean> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return false;
    }
    if (!isValidNormalizedBbox(bboxNorm)) {
      setError("切り抜く範囲が不正です。もう一度囲んでください。");
      return false;
    }
    try {
      const done = await cropCanvasToRegion(liveCanvas, bboxNorm);
      if (!done) {
        setError("切り抜けませんでした。画像を開き直してください。");
        return false;
      }
      useEditor.getState().setSelectedLayerId(null);
      bumpRevision();
      pushHistory();
      setMessage("切り抜きました。『戻す』で元に戻せます。");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  /** キャンバス全体を90°回転 / 反転する (AI 不使用・即時・undo 対応)。 */
  const rotateOrFlip = async (kind: TransformKind): Promise<boolean> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return false;
    }
    try {
      const done = await transformCanvas(liveCanvas, kind);
      if (!done) {
        setError("回転できませんでした。画像を開き直してください。");
        return false;
      }
      useEditor.getState().setSelectedLayerId(null);
      bumpRevision();
      pushHistory();
      setMessage("向きを変えました。『戻す』で元に戻せます。");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  /**
   * 形式・サイズを指定して書き出す (PNG / JPEG / WebP)。
   *
   * 焼く元は exportCanvasPngBase64 = 「書き出し」「作品にする」と同じ関数なので、
   * **調整フィルタも置いた文字も焼き込まれた1枚**がそのまま変換対象になる。
   */
  const exportImageAs = async (format: ExportFormat, size: ExportSize): Promise<boolean> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return false;
    }
    const base64 = exportCanvasPngBase64(liveCanvas);
    if (!base64) {
      setError("書き出しデータの生成に失敗しました。");
      return false;
    }
    try {
      const dest = await saveExportedImage(base64, format, size);
      if (!dest) {
        setMessage("書き出しをキャンセルしました。");
        return false;
      }
      setMessage(`書き出しました: ${dest}`);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  /** 現在見えている統合画像を、版として読み直せる PNG ファイルへ保存する。 */
  const saveCanvasVersion = async (namePrefix = "edit-version"): Promise<string | null> => {
    const liveCanvas = canvas ?? useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("キャンバスを初期化中です。");
      return null;
    }
    const base64 = exportCanvasPngBase64(liveCanvas);
    if (!base64) {
      setError("版にする画像データを作れませんでした。");
      return null;
    }
    try {
      return await images.writeUpload(
        `${namePrefix}-${Date.now()}.png`,
        base64ToBytes(base64),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  };

  /**
   * 編集結果を「作品」としてギャラリーへ合流させる (ヘッダー「作品にする」)。
   *
   * 保存先ダイアログは出さない。images_write_upload は
   * `<CODEX_HOME>/generated_images/uploads/` に書き、そこはギャラリー watcher の
   * 監視対象 (images.rs のコメント「generated_images tree also makes it visible in
   * the gallery watcher」) なので、**新しい Rust コマンドなしで**編集結果が
   * ギャラリー・履歴・プロジェクト保存の既存資産管理に乗る。
   */
  const saveAsArtwork = async (): Promise<boolean> => {
    if (!canvas) {
      setError("キャンバスを初期化中です。");
      return false;
    }
    const base64 = exportCanvasPngBase64(canvas);
    if (!base64) {
      setError("書き出しデータの生成に失敗しました。");
      return false;
    }
    try {
      await images.writeUpload(`edit-${Date.now()}.png`, base64ToBytes(base64));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    }
  };

  /**
   * 同じ雰囲気のまま文字 (レイヤー) を AI で差し替える。
   * 選択レイヤーの領域だけをマスクして Codex にインペイント編集させ (他は1pxも触らせない)、
   * 生成結果と元画像の差分領域を透過パッチとして同位置のレイヤーに差し替える。
   */
  const restyleSelectedLayer = async (instruction: string) => {
    if (!canvas || !sourceImagePath) {
      setError("画像を開いてから実行してください。");
      return;
    }
    const selectedId = useEditor.getState().selectedLayerId;
    const objects =
      (canvas as { getObjects?: () => Array<Record<string, any>> }).getObjects?.() ?? [];
    const target = objects.find((object) => object.get?.("id") === selectedId);
    const sourcePath = target?.get?.("sourcePath") as string | undefined;
    const sourceBbox = target?.get?.("sourceBbox") as
      | [number, number, number, number]
      | undefined;
    if (!target || !sourcePath || !sourceBbox) {
      setError("AI差し替えに対応したレイヤー (分解で切り出したもの) を選択してください。");
      return;
    }

    setBusyTool("words");
    setError(null);
    setMessage("AIが同じ雰囲気で描き直しています… (30秒〜2分)");
    try {
      // 1) 選択レイヤーの領域マスク (フルサイズ座標) を作る。
      const maskDataUrl = await buildFullSizeMaskFromCrop(sourcePath, sourceBbox, canvas);
      const maskBytes = dataUrlToBytes(maskDataUrl);
      const maskPath = await images.writeUpload(`restyle-mask-${Date.now()}.png`, maskBytes);

      // 2) Codex にインペイント編集させる (白い領域だけ変更)。
      const result = await images.generateBatch({
        prompt: instruction,
        count: 1,
        refImagePaths: [sourceImagePath],
        maskPaths: [maskPath],
      });
      const generatedPath = result.generatedPaths[0];
      if (!generatedPath || result.failedCount > 0) {
        throw new Error(result.errors[0] ?? "AI差し替えに失敗しました。");
      }

      // 3) 元画像との差分を透過パッチ化して、同位置のレイヤーに差し替える。
      const patch = await buildDiffPatch(sourceImagePath, generatedPath, sourceBbox);
      const textSpec = target.get?.("textSpec");
      await replaceLayerWithDataUrl(canvas, target, patch.dataUrl, {
        left: patch.left,
        top: patch.top,
        sourceBbox: [patch.left, patch.top, patch.width, patch.height],
        ...(textSpec ? { textSpec } : {}),
      });
      bumpRevision();
      pushHistory();
      setMessage("同じ雰囲気で差し替えました。気に入らなければ ⌘Z で戻せます。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  const chooseImage = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "画像", extensions: IMAGE_EXTS }],
    });
    if (typeof selected !== "string") return;
    await openImageForEditing(selected);
  };

  /**
   * 赤入れの正規化 bbox を使い、分解なしで指定範囲だけを AI 修正する。
   * 元画像を開き直してから、既存の生成 → 差分パッチ経路を新規レイヤーとして重ねる。
   */
  const applyRedlineFix = async (
    imagePath: string,
    bboxNorm: [number, number, number, number],
    instruction: string,
  ): Promise<boolean> => {
    if (!imagePath || !instruction.trim()) {
      setError("修正する画像または指示がありません。");
      return false;
    }
    if (!isValidNormalizedBbox(bboxNorm)) {
      setError("赤入れの修正範囲が不正です。範囲を確認して、もう一度読み取ってください。");
      return false;
    }
    const opened = await openImageForEditing(imagePath);
    if (!opened) return false;
    const liveCanvas = useEditor.getState().canvas;
    if (!liveCanvas) {
      setError("編集キャンバスを準備できませんでした。もう一度お試しください。");
      return false;
    }

    setBusyTool("inpaint");
    setError(null);
    setMessage("赤入れの指定範囲だけを描き直しています… (30秒〜2分)");
    try {
      // 1) 正規化 bbox を元画像の実寸へ変換し、黒地に白い矩形のマスクを作る。
      const mask = await buildFullSizeMaskFromNormalizedBbox(imagePath, bboxNorm);
      const maskPath = await images.writeUpload(
        `redline-mask-${Date.now()}.png`,
        dataUrlToBytes(mask.dataUrl),
      );

      // 2) 既存のインペイント生成経路へ、元画像・マスク・赤入れ指示をそのまま渡す。
      //    model/effort/cwd は制作タブで選ばれている値をそのまま使う。
      //    渡さないと範囲編集だけ既定モデルに落ち、全体編集 (EditWorkspace.run) と
      //    結果の質が食い違う (経路間のモデル不整合)。
      const threads = useThreads.getState();
      const result = await images.generateBatch({
        prompt: instruction,
        count: 1,
        cwd: threads.cwd,
        refImagePaths: [imagePath],
        maskPaths: [maskPath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
      });
      const generatedPath = result.generatedPaths[0];
      if (!generatedPath || result.failedCount > 0) {
        throw new Error(result.errors[0] ?? "赤入れの部分修正に失敗しました。");
      }

      // 3) 既存の差分化を通し、bbox 外を透明に固定したパッチだけを新規レイヤーにする。
      const patch = await buildDiffPatch(imagePath, generatedPath, mask.bbox, true);
      const patchPath = await images.writeUpload(
        `redline-patch-${Date.now()}.png`,
        dataUrlToBytes(patch.dataUrl),
      );
      await addImageLayerToCanvas(liveCanvas, patchPath, "赤入れ修正", {
        left: patch.left,
        top: patch.top,
        sourcePath: patchPath,
        sourceBbox: [patch.left, patch.top, patch.width, patch.height],
      });
      bumpRevision();
      pushHistory();
      // Windows には ⌘ が無い。ヘッダーの「戻す」ボタンを案内する。
      setMessage("指定範囲だけを修正しました。気に入らなければ『戻す』で戻せます。");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusyTool(null);
    }
  };

  const runMagic = async (path: string, tool: EditorTool = "magic", runProjectName = projectName) => {
    if (!canvas) return;
    setBusyTool(tool);
    setError(null);
    setMessage("Magic Layer を実行中…");
    const magicStore = useEditMagic.getState();
    magicStore.setRunning(true);
    magicStore.setError(null);
    magicStore.setProgress({ kind: "started" });
    try {
      // 現在選択中のレイヤー分解モードと物体分解設定を Rust へ渡す。store 経由で読むのは、
      // EditWorkspace のローカル state ではなくここから現在値を取れるようにするため。
      const { editMode, objectLayersEnabled, objectCountMode } = useEditor.getState();
      const result = await editMagic.run(path, runProjectName, {
        mode: editMode,
        includeObjects: objectLayersEnabled,
        objectCount: OBJECT_COUNT_BY_MODE[objectCountMode],
      });
      magicStore.setResult(result);
      await applyMagicLayerToCanvas(canvas, result);
      setSourceImagePath(path);
      // 完了メッセージは「次に何をするか」を言う。切り分けた総数 (プレビュー用マスクは除く)
      // を数えて、右のレイヤー一覧から選んで動かせることを伝える。
      const layerCount = (canvas as { getObjects?: () => Array<{ get?: (key: string) => unknown }> })
        .getObjects?.()
        .filter((object) => object.get?.("layerKind") !== "mask").length ?? 0;
      setMessage(
        layerCount > 0
          ? `${layerCount}個のレイヤーに分解しました。右の一覧から選んで動かせます。`
          : "分解しました。右の一覧から選んで動かせます。",
      );
      bumpRevision();
      // Magic Layer / 再分解は canvas を丸ごと作り直す = 新しい編集セッションの起点。
      // 履歴を今の状態で初期化する (それ以前の状態には戻せない = 画像単位でリセット)。
      resetHistory();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      magicStore.setError(message);
      setError(message);
    } finally {
      magicStore.setRunning(false);
      setBusyTool(null);
    }
  };

  const handleCanvasClickForTool = async (x: number, y: number) => {
    if (!sourceImagePath || !canvas) return;
    if (activeTool === "clickseg") {
      setBusyTool("clickseg");
      setError(null);
      setMessage("クリック切り抜きマスクを生成中…");
      try {
        const result = await editSam2.predict(x, y, true);
        await addMaskLayerFromBase64(canvas, result.maskBase64);
        setMessage(`マスク生成完了 (${result.width}×${result.height})`);
        bumpRevision();
        pushHistory();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyTool(null);
      }
      return;
    }
    if (activeTool === "grab") {
      setBusyTool("grab");
      setError(null);
      setMessage("掴む範囲を判定中…");
      try {
        const result = await editSam2.predict(x, y, true);
        // 確定前はプレビューとして保持し、キャンバスに範囲を重ねて見せる。
        // 実際の切り抜き+背景補完は confirmGrab で行う。
        setGrabPreview({
          maskBase64: result.maskBase64,
          width: result.width,
          height: result.height,
        });
        await showGrabPreviewOverlay(canvas, result.maskBase64);
        setMessage("この範囲でよければ「掴む」を押してください。別の場所をクリックでやり直せます。");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyTool(null);
      }
    }
  };

  /**
   * マジックグラブを確定する。プレビューのマスクを保存 → Rust で切り抜き+背景補完 →
   * キャンバスへアトミック反映 (背景差し替え + オブジェクトレイヤー追加)。
   *
   * アトミック性: applyGrabResultToCanvas は両画像のロードが済んでから canvas を触るため、
   * ロード失敗時は canvas を変更せず throw する。ここで catch してエラー表示に留め、
   * 掴む前の状態を保つ。連続グラブ: 反映後もプレビューだけ消して活性ツールは grab のまま
   * にするので、続けて別の対象をクリックできる (SAM2 embed は再利用)。
   */
  const confirmGrab = async () => {
    const preview = useEditor.getState().grabPreview;
    if (!preview || !sourceImagePath || !canvas) return;
    setBusyTool("grab");
    setError(null);
    setMessage("掴んでいます…背景を補完中…");
    try {
      const maskPath = await images.writeMask(sourceImagePath, base64ToBytes(preview.maskBase64));
      const result = await editGrab.run(sourceImagePath, maskPath, projectName);
      // プレビューオーバーレイは反映直前に外す (背景差し替えより先に消して残像を防ぐ)。
      removeGrabPreviewOverlay(canvas);
      await applyGrabResultToCanvas(canvas, result);
      setGrabPreview(null);
      setMessage("掴みました。ドラッグで移動・拡大縮小・回転できます。続けて別の対象も掴めます。");
      bumpRevision();
      // AI 操作 (グラブ確定) も 1 手で戻せるよう履歴を積む。
      pushHistory();
    } catch (caught) {
      // 失敗時は canvas を変えずにエラーだけ出す (アトミック: 中途半端に反映しない)。
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  const cancelGrab = () => {
    if (canvas) removeGrabPreviewOverlay(canvas);
    setGrabPreview(null);
    setMessage("掴む範囲の選択をやり直せます。対象をクリックしてください。");
  };

  /**
   * Undo / Redo の実行。store から次に復元すべきスナップショットを取り出し、
   * suppress フラグを立ててから loadFromJSON で復元する。復元中に発火する
   * canvas イベント (object:added/modified 等) では pushHistory が no-op になり、
   * 履歴が二重に汚れない。復元後に選択をクリアし revision を上げて UI を同期する。
   */
  const performUndo = async () => {
    const { canvas: liveCanvas, undo, setHistorySuppressed } = useEditor.getState();
    if (!liveCanvas) return;
    const snapshot = undo();
    if (snapshot === null) return;
    setHistorySuppressed(true);
    try {
      await restoreCanvas(liveCanvas, snapshot);
    } finally {
      setHistorySuppressed(false);
    }
    useEditor.getState().setSelectedLayerId(null);
    bumpRevision();
    setMessage("元に戻しました。");
  };

  const performRedo = async () => {
    const { canvas: liveCanvas, redo, setHistorySuppressed } = useEditor.getState();
    if (!liveCanvas) return;
    const snapshot = redo();
    if (snapshot === null) return;
    setHistorySuppressed(true);
    try {
      await restoreCanvas(liveCanvas, snapshot);
    } finally {
      setHistorySuppressed(false);
    }
    useEditor.getState().setSelectedLayerId(null);
    bumpRevision();
    setMessage("やり直しました。");
  };

  const saveDroppedFileAndRunMagic = async (file: File) => {
    const shouldClear = (canvas as { getObjects?: () => unknown[] } | null)?.getObjects?.().length;
    if (shouldClear) {
      const message = "既存レイヤーをクリアして、この画像を開きますか?";
      let ok = false;
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        ok = await ask(message, { title: "レイヤーのクリア", kind: "warning" });
      } catch {
        ok = window.confirm(message);
      }
      if (!ok) return;
    }
    setBusyTool("magic");
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = await images.writeUpload(file.name || `drop-${Date.now()}.png`, bytes);
      await openImageForEditing(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  /**
   * 既にローカル PC 上にある画像 path を編集タブに取り込んで Magic Layer を回す。
   *
   * 外部 OS ファイル / 別モニタからの Tauri ネイティブ D&D は path を渡してくる
   * ので、File を経由せずに直接取り込める (writeUpload 不要)。アプリ内部の参照
   * ドラッグ (gallery / preset) もここに来る。
   */
  const saveDroppedPathAndRunMagic = async (path: string) => {
    if (!path) return;
    const shouldClear = (canvas as { getObjects?: () => unknown[] } | null)?.getObjects?.().length;
    if (shouldClear) {
      const message = "既存レイヤーをクリアして、この画像を開きますか?";
      let ok = false;
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        ok = await ask(message, { title: "レイヤーのクリア", kind: "warning" });
      } catch {
        ok = window.confirm(message);
      }
      if (!ok) return;
    }
    setBusyTool("magic");
    setError(null);
    try {
      await openImageForEditing(path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyTool(null);
    }
  };

  return {
    run,
    runWords,
    runWordsAuto,
    addShape,
    groupSelection,
    ungroupSelection,
    exportPng,
    exportImageAs,
    saveCanvasVersion,
    applyAdjust,
    cropToRegion,
    rotateOrFlip,
    addOverlayImage,
    removeBackgroundOnCanvas,
    saveAsArtwork,
    applyTextOverlay,
    updateSelectedTextLayer,
    restyleSelectedLayer,
    chooseImage,
    openImageForEditing,
    applyRedlineFix,
    runMagic,
    handleCanvasClickForTool,
    confirmGrab,
    cancelGrab,
    performUndo,
    performRedo,
    saveDroppedFileAndRunMagic,
    saveDroppedPathAndRunMagic,
  };
}

/** BiRefNet (Windows の背景透過で使うモデル) の registry 上の id。 */
const SEGMENT_MODEL_ID = "birefnet-general";

/**
 * Windows の背景透過に必要なモデルを、無ければ落としてから返す。
 *
 * なぜフロントでやるか: Rust の `segment_image` はモデルが無いと
 * `model not downloaded: birefnet-general` で即失敗する (edit/runtime.rs
 * build_session)。初心者は何をすればいいか分からないので、**押しただけで
 * 勝手に揃う**ところまでをアプリの責任にする。
 *
 * 進捗は既存の DL マネージャ (`edit_models_download` + 進捗イベント) にそのまま
 * 乗る。新しい DL 経路は作らない (ハッシュ検証・再開・保存先が二重化するため)。
 *
 * 進捗イベントの購読を**この関数の中で張る**理由: 既存の購読者 `EditModelGate` は
 * 封印済みパネル (LayerPanel / MagicLayerPanel 等) の中にしかおらず、編集タブでは
 * 1つもマウントされない。store 任せにすると進捗も失敗理由もどこにも届かず、
 * 「押したまま無言で固まる」状態になる。
 *
 * 完了検知はイベントではなく `edit_models_list` の再問い合わせで確定させる
 * (イベントを取りこぼしても止まらないようにする)。
 */
async function ensureSegmentModel(
  report: (message: string) => void,
  timeoutMs = 20 * 60 * 1000,
): Promise<void> {
  const isReady = async () => {
    const models = await editModels.list();
    const target = models.find((model) => model.id === SEGMENT_MODEL_ID);
    if (!target) throw new Error("背景透過モデルの情報が見つかりません。");
    return target.downloaded;
  };

  if (await isReady()) return;

  report("背景を透過する準備をしています…（初回だけダウンロードがあります）");
  let failure: string | null = null;
  // 進捗イベントを直接受ける (store の購読者が編集タブに居ないため)。
  const unlisten = await onEditModelProgress((progress) => {
    if (progress.modelId !== SEGMENT_MODEL_ID) return;
    useEditModels.getState().applyProgress(progress);
    if (progress.kind === "failed") {
      failure = progress.reason;
    } else if (progress.kind === "progress" && progress.totalBytes > 0) {
      const percent = Math.round((progress.downloadedBytes / progress.totalBytes) * 100);
      report(`背景を透過する準備をしています… ${percent}%`);
    }
  });
  try {
    await useEditModels.getState().download([SEGMENT_MODEL_ID]);
    const startedAt = Date.now();
    // 完了までポーリングする。edit_models_download は spawn して即 return する
    // (待ってくれない) ので、ここで待たないとモデル未着のまま推論へ進んでしまう。
    while (Date.now() - startedAt < timeoutMs) {
      if (failure) {
        throw new Error(`背景透過モデルのダウンロードに失敗しました: ${failure}`);
      }
      if (await isReady()) {
        report("背景を透過しています…");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      "背景透過モデルのダウンロードが終わりませんでした。通信環境を確認して、もう一度お試しください。",
    );
  } finally {
    unlisten();
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 編集タブのマウント直後など、Fabric canvas が store に登録されるまで少し待つ。 */
async function waitForEditorCanvas(timeoutMs = 4_000): Promise<unknown | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const canvas = useEditor.getState().canvas;
    if (canvas) return canvas;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return useEditor.getState().canvas;
}

function isValidNormalizedBbox(
  bbox: [number, number, number, number],
): boolean {
  const [x, y, width, height] = bbox;
  return (
    bbox.length === 4 &&
    bbox.every((value) => Number.isFinite(value)) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x <= 1 &&
    y <= 1 &&
    x + width <= 1 &&
    y + height <= 1
  );
}

/** フルサイズの不透明な黒マスク canvas を作る（各マスク経路の共通土台）。 */
function createBlackMaskCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas context を取得できません。");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}

/** クロップPNG (bbox位置) をフルサイズの白黒マスク dataURL にする。 */
async function buildFullSizeMaskFromCrop(
  cropPath: string,
  bbox: [number, number, number, number],
  canvas: unknown,
): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const { getCanvasBaseSize } = await import("./magicLayerToFabric");
  const base = getCanvasBaseSize(canvas as never);
  if (!base) throw new Error("元画像の寸法が取得できません。");
  const img = await loadHtmlImage(convertFileSrc(cropPath));
  const { canvas: work, context: ctx } = createBlackMaskCanvas(base.width, base.height);
  ctx.drawImage(img, bbox[0], bbox[1]);
  const data = ctx.getImageData(0, 0, work.width, work.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i + 3] > 16 ? 255 : 0;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return work.toDataURL("image/png");
}

/** 正規化 bbox を元画像の実寸に合わせ、フルサイズの矩形マスクにする。 */
async function buildFullSizeMaskFromNormalizedBbox(
  sourcePath: string,
  bboxNorm: [number, number, number, number],
): Promise<{ dataUrl: string; bbox: [number, number, number, number] }> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const image = await loadHtmlImage(convertFileSrc(sourcePath));
  const imageWidth = image.naturalWidth;
  const imageHeight = image.naturalHeight;
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("元画像の寸法が取得できません。");
  }
  const [x, y, width, height] = bboxNorm;
  const left = Math.floor(x * imageWidth);
  const top = Math.floor(y * imageHeight);
  const right = Math.min(imageWidth, Math.ceil((x + width) * imageWidth));
  const bottom = Math.min(imageHeight, Math.ceil((y + height) * imageHeight));
  const bbox: [number, number, number, number] = [
    left,
    top,
    right - left,
    bottom - top,
  ];
  const { canvas, context } = createBlackMaskCanvas(imageWidth, imageHeight);
  context.fillStyle = "#fff";
  context.fillRect(...bbox);
  return { dataUrl: canvas.toDataURL("image/png"), bbox };
}

/** 元画像と生成結果の差分領域を透過パッチにする (bbox+余白の範囲だけ見る)。 */
async function buildDiffPatch(
  sourcePath: string,
  generatedPath: string,
  bbox: [number, number, number, number],
  limitToBbox = false,
): Promise<{ dataUrl: string; left: number; top: number; width: number; height: number }> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const [src, gen] = await Promise.all([
    loadHtmlImage(convertFileSrc(sourcePath)),
    loadHtmlImage(convertFileSrc(generatedPath)),
  ]);
  const pad = 24;
  const left = Math.max(0, Math.round(bbox[0]) - pad);
  const top = Math.max(0, Math.round(bbox[1]) - pad);
  const width = Math.min(src.naturalWidth - left, Math.round(bbox[2]) + pad * 2);
  const height = Math.min(src.naturalHeight - top, Math.round(bbox[3]) + pad * 2);
  // 生成結果は元画像と同解像度とは限らないためスケールを合わせて読む。
  const scaleX = gen.naturalWidth / src.naturalWidth;
  const scaleY = gen.naturalHeight / src.naturalHeight;

  const draw = (img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number) => {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("canvas context を取得できません。");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    return { canvas: c, ctx };
  };
  const srcDraw = draw(src, left, top, width, height);
  const genDraw = draw(gen, left * scaleX, top * scaleY, width * scaleX, height * scaleY);

  const srcData = srcDraw.ctx.getImageData(0, 0, width, height);
  const genData = genDraw.ctx.getImageData(0, 0, width, height);
  const out = genDraw.ctx.createImageData(width, height);
  const bboxRight = bbox[0] + bbox[2];
  const bboxBottom = bbox[1] + bbox[3];
  for (let i = 0; i < out.data.length; i += 4) {
    const pixelIndex = i / 4;
    const sourceX = left + (pixelIndex % width);
    const sourceY = top + Math.floor(pixelIndex / width);
    const insideBbox =
      sourceX >= bbox[0] &&
      sourceX < bboxRight &&
      sourceY >= bbox[1] &&
      sourceY < bboxBottom;
    const diff =
      Math.abs(srcData.data[i] - genData.data[i]) +
      Math.abs(srcData.data[i + 1] - genData.data[i + 1]) +
      Math.abs(srcData.data[i + 2] - genData.data[i + 2]);
    out.data[i] = genData.data[i];
    out.data[i + 1] = genData.data[i + 1];
    out.data[i + 2] = genData.data[i + 2];
    // 赤入れ経路は bbox 外を必ず透明にし、最終合成でマスク外の変更画素を 0 にする。
    // 既存の diff>36 判定は維持し、生成画像を丸ごと採用しない。
    out.data[i + 3] = diff > 36 && (!limitToBbox || insideBbox) ? 255 : 0;
  }
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  const rctx = result.getContext("2d");
  if (!rctx) throw new Error("canvas context を取得できません。");
  rctx.putImageData(out, 0, 0);
  return { dataUrl: result.toDataURL("image/png"), left, top, width, height };
}

/** dataURL の base64 本体をバイト列へ。 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}
