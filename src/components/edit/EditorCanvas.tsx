import { useEffect, useRef } from "react";

import { listenEditMagicProgress } from "../../lib/edit/events";
import { extractDropped, fileToUploadReference, isImageDrop } from "../../lib/dragRef";
import { useEditMagic } from "../../lib/store/editMagic";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";
import { fitCanvasToImage } from "./editor/magicLayerToFabric";
import { objectId } from "./editor/layerHelpers";

export function EditorCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasRef = useRef<any>(null);
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const activeTool = useEditor((state) => state.activeTool);
  const message = useEditor((state) => state.message);
  const error = useEditor((state) => state.error);
  const setCanvas = useEditor((state) => state.setCanvas);
  const setSelectedLayerId = useEditor((state) => state.setSelectedLayerId);
  const bumpRevision = useEditor((state) => state.bumpRevision);
  const progress = useEditMagic((state) => state.progress);
  const grabPreview = useEditor((state) => state.grabPreview);
  const busyTool = useEditor((state) => state.busyTool);
  const actions = useEditorActions();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    // @ts-ignore fabric is installed at runtime via package dependency
    void import("fabric").then((fabric) => {
      if (disposed || !canvasRef.current || !hostRef.current) return;
      const canvas = new (fabric as any).Canvas(canvasRef.current, {
        backgroundColor: "#1a1a1a",
        preserveObjectStacking: true,
        selection: true,
      });
      fabricCanvasRef.current = canvas;
      setCanvas(canvas);

      const resize = () => {
        const rect = hostRef.current?.getBoundingClientRect();
        if (!rect) return;
        canvas.setDimensions({ width: Math.max(320, rect.width), height: Math.max(320, rect.height) });
        const objects = canvas.getObjects?.() ?? [];
        const maxWidth = Math.max(...objects.map((object: any) => object.left + (object.width ?? 0)), 0);
        const maxHeight = Math.max(...objects.map((object: any) => object.top + (object.height ?? 0)), 0);
        if (maxWidth > 0 && maxHeight > 0) fitCanvasToImage(canvas, maxWidth, maxHeight);
        canvas.requestRenderAll?.();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(hostRef.current);

      canvas.on("selection:created", (event: any) => {
        const object = event.selected?.[0];
        setSelectedLayerId(object ? objectId(object) : null);
        bumpRevision();
      });
      canvas.on("selection:updated", (event: any) => {
        const object = event.selected?.[0];
        setSelectedLayerId(object ? objectId(object) : null);
        bumpRevision();
      });
      canvas.on("selection:cleared", () => {
        setSelectedLayerId(null);
        bumpRevision();
      });
      canvas.on("object:modified", bumpRevision);
      canvas.on("object:moving", bumpRevision);
      canvas.on("object:scaling", bumpRevision);
      canvas.on("object:rotating", bumpRevision);
      canvas.on("mouse:down", (event: any) => {
        const tool = useEditor.getState().activeTool;
        if (tool !== "clickseg" && tool !== "grab") return;
        const pointer = canvas.getPointer(event.e);
        const objects = canvas.getObjects?.() ?? [];
        const imageWidth = Math.max(...objects.map((object: any) => object.left + (object.width ?? 0)), canvas.getWidth?.() ?? 1);
        const imageHeight = Math.max(...objects.map((object: any) => object.top + (object.height ?? 0)), canvas.getHeight?.() ?? 1);
        const x = Math.min(1, Math.max(0, pointer.x / Math.max(1, imageWidth)));
        const y = Math.min(1, Math.max(0, pointer.y / Math.max(1, imageHeight)));
        void actionsRef.current.handleCanvasClickForTool(x, y);
      });

      cleanup = () => {
        observer.disconnect();
        canvas.dispose?.();
        fabricCanvasRef.current = null;
        setCanvas(null);
      };
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [bumpRevision, setCanvas, setSelectedLayerId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const store = useEditMagic.getState();
    void listenEditMagicProgress((payload) => store.setProgress(payload)).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 外部 OS ファイル / 別モニタからの Tauri ネイティブ D&D は window 全体イベント
  // として attachWindowDragDrop が受ける。編集タブがアクティブな間だけ、path 取り込み
  // ハンドラを store に登録して橋渡しする (非 React の attachWindowDragDrop から呼べる)。
  const setPathIngestor = useEditor((state) => state.setPathIngestor);
  useEffect(() => {
    setPathIngestor((path) => {
      void actionsRef.current.saveDroppedPathAndRunMagic(path);
    });
    return () => setPathIngestor(null);
  }, [setPathIngestor]);

  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isImageDrop(event.dataTransfer)) return;
    event.preventDefault();
    // アプリ内部の参照ドラッグ (gallery / preset) は path をそのまま取り込む。
    // 外部 OS ファイルは File 経由で writeUpload してから取り込む。
    const { refs, files } = extractDropped(event.dataTransfer);
    const internalPath = refs[0]?.path;
    if (internalPath) {
      void actionsRef.current.saveDroppedPathAndRunMagic(internalPath);
      return;
    }
    const file = files[0];
    if (file) {
      void fileToUploadReference(file).then((ref) => {
        void actionsRef.current.saveDroppedPathAndRunMagic(ref.path);
      });
    }
  };

  const statusText = progress ? progressLabel(progress.kind) : message;

  return (
    <main
      ref={hostRef}
      onDrop={drop}
      onDragOver={(event) => event.preventDefault()}
      className="relative min-w-0 flex-1 overflow-hidden bg-[#1a1a1a]"
    >
      <canvas ref={canvasRef} id="editor-canvas" className="block" />

      {!sourceImagePath ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <div className="pointer-events-auto max-w-sm rounded-2xl border border-dashed border-pink-400/50 bg-[#101010]/90 p-6 text-center shadow-2xl">
            <div className="flex justify-center text-pink-300">
              <DropLayersIcon />
            </div>
            <h3 className="mt-3 text-sm font-black text-white">画像をドロップ</h3>
            <p className="mt-2 text-xs font-bold leading-5 text-neutral-400">
              ドロップすると自動でレイヤー分解され、背景・前景・テキストに分かれます。
            </p>
            <button
              type="button"
              onClick={() => void actions.chooseImage()}
              className="mt-4 rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-600"
            >
              画像を選ぶ
            </button>
          </div>
        </div>
      ) : null}

      {activeTool === "clickseg" ? (
        <div className="absolute left-4 top-4 rounded-full border border-amber-300/60 bg-amber-300/15 px-3 py-1 text-xs font-black text-amber-100">
          対象をクリック
        </div>
      ) : null}

      {activeTool === "grab" && !grabPreview ? (
        <div className="absolute left-4 top-4 rounded-full border border-pink-400/60 bg-pink-500/15 px-3 py-1 text-xs font-black text-pink-100">
          掴みたい対象をクリック
        </div>
      ) : null}

      {activeTool === "grab" && grabPreview ? (
        <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full border border-pink-400/60 bg-[#101010]/95 px-3 py-1.5 shadow-xl">
          <span className="text-xs font-bold text-neutral-200">この範囲を掴みますか?</span>
          <button
            type="button"
            onClick={() => void actions.confirmGrab()}
            disabled={busyTool === "grab"}
            className="rounded-full bg-pink-500 px-3 py-1 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busyTool === "grab" ? "処理中…" : "掴む"}
          </button>
          <button
            type="button"
            onClick={() => actions.cancelGrab()}
            disabled={busyTool === "grab"}
            className="rounded-full border border-[#343434] px-3 py-1 text-xs font-bold text-neutral-300 hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-40"
          >
            やり直す
          </button>
        </div>
      ) : null}

      {(statusText || error) ? (
        <div className="absolute bottom-4 left-4 right-4 flex justify-center">
          <div className={`max-w-2xl rounded-full border px-4 py-2 text-xs font-bold shadow-xl ${
            error
              ? "border-red-500/50 bg-red-500/15 text-red-100"
              : "border-[#343434] bg-[#101010]/90 text-neutral-200"
          }`}
          >
            {error ?? statusText}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function progressLabel(kind: string): string {
  const labels: Record<string, string> = {
    started: "レイヤー分解を開始…",
    detectingText: "テキストを検出中…",
    removingText: "テキストを除去中…",
    segmenting: "人物を切り抜き中…",
    inpaintingBackground: "背景を補完中…",
    buildingTextLayers: "レイヤーを構築中…",
    completed: "完了しました",
    failed: "失敗しました",
  };
  return labels[kind] ?? kind;
}

function DropLayersIcon() {
  return (
    <svg
      width={40}
      height={40}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </svg>
  );
}
