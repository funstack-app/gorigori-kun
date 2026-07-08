import { open } from "@tauri-apps/plugin-dialog";

import {
  editGrab,
  editInpaint,
  editMagic,
  editOcr,
  editSam2,
  editSegment,
  editWords,
  editExport,
  codexVision,
  images,
} from "../../../lib/ipc";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useEditMagic } from "../../../lib/store/editMagic";
import { useProjects } from "../../../lib/store/projects";
import type { EditorTool } from "./editorStore";
import { OBJECT_COUNT_BY_MODE, useEditor } from "./editorStore";
import {
  addImageLayerToCanvas,
  addMaskLayerFromBase64,
  addTextLayer,
  addTextRegionsToCanvas,
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
import { restoreCanvas } from "./history";
import { groupSelectedLayers, ungroupLayer } from "./layerHelpers";
import { normalizeGenre, type LayerGenre } from "../../../lib/edit/genre";
import { resolveWord, splitWordsInput } from "../../../lib/edit/wordPresets";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

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
    setSourceImagePath(selected);
    await openImageForEditing(selected);
  };

  /**
   * 画像を開いた直後の待機状態を作る (勝手に分解を始めない)。
   * なぜ: 分解方法が「自動レイヤー分解」と「ことばで分離」の2系統になったため、
   * どちらでいくかはユーザーが選ぶ (2026-07-03 STΛCK指摘)。
   */
  const openImageForEditing = async (path: string) => {
    if (!canvas) return;
    await showSourceImagePreview(canvas, path);
    resetHistory();
    bumpRevision();
    setMessage("画像を開きました。右の「レイヤーに分解する」か、左レールの「ことばで分離」を選んでください。");
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
      setSourceImagePath(path);
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
      setSourceImagePath(path);
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
    restyleSelectedLayer,
    chooseImage,
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
  const work = document.createElement("canvas");
  work.width = base.width;
  work.height = base.height;
  const ctx = work.getContext("2d");
  if (!ctx) throw new Error("canvas context を取得できません。");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, work.width, work.height);
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

/** 元画像と生成結果の差分領域を透過パッチにする (bbox+余白の範囲だけ見る)。 */
async function buildDiffPatch(
  sourcePath: string,
  generatedPath: string,
  bbox: [number, number, number, number],
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
  for (let i = 0; i < out.data.length; i += 4) {
    const diff =
      Math.abs(srcData.data[i] - genData.data[i]) +
      Math.abs(srcData.data[i + 1] - genData.data[i + 1]) +
      Math.abs(srcData.data[i + 2] - genData.data[i + 2]);
    out.data[i] = genData.data[i];
    out.data[i + 1] = genData.data[i + 1];
    out.data[i + 2] = genData.data[i + 2];
    out.data[i + 3] = diff > 36 ? 255 : 0;
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
