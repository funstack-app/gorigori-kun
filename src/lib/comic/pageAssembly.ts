/**
 * 「きっちりコマ割り」のページ合成。
 *
 * 純関数で座標・中央cover・枠線幅を先に決め、ブラウザ境界ではその計画だけを
 * Canvasへ描く。出力は常に白地1080x1440で、画像は縦横同じ倍率のまま切り抜く。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import type { ComicLayoutTemplate, ComicPanelSlot } from "./layoutTemplates";
import type { ComicFrameStyle } from "./types";

export const STRUCTURE_PAGE_W = 1080;
export const STRUCTURE_PAGE_H = 1440;

/** 再組立はテンプレ座標を正とし、紙と枠線だけを固定する。 */
export const RECOMPOSE_PAGE_PAPER = "#ffffff";
export const RECOMPOSE_PANEL_BORDER_PX = 3;
export const RECOMPOSE_SOURCE_INSET_EXTRA_PX = 1;
export const RECOMPOSE_ASPECT_COVER_THRESHOLD = 0.1;

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

export type RecompositionPanelPlan = AssemblyPanelPlan & {
  /** 照合で得た実枠の、元画像上のpx矩形。 */
  matchedRect: PxRect;
  /** 実枠から検出枠線+1pxを除いた、絵だけの矩形。 */
  insetRect: PxRect;
  /** drawImageへ渡す最終切り出し矩形。 */
  sourceCrop: PxRect;
  /** 実枠とテンプレ枠の比率差が10%を超え、coverを適用した。 */
  coverApplied: boolean;
};

