/**
 * 「きっちりコマ割り」のページ合成。
 *
 * 純関数で座標・中央cover・枠線幅を先に決め、ブラウザ境界ではその計画だけを
 * Canvasへ描く。出力は常に白地1080x1440で、画像は縦横同じ倍率のまま切り抜く。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import type { ComicPanelSlot } from "./layoutTemplates";
import type { ComicFrameStyle } from "./types";

export const STRUCTURE_PAGE_W = 1080;
export const STRUCTURE_PAGE_H = 1440;

export type PxRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PxPoint = {
  x: number;
  y: number;
};

export type AssemblyPanelPlan = {
  rect: PxRect;
  clipPolygon?: PxPoint[];
  borderWidthPx: number;
};

export type AssemblyPlan = {
  pageW: number;
  pageH: number;
  panels: AssemblyPanelPlan[];
};

const ASPECT_CANDIDATES = [
  { label: "9:16", ratio: 9 / 16 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "3:4", ratio: 3 / 4 },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "16:9", ratio: 16 / 9 },
] as const;

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} は0より大きい有限値で指定してください。`);
  }
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} は有限値で指定してください。`);
  }
}

/** percent スロットを、指定ページ上の整数px矩形へ変換する。 */
export function slotPixelRect(
  slot: ComicPanelSlot,
  pageW: number,
  pageH: number,
): PxRect {
  requirePositiveFinite(pageW, "pageW");
  requirePositiveFinite(pageH, "pageH");
  return {
    x: Math.round((slot.x / 100) * pageW),
    y: Math.round((slot.y / 100) * pageH),
    w: Math.round((slot.w / 100) * pageW),
    h: Math.round((slot.h / 100) * pageH),
  };
}

/** 斜めコマのページpercent頂点を整数pxへ変換する。矩形コマは undefined。 */
export function slotClipPolygonPx(
  slot: ComicPanelSlot,
  pageW: number,
  pageH: number,
): PxPoint[] | undefined {
  if (!slot.points) return undefined;
  requirePositiveFinite(pageW, "pageW");
  requirePositiveFinite(pageH, "pageH");
  return slot.points.map(([x, y]) => ({
    x: Math.round((x / 100) * pageW),
    y: Math.round((y / 100) * pageH),
  }));
}

/**
 * cover描画で使う、元画像側の中央切り出し窓。
 * 出力先へはこの窓を縦横同じ倍率で拡大・縮小するため、非等方の歪みが生じない。
 */
export function coverCrop(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  requirePositiveFinite(srcW, "srcW");
  requirePositiveFinite(srcH, "srcH");
  requirePositiveFinite(dstW, "dstW");
  requirePositiveFinite(dstH, "dstH");

  const scale = Math.max(dstW / srcW, dstH / srcH);
  const sw = dstW / scale;
  const sh = dstH / scale;
  return {
    sx: (srcW - sw) / 2,
    sy: (srcH - sh) / 2,
    sw,
    sh,
  };
}

