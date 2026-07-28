import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { remove, writeFile } from "@tauri-apps/plugin-fs";
import { useEffect, useMemo, useRef, useState } from "react";

import { editExport } from "../../lib/ipc";
import type { ClickMaskLayer, PsdComposition, TextLayerSpec } from "../../lib/edit/types";

type LayerComposerProps = {
  background: string | null;
  foreground: string | null;
  textLayers: TextLayerSpec[];
  clickMasks: ClickMaskLayer[];
};

type ComposerLayer = {
  id: string;
  kind: "image" | "text";
  name: string;
  z: number;
  path?: string;
  text?: string;
  font: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  visible: boolean;
};

type DragMode = "move" | "resize";

type DragState = {
  id: string;
  mode: DragMode;
  startX: number;
  startY: number;
  layer: ComposerLayer;
};

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;

function layerId(prefix: string, index: number) {
  return `${prefix}-${index}`;
}

function normalizeColor(color: string | undefined) {
  return color?.trim() || "#ffffff";
}

export function LayerComposer({ background, foreground, textLayers, clickMasks }: LayerComposerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCache = useRef(new Map<string, HTMLImageElement>());
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [layers, setLayers] = useState<ComposerLayer[]>([]);

  useEffect(() => {
    const next: ComposerLayer[] = [];
    if (background) {
      next.push({
        id: "background",
        kind: "image",
        name: "背景",
        z: 0,
        path: background,
        font: "sans-serif",
        color: "#ffffff",
        x: 0,
        y: 0,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        opacity: 1,
        rotation: 0,
        visible: true,
      });
    }
    clickMasks.forEach((mask, index) => {
      const path = mask.imagePath ?? mask.path;
      if (!path) return;
      next.push({
        id: mask.id ?? layerId("click-mask", index),
        kind: "image",
        name: mask.name ?? `クリック切り抜き ${index + 1}`,
        z: 10 + index,
        path,
        font: "sans-serif",
        color: "#ffffff",
        x: mask.x ?? 0,
        y: mask.y ?? 0,
        width: mask.width ?? Math.round(CANVAS_WIDTH * 0.35),
        height: mask.height ?? Math.round(CANVAS_HEIGHT * 0.35),
        opacity: mask.opacity ?? 1,
        rotation: mask.rotation ?? 0,
        visible: mask.visible ?? true,
      });
    });
    if (foreground) {
      next.push({
        id: "foreground",
        kind: "image",
        name: "前景",
        z: 20,
        path: foreground,
        font: "sans-serif",
        color: "#ffffff",
        x: 0,
        y: 0,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        opacity: 1,
        rotation: 0,
        visible: true,
      });
    }
    textLayers.forEach((text, index) => {
      const size = text.size ?? 48;
      next.push({
        id: text.id ?? layerId("text", index),
        kind: "text",
        name: text.name ?? `テキスト ${index + 1}`,
        z: 30 + index,
        text: text.text,
        font: text.font ?? "sans-serif",
        color: normalizeColor(text.color),
        x: text.x ?? 48,
        y: text.y ?? 96 + index * (size + 16),
        width: Math.max(120, text.text.length * size * 0.65),
        height: size * 1.4,
        opacity: text.opacity ?? 1,
        rotation: text.rotation ?? 0,
        visible: text.visible ?? true,
      });
    });
    setLayers(next.sort((a, b) => a.z - b.z));
    setSelectedLayerId((current) => (current && next.some((layer) => layer.id === current) ? current : next[0]?.id ?? null));
  }, [background, foreground, textLayers, clickMasks]);

  const selectedLayer = useMemo(
    () => layers.find((layer) => layer.id === selectedLayerId) ?? null,
    [layers, selectedLayerId],
  );

  const draw = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const layer of layers) {
      if (!layer.visible) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      const cx = layer.x + layer.width / 2;
      const cy = layer.y + layer.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);

      if (layer.kind === "image" && layer.path) {
        let img = imageCache.current.get(layer.path);
        if (!img) {
          img = await loadImage(convertFileSrc(layer.path));
          imageCache.current.set(layer.path, img);
        }
        ctx.drawImage(img, layer.x, layer.y, layer.width, layer.height);
      } else if (layer.kind === "text") {
        const size = Math.max(8, Math.round(layer.height / 1.4));
        ctx.font = `900 ${size}px ${layer.font}`;
        ctx.fillStyle = layer.color;
        ctx.textBaseline = "top";
        ctx.fillText(layer.text ?? "", layer.x, layer.y);
      }
      ctx.restore();
    }

    if (selectedLayer) {
      ctx.save();
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(selectedLayer.x, selectedLayer.y, selectedLayer.width, selectedLayer.height);
      ctx.setLineDash([]);
      ctx.fillStyle = "#ec4899";
      ctx.fillRect(selectedLayer.x + selectedLayer.width - 8, selectedLayer.y + selectedLayer.height - 8, 8, 8);
      ctx.restore();
    }
  };

  useEffect(() => {
    void draw();
  }, [layers, selectedLayerId]);

  const updateLayer = (id: string, updater: (layer: ComposerLayer) => ComposerLayer) => {
    setLayers((current) => current.map((layer) => (layer.id === id ? updater(layer) : layer)));
  };

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = event.currentTarget.width / rect.width;
    const scaleY = event.currentTarget.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const hitTest = (x: number, y: number) => {
    return [...layers]
      .filter((layer) => layer.visible)
      .sort((a, b) => b.z - a.z)
      .find((layer) => x >= layer.x && x <= layer.x + layer.width && y >= layer.y && y <= layer.y + layer.height);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = canvasPoint(event);
    const layer = hitTest(point.x, point.y);
    if (!layer) {
      setSelectedLayerId(null);
      return;
    }
    setSelectedLayerId(layer.id);
    const resize = point.x >= layer.x + layer.width - 18 && point.y >= layer.y + layer.height - 18;
    setDrag({ id: layer.id, mode: resize ? "resize" : "move", startX: point.x, startY: point.y, layer });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const point = canvasPoint(event);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    updateLayer(drag.id, (layer) => {
      if (drag.mode === "resize") {
        return {
          ...layer,
          width: Math.max(24, drag.layer.width + dx),
          height: Math.max(24, drag.layer.height + dy),
        };
      }
      return { ...layer, x: drag.layer.x + dx, y: drag.layer.y + dy };
    });
  };

  const exportRaster = async (format: "png" | "jpeg") => {
    await draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const path = await save({
      title: `${format.toUpperCase()}を書き出し`,
      defaultPath: `composition.${format === "jpeg" ? "jpg" : "png"}`,
      filters: [{ name: format.toUpperCase(), extensions: [format === "jpeg" ? "jpg" : "png"] }],
    });
    if (!path) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${format}`, 0.92));
    if (!blob) throw new Error("Canvas の書き出しに失敗しました。");
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    setMessage(`${format.toUpperCase()} を保存しました。`);
  };

  const exportPsd = async () => {
    const path = await save({
      title: "PSDを書き出し",
      defaultPath: "composition.psd",
      filters: [{ name: "PSD", extensions: ["psd"] }],
    });
    if (!path) return;
    await draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Canvas の PSD 用ラスタライズに失敗しました。");
    const flattenedPath = `${path}.flattened.png`;
    await writeFile(flattenedPath, new Uint8Array(await blob.arrayBuffer()));
    const composition: PsdComposition = {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      layers: [
        {
          kind: "image",
          name: "Rasterized composition",
          path: flattenedPath,
          x: 0,
          y: 0,
          opacity: 1,
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
        },
      ],
    };
    const saved = await editExport.psd(composition, path);
    await remove(flattenedPath).catch(() => undefined);
    setMessage(`PSD を保存しました: ${saved}`);
  };

  return (
    <div className="grid min-h-[560px] gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-black text-white">Layer Composer</h3>
            <p className="text-[11px] text-neutral-500">背景 → クリック切り抜き → 前景 → テキストの Z 順で合成します。</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void exportRaster("png")} className="rounded border border-[#343434] px-2 py-1 text-xs font-bold text-neutral-200 hover:border-pink-400">PNG</button>
            <button type="button" onClick={() => void exportRaster("jpeg")} className="rounded border border-[#343434] px-2 py-1 text-xs font-bold text-neutral-200 hover:border-pink-400">JPG</button>
            <button type="button" onClick={() => void exportPsd()} className="rounded bg-pink-500 px-2 py-1 text-xs font-black text-white hover:bg-pink-400">PSD</button>
          </div>
        </div>
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          className="aspect-video w-full cursor-crosshair rounded-lg border border-[#303030] bg-[#101010]"
        />
        {message && <p className="mt-2 text-xs font-bold text-emerald-200">{message}</p>}
      </section>

      <aside className="space-y-3 rounded-xl border border-[#2a2a2a] bg-[#181818] p-3">
        <h3 className="text-sm font-black text-white">レイヤー</h3>
        <div className="space-y-2">
          {[...layers].sort((a, b) => b.z - a.z).map((layer) => (
            <div key={layer.id} className={`rounded-lg border p-2 ${selectedLayerId === layer.id ? "border-pink-400 bg-pink-500/10" : "border-[#2a2a2a] bg-[#101010]"}`}>
              <button type="button" onClick={() => setSelectedLayerId(layer.id)} className="flex w-full items-center gap-1.5 truncate text-left text-xs font-black text-white">
                <ComposerVisibilityIcon visible={layer.visible} />
                <span className="truncate">{layer.name}</span>
              </button>
              <div className="mt-2 flex gap-1">
                <button type="button" onClick={() => updateLayer(layer.id, (item) => ({ ...item, visible: !item.visible }))} className="rounded border border-[#343434] px-2 py-1 text-[10px] font-bold text-neutral-300">表示</button>
                <button type="button" onClick={() => setLayers((current) => current.filter((item) => item.id !== layer.id))} className="rounded border border-red-400/40 px-2 py-1 text-[10px] font-bold text-red-200">削除</button>
              </div>
            </div>
          ))}
        </div>
        {selectedLayer && (
          <div className="space-y-2 border-t border-[#242424] pt-3 text-xs">
            <label className="block text-neutral-300">回転
              <input type="range" min={-180} max={180} value={selectedLayer.rotation} onChange={(e) => updateLayer(selectedLayer.id, (layer) => ({ ...layer, rotation: Number(e.target.value) }))} className="mt-1 w-full accent-pink-500" />
            </label>
            <label className="block text-neutral-300">不透明度
              <input type="range" min={0} max={1} step={0.05} value={selectedLayer.opacity} onChange={(e) => updateLayer(selectedLayer.id, (layer) => ({ ...layer, opacity: Number(e.target.value) }))} className="mt-1 w-full accent-pink-500" />
            </label>
          </div>
        )}
      </aside>
    </div>
  );
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // asset:// は cross-origin。crossOrigin を付けた CORS ロードでないと canvas が
    // 汚染され toBlob が "The operation is insecure." で死ぬ（pageExport.ts と同型）。
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}

/** レイヤー表示/非表示のフラットアイコン (絵文字廃止 2026-07-02)。 */
function ComposerVisibilityIcon({ visible }: { visible: boolean }) {
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return visible ? (
    <svg {...props} className="shrink-0 text-neutral-300" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg {...props} className="shrink-0 text-neutral-600" aria-hidden>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 004.2 4.2" />
      <path d="M9.3 5.3A9.5 9.5 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 3.9M6 6.6A17 17 0 002 12s3.5 7 10 7a9.3 9.3 0 003-.5" />
    </svg>
  );
}
