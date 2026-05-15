import { convertFileSrc } from "@tauri-apps/api/core";

import type { MagicLayerResult, SegmentResult, TextRegion } from "../../../lib/edit/types";
import { createLayerId } from "./layerHelpers";

type FabricModule = Record<string, any>;
type FabricCanvas = any;
type FabricObject = any;

export async function applyMagicLayerToCanvas(
  canvas: FabricCanvas,
  result: MagicLayerResult,
) {
  const fabric = await importFabric();
  clearCanvas(canvas);
  canvas.backgroundColor = "#1a1a1a";

  const bgImg = await loadFabricImage(fabric, result.backgroundPath);
  bgImg.set({
    id: "bg",
    name: "背景",
    layerKind: "image",
    left: 0,
    top: 0,
    selectable: true,
  });
  canvas.add(bgImg);

  const fgImg = await loadFabricImage(fabric, result.foregroundPath);
  fgImg.set({
    id: "fg",
    name: "前景",
    layerKind: "image",
    left: 0,
    top: 0,
    selectable: true,
  });
  canvas.add(fgImg);

  result.textLayers.forEach((text, index) => {
    const bbox = text.bbox;
    const textbox = new fabric.Textbox(text.text || "テキスト", {
      id: text.id ?? `text-${index + 1}`,
      name: text.name ?? `テキスト ${index + 1}`,
      layerKind: "text",
      left: text.x ?? bbox?.[0] ?? 50,
      top: text.y ?? bbox?.[1] ?? 50 + index * 52,
      width: bbox?.[2] ?? 240,
      fontSize: text.fontSize ?? text.size ?? 28,
      fill: text.color ?? "#ffffff",
      fontFamily: text.fontFamily ?? text.font ?? "Hiragino Sans",
      fontWeight: text.fontWeight ?? "normal",
      textAlign: text.align ?? "left",
      opacity: text.opacity ?? 1,
      angle: text.rotation ?? 0,
    });
    canvas.add(textbox);
  });

  fitCanvasToImage(canvas, result.width, result.height);
  canvas.renderAll?.();
}

export async function applySegmentResultToCanvas(
  canvas: FabricCanvas,
  result: SegmentResult,
) {
  const magicLike: MagicLayerResult = {
    backgroundPath: result.backgroundPath,
    foregroundPath: result.foregroundPath,
    maskPath: result.maskPath,
    textLayers: [],
    width: result.width,
    height: result.height,
    runDir: "",
  };
  await applyMagicLayerToCanvas(canvas, magicLike);
}

export async function addImageLayerToCanvas(
  canvas: FabricCanvas,
  imagePath: string,
  name = "画像",
  options: Record<string, unknown> = {},
) {
  const fabric = await importFabric();
  const image = await loadFabricImage(fabric, imagePath);
  image.set({
    id: createLayerId(),
    name,
    layerKind: "image",
    left: 80,
    top: 80,
    selectable: true,
    ...options,
  });
  canvas.add(image);
  canvas.setActiveObject?.(image);
  canvas.requestRenderAll?.();
  return image;
}

export async function addMaskLayerFromBase64(
  canvas: FabricCanvas,
  base64: string,
  name = "クリック切り抜きマスク",
) {
  const fabric = await importFabric();
  const image = await loadFabricImageFromUrl(fabric, `data:image/png;base64,${base64}`);
  image.set({
    id: createLayerId(),
    name,
    layerKind: "mask",
    left: 0,
    top: 0,
    opacity: 0.55,
    selectable: true,
  });
  canvas.add(image);
  canvas.setActiveObject?.(image);
  canvas.requestRenderAll?.();
  return image;
}

export async function addTextRegionsToCanvas(canvas: FabricCanvas, regions: TextRegion[]) {
  const fabric = await importFabric();
  regions.forEach((region, index) => {
    const textbox = new fabric.Textbox(region.text || "テキスト", {
      id: region.id || createLayerId(),
      name: `検出テキスト ${index + 1}`,
      layerKind: "text",
      left: region.bbox[0],
      top: region.bbox[1],
      width: Math.max(120, region.bbox[2]),
      fontSize: 28,
      fill: "#ffffff",
      fontFamily: "Hiragino Sans",
      backgroundColor: "rgba(0,0,0,0.18)",
    });
    canvas.add(textbox);
  });
  canvas.requestRenderAll?.();
}

export async function addTextLayer(canvas: FabricCanvas) {
  const fabric = await importFabric();
  const center = canvas.getCenter?.() ?? { left: 240, top: 180 };
  const textbox = new fabric.Textbox("新しいテキスト", {
    id: createLayerId(),
    name: "テキスト",
    layerKind: "text",
    left: center.left - 120,
    top: center.top - 24,
    width: 240,
    fontSize: 32,
    fill: "#ffffff",
    fontFamily: "Hiragino Sans",
    fontWeight: "normal",
  });
  canvas.add(textbox);
  canvas.setActiveObject?.(textbox);
  canvas.requestRenderAll?.();
  return textbox;
}

export function fitCanvasToImage(canvas: FabricCanvas, imageWidth: number, imageHeight: number) {
  const width = canvas.getWidth?.() ?? 1;
  const height = canvas.getHeight?.() ?? 1;
  if (!imageWidth || !imageHeight || !width || !height) return;
  const zoom = Math.min((width - 80) / imageWidth, (height - 80) / imageHeight, 1);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = (width - imageWidth * safeZoom) / 2;
  const y = (height - imageHeight * safeZoom) / 2;
  canvas.setViewportTransform?.([safeZoom, 0, 0, safeZoom, x, y]);
}

async function importFabric(): Promise<FabricModule> {
  // @ts-ignore fabric is installed at runtime via package dependency
  return import("fabric") as Promise<FabricModule>;
}

async function loadFabricImage(fabric: FabricModule, path: string): Promise<FabricObject> {
  return loadFabricImageFromUrl(fabric, convertFileSrc(path));
}

async function loadFabricImageFromUrl(fabric: FabricModule, url: string): Promise<FabricObject> {
  const ImageClass = fabric.FabricImage ?? fabric.Image;
  if (!ImageClass?.fromURL) {
    throw new Error("Fabric.js Image.fromURL が見つかりません");
  }
  const loaded = ImageClass.fromURL(url, { crossOrigin: "anonymous" });
  return typeof loaded?.then === "function" ? await loaded : loaded;
}

function clearCanvas(canvas: FabricCanvas) {
  canvas.discardActiveObject?.();
  canvas.clear?.();
  canvas.setViewportTransform?.([1, 0, 0, 1, 0, 0]);
}