/** スロット実比率にlog距離で最も近い、画像生成用aspectヒントを返す。 */
export function nearestAspectLabel(ratio: number): string {
  requirePositiveFinite(ratio, "ratio");
  let nearest: (typeof ASPECT_CANDIDATES)[number] = ASPECT_CANDIDATES[0];
  let nearestDistance = Math.abs(Math.log(ratio / nearest.ratio));
  for (const candidate of ASPECT_CANDIDATES.slice(1)) {
    const distance = Math.abs(Math.log(ratio / candidate.ratio));
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest.label;
}

/** 枠線幅を短辺比率から整数pxで決定する。 */
export function borderWidthPxFor(
  frameStyle: ComicFrameStyle,
  pageW: number,
  pageH: number,
): number {
  requirePositiveFinite(pageW, "pageW");
  requirePositiveFinite(pageH, "pageH");
  const shortEdge = Math.min(pageW, pageH);
  const rule: Record<ComicFrameStyle, { min: number; ratio: number }> = {
    thin: { min: 2, ratio: 0.0015 },
    standard: { min: 2, ratio: 0.003 },
    bold: { min: 3, ratio: 0.006 },
  };
  return Math.max(rule[frameStyle].min, Math.round(shortEdge * rule[frameStyle].ratio));
}

function polygonArea(points: PxPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

/** コマごとのpx矩形・clip多角形・枠線幅を決める。 */
export function buildAssemblyPlan(
  slots: ComicPanelSlot[],
  frameStyle: ComicFrameStyle,
): AssemblyPlan {
  if (slots.length === 0) {
    throw new Error("はめ込むコマがありません。");
  }
  const borderWidthPx = borderWidthPxFor(
    frameStyle,
    STRUCTURE_PAGE_W,
    STRUCTURE_PAGE_H,
  );
  const panels = slots.map((slot, index): AssemblyPanelPlan => {
    for (const [label, value] of Object.entries({
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
    })) {
      requireFinite(value, `slots[${index}].${label}`);
    }
    if (slot.w <= 0 || slot.h <= 0) {
      throw new Error(`コマ${index + 1}のスロットが退化しています。`);
    }
    if (slot.points && slot.points.length !== 4) {
      throw new Error(`コマ${index + 1}の斜めスロットは4点で指定してください。`);
    }
    if (slot.points) {
      for (const [pointIndex, point] of slot.points.entries()) {
        requireFinite(point[0], `slots[${index}].points[${pointIndex}][0]`);
        requireFinite(point[1], `slots[${index}].points[${pointIndex}][1]`);
      }
    }

    const rect = slotPixelRect(slot, STRUCTURE_PAGE_W, STRUCTURE_PAGE_H);
    if (rect.w <= 0 || rect.h <= 0) {
      throw new Error(`コマ${index + 1}のpxスロットが退化しています。`);
    }
    const clipPolygon = slotClipPolygonPx(
      slot,
      STRUCTURE_PAGE_W,
      STRUCTURE_PAGE_H,
    );
    if (clipPolygon && polygonArea(clipPolygon) <= 0) {
      throw new Error(`コマ${index + 1}のclip多角形が退化しています。`);
    }
    return { rect, clipPolygon, borderWidthPx };
  });

  return {
    pageW: STRUCTURE_PAGE_W,
    pageH: STRUCTURE_PAGE_H,
    panels,
  };
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`画像を読み込めません: ${path}`));
    image.src = convertFileSrc(path);
  });
}

function panelPath(panel: AssemblyPanelPlan): Path2D {
  const path = new Path2D();
  if (panel.clipPolygon) {
    const [first, ...rest] = panel.clipPolygon;
    path.moveTo(first.x, first.y);
    for (const point of rest) path.lineTo(point.x, point.y);
    path.closePath();
  } else {
    path.rect(panel.rect.x, panel.rect.y, panel.rect.w, panel.rect.h);
  }
  return path;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")).then(
    async (blob) => {
      if (!blob) throw new Error("漫画ページのPNG化に失敗しました。");
      return new Uint8Array(await blob.arrayBuffer());
    },
  );
}

/**
 * 白地1080x1440へ全コマをcover-clipで描き、枠線まで焼き込んだPNG bytesを返す。
 * undefined のコマは白地を残し、枠線だけを描く。
 */
export async function assembleStructurePage(args: {
  panelImagePaths: (string | undefined)[];
  slots: ComicPanelSlot[];
  frameStyle: ComicFrameStyle;
}): Promise<Uint8Array> {
  if (args.panelImagePaths.length !== args.slots.length) {
    throw new Error("コマ画像とスロットの数が一致しません。");
  }
  const plan = buildAssemblyPlan(args.slots, args.frameStyle);
  const canvas = document.createElement("canvas");
  canvas.width = plan.pageW;
  canvas.height = plan.pageH;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("漫画ページの合成に必要なcanvasを取得できません。");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (let index = 0; index < plan.panels.length; index += 1) {
    const panel = plan.panels[index];
    const path = panelPath(panel);
    context.save();
    context.clip(path);

    const imagePath = args.panelImagePaths[index];
    if (imagePath) {
      const image = await loadImage(imagePath);
      const crop = coverCrop(
        image.naturalWidth,
        image.naturalHeight,
        panel.rect.w,
        panel.rect.h,
      );
      context.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        panel.rect.x,
        panel.rect.y,
        panel.rect.w,
        panel.rect.h,
      );
    }

    context.strokeStyle = "#000";
    context.lineWidth = panel.borderWidthPx * 2;
    context.lineJoin = "miter";
    context.lineCap = "butt";
    context.stroke(path);
    context.restore();
  }

  return canvasToPngBytes(canvas);
}
