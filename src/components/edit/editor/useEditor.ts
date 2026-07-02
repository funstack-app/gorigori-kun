import { open } from "@tauri-apps/plugin-dialog";

import {
  editGrab,
  editInpaint,
  editMagic,
  editOcr,
  editSam2,
  editSegment,
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
  applyGrabResultToCanvas,
  applyMagicLayerToCanvas,
  applySegmentResultToCanvas,
  removeGrabPreviewOverlay,
  showGrabPreviewOverlay,
} from "./magicLayerToFabric";

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
    if (tool === "text-add") {
      await addTextLayer(canvas);
      bumpRevision();
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
    await runMagic(selected, "magic", projectName);
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
      setMessage(`Magic Layer 完了: テキスト ${result.textLayers.length}件`);
      bumpRevision();
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

  const saveDroppedFileAndRunMagic = async (file: File) => {
    const shouldClear = (canvas as { getObjects?: () => unknown[] } | null)?.getObjects?.().length;
    if (shouldClear) {
      const message = "既存レイヤーをクリアして、この画像で Magic Layer を実行しますか?";
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
      await runMagic(path, "magic", projectName);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      const message = "既存レイヤーをクリアして、この画像で Magic Layer を実行しますか?";
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
      await runMagic(path, "magic", projectName);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusyTool(null);
    }
  };

  return {
    run,
    chooseImage,
    runMagic,
    handleCanvasClickForTool,
    confirmGrab,
    cancelGrab,
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
