import { open } from "@tauri-apps/plugin-dialog";

import {
  editGrab,
  editInpaint,
  editMagic,
  editOcr,
  editSam2,
  editSegment,
  editWords,
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
  showSourceImagePreview,
  applyGrabResultToCanvas,
  applyMagicLayerToCanvas,
  applySegmentResultToCanvas,
  removeGrabPreviewOverlay,
  showGrabPreviewOverlay,
} from "./magicLayerToFabric";
import { restoreCanvas } from "./history";
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
      const result = await editWords.segment(
        sourceImagePath,
        resolved.map((w) => ({ prompt: w.prompt, label: w.label })),
        projectName,
      );
      const added = await addWordLayersToCanvas(canvas, result);
      if (added > 0) {
        bumpRevision();
        pushHistory();
        setMessage(`${added}個のレイヤーを切り出しました。右の一覧から選んで動かせます。`);
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
      const result = await editWords.segment(
        sourceImagePath,
        objects.map((o) => ({ prompt: o.en, label: o.ja })),
        projectName,
      );
      const added = await addWordLayersToCanvas(canvas, result);
      if (added > 0) {
        bumpRevision();
        pushHistory();
        setMessage(`${added}個のレイヤーを切り出しました。足りないものは「ことば」を入力して追加できます。`);
      } else {
        setMessage("切り出せるものが見つかりませんでした。「ことば」を直接入力して試してください。");
      }
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