export type RecompositionPlan = {
  pageW: number;
  pageH: number;
  panels: RecompositionPanelPlan[];
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

/** 紙端に重なる辺を除き、実際に焼き込む枠線だけのpathを作る。 */
function panelBorderPath(panel: AssemblyPanelPlan): Path2D | null {
  const points = panel.clipPolygon ?? [
    { x: panel.rect.x, y: panel.rect.y },
    { x: panel.rect.x + panel.rect.w, y: panel.rect.y },
    { x: panel.rect.x + panel.rect.w, y: panel.rect.y + panel.rect.h },
    { x: panel.rect.x, y: panel.rect.y + panel.rect.h },
  ];
  const pageEdgeFlags = points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    return (
      (start.x === 0 && end.x === 0) ||
      (start.x === STRUCTURE_PAGE_W && end.x === STRUCTURE_PAGE_W) ||
      (start.y === 0 && end.y === 0) ||
      (start.y === STRUCTURE_PAGE_H && end.y === STRUCTURE_PAGE_H)
    );
  });
  if (pageEdgeFlags.every(Boolean)) return null;
  if (pageEdgeFlags.every((flag) => !flag)) return panelPath(panel);

  const firstDrawable = pageEdgeFlags.findIndex(
    (flag, index) => !flag && pageEdgeFlags[(index - 1 + points.length) % points.length],
  );
  const path = new Path2D();
  for (let offset = 0; offset < points.length; offset += 1) {
    const index = (firstDrawable + offset) % points.length;
    if (pageEdgeFlags[index]) continue;
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (pageEdgeFlags[(index - 1 + points.length) % points.length]) {
      path.moveTo(start.x, start.y);
    }
    path.lineTo(end.x, end.y);
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

function createWhitePageCanvas(pageW: number, pageH: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = pageW;
  canvas.height = pageH;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("漫画ページの合成に必要なcanvasを取得できません。");

  context.fillStyle = RECOMPOSE_PAGE_PAPER;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

function drawClippedPanel(
  context: CanvasRenderingContext2D,
  panel: AssemblyPanelPlan,
  drawContent?: () => void,
): void {
  const path = panelPath(panel);
  context.save();
  context.clip(path);
  drawContent?.();
  context.strokeStyle = "#000";
  // stroke中心の外側半分はclipで切られるため、指定幅の2倍で描く。
  context.lineWidth = panel.borderWidthPx * 2;
  context.lineJoin = "miter";
  context.lineCap = "butt";
  const borderPath = panelBorderPath(panel);
  if (borderPath) context.stroke(borderPath);
  context.restore();
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
  const { canvas, context } = createWhitePageCanvas(plan.pageW, plan.pageH);

  for (let index = 0; index < plan.panels.length; index += 1) {
    const panel = plan.panels[index];
    const imagePath = args.panelImagePaths[index];
    if (imagePath) {
      const image = await loadImage(imagePath);
      const crop = coverCrop(
        image.naturalWidth,
        image.naturalHeight,
        panel.rect.w,
        panel.rect.h,
      );
      drawClippedPanel(
        context,
        panel,
        () =>
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
          ),
      );
    } else {
      drawClippedPanel(context, panel);
    }
  }

  return canvasToPngBytes(canvas);
}

/**
 * 照合済みの実枠とテンプレから、再組立の切り出し・配置計画を決める。
 * 配置先は一律マージン/ガターではなく、template.slots のpercent座標を
 * 1080x1440へ換算した値だけを正とする。
 */
export function buildRecompositionPlan(args: {
  alignedSlots: ComicPanelSlot[];
  template: ComicLayoutTemplate;
  sourceWidth: number;
  sourceHeight: number;
  borderPx: number;
}): RecompositionPlan {
  requirePositiveFinite(args.sourceWidth, "sourceWidth");
  requirePositiveFinite(args.sourceHeight, "sourceHeight");
  requireFinite(args.borderPx, "borderPx");
  if (args.borderPx < 0) {
    throw new Error("borderPx は0以上で指定してください。");
  }
  if (args.alignedSlots.length !== args.template.slots.length) {
    throw new Error("照合済み実枠とテンプレのコマ数が一致しません。");
  }

  const destinationPlan = buildAssemblyPlan(args.template.slots, "standard");
  const insetPx = args.borderPx + RECOMPOSE_SOURCE_INSET_EXTRA_PX;
  const panels = args.alignedSlots.map((slot, index): RecompositionPanelPlan => {
    const matchedRect = slotPixelRect(slot, args.sourceWidth, args.sourceHeight);
    const insetRect: PxRect = {
      x: matchedRect.x + insetPx,
      y: matchedRect.y + insetPx,
      w: matchedRect.w - insetPx * 2,
      h: matchedRect.h - insetPx * 2,
    };
    if (insetRect.w <= 0 || insetRect.h <= 0) {
      throw new Error(`コマ${index + 1}は枠線を除くと切り出し領域が残りません。`);
    }

    const destination = destinationPlan.panels[index];
    const sourceAspect = insetRect.w / insetRect.h;
    const destinationAspect = destination.rect.w / destination.rect.h;
    const coverApplied =
      Math.abs(sourceAspect / destinationAspect - 1) >
      RECOMPOSE_ASPECT_COVER_THRESHOLD;
    let sourceCrop = insetRect;
    if (coverApplied) {
      const crop = coverCrop(
        insetRect.w,
        insetRect.h,
        destination.rect.w,
        destination.rect.h,
      );
      sourceCrop = {
        x: insetRect.x + crop.sx,
        y: insetRect.y + crop.sy,
        w: crop.sw,
        h: crop.sh,
      };
    }

    return {
      ...destination,
      borderWidthPx: RECOMPOSE_PANEL_BORDER_PX,
      matchedRect,
      insetRect,
      sourceCrop,
      coverApplied,
    };
  });

  return {
    pageW: STRUCTURE_PAGE_W,
    pageH: STRUCTURE_PAGE_H,
    panels,
  };
}

/**
 * 元の一枚絵を、照合済み実枠から切り出してテンプレ正枠へ再組立する。
 * ファイル保存は行わず、白地1080x1440のcanvasを返す。
 */
export function recomposePageToTemplate(args: {
  sourceImage: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  alignedSlots: ComicPanelSlot[];
  template: ComicLayoutTemplate;
  borderPx: number;
}): HTMLCanvasElement {
  const plan = buildRecompositionPlan(args);
  const { canvas, context } = createWhitePageCanvas(plan.pageW, plan.pageH);

  for (const panel of plan.panels) {
    drawClippedPanel(context, panel, () =>
      context.drawImage(
        args.sourceImage,
        panel.sourceCrop.x,
        panel.sourceCrop.y,
        panel.sourceCrop.w,
        panel.sourceCrop.h,
        panel.rect.x,
        panel.rect.y,
        panel.rect.w,
        panel.rect.h,
      ),
    );
  }

  return canvas;
}
