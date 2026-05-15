import { useEffect, useRef } from "react";

import { listenEditMagicProgress } from "../../lib/edit/events";
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
        if (useEditor.getState().activeTool !== "clickseg") return;
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

  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
    if (file) void actionsRef.current.saveDroppedFileAndRunMagic(file);
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
            <div className="text-4xl">✨</div>
            <h3 className="mt-3 text-sm font-black text-white">画像をドロップ</h3>
            <p className="mt-2 text-xs font-bold leading-5 text-neutral-400">
              ドロップすると Magic Layer が自動実行され、背景・前景・テキストに分解されます。
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
          🎯 対象をクリック
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
    started: "🚀 Magic Layer 開始…",
    detectingText: "📝 テキスト検出中…",
    removingText: "🎨 テキスト除去中…",
    segmenting: "✂️ 人物切り抜き中…",
    inpaintingBackground: "🖼 背景補完中…",
    buildingTextLayers: "📋 レイヤー構築中…",
    completed: "✅ 完了しました",
    failed: "⚠️ 失敗しました",
  };
  return labels[kind] ?? kind;
}
