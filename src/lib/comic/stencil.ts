/**
 * 塗り絵方式（stencil）のコマ枠部品。
 *
 * 枠を検出するのをやめ、生成前に機械で描いて確定させる。AI には
 * 「白紙に枠だけ描いたページ（scaffold）」と「コマ内側だけ白いマスク」を渡し、
 * 返ってきた絵の枠外を scaffold の画素で上書きする。枠は最初から機械の座標なので
 * 検出工程そのものが消える（設計書 S1）。
 *
 * ファイル保存・Tauri API はこのモジュールの責務外（呼び出し側が Rust 経由で保存する）。
 * 枠線の見た目の定数は pageAssembly.ts から import する（二重定義すると
 * 再組立経路と塗り絵経路で枠が食い違うため）。
 */

import {
  RECOMPOSE_PAGE_PAPER,
  RECOMPOSE_PANEL_BORDER_PX,
  slotPixelRect,
  structurePageSize,
} from "./pageAssembly";
import { isInsidePolygon, distanceToSegment } from "../imageReedit/maskReedit";
import type { RgbaRaster } from "../imageReedit/maskReedit";
import type { ComicLayoutTemplate, ComicPanelSlot } from "./layoutTemplates";
import { mirrorSlotX } from "./panelLayoutOps";
import type { ComicReadingDirection } from "./types";

/**
 * マスク白領域を枠線の内側からさらに引っ込める量（設計書 S6）。
 * 枠線のアンチエイリアスがにじむ分の代であり、0 にすると AI が触れる領域が
 * 枠線画素へ接する。
 */
export const STENCIL_MASK_BLEED_PX = 2;

/** 紙・枠線は再組立経路と同一規格（設計書 S5）。定数は pageAssembly が正本。 */
export const STENCIL_PAGE_PAPER = RECOMPOSE_PAGE_PAPER;
export const STENCIL_PANEL_BORDER_PX = RECOMPOSE_PANEL_BORDER_PX;

const MASK_WHITE = 255;
const MASK_BLACK = 0;

/** #ffffff 等の 6桁 hex を RGB へ。定数の取り違えを早期に落とす。 */
function parseHexRgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`色は #rrggbb 形式で指定してください: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function createRaster(
  width: number,
  height: number,
  fill: [number, number, number],
): RgbaRaster {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = fill[0];
    rgba[offset + 1] = fill[1];
    rgba[offset + 2] = fill[2];
    rgba[offset + 3] = 255;
  }
  return { width, height, rgba };
}

/** スロットの4頂点をページpx座標で返す。長方形は bbox の四隅。 */
function slotQuadPx(
  slot: ComicPanelSlot,
  pageW: number,
  pageH: number,
): { x: number; y: number }[] {
  if (slot.points) {
    return slot.points.map(([x, y]) => ({
      x: (x / 100) * pageW,
      y: (y / 100) * pageH,
    }));
  }
  const rect = slotPixelRect(slot, pageW, pageH);
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
}

/** 多角形の全辺への最短距離。枠線・マスクの帯幅をこの距離だけで決める。 */
function distanceToPolygonEdges(
  x: number,
  y: number,
  quad: { x: number; y: number }[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    nearest = Math.min(nearest, distanceToSegment(x, y, a, b));
  }
  return nearest;
}

/**
 * 多角形の外接矩形を、ページ内に収めた整数px走査範囲として返す。
 *
 * bbox の外の画素は定義上その多角形の内側になり得ないので、走査を bbox に
 * 限れば出力は1画素も変わらないまま計算量だけが落ちる（ページ全面を
 * コマ数ぶん舐めると ページ幅×高さ×N 回の多角形判定になり、生成のたびに待たされる）。
 */
function scanBounds(
  quad: { x: number; y: number }[],
  pageW: number,
  pageH: number,
): { fromX: number; toX: number; fromY: number; toY: number } {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  return {
    fromX: Math.max(0, Math.floor(Math.min(...xs))),
    toX: Math.min(pageW - 1, Math.ceil(Math.max(...xs))),
    fromY: Math.max(0, Math.floor(Math.min(...ys))),
    toY: Math.min(pageH - 1, Math.ceil(Math.max(...ys))),
  };
}

/** 読み方向を吸収したスロット列。scaffold と mask で必ず同じ向きを使う。 */
export function stencilSlots(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): ComicPanelSlot[] {
  return direction === "ltr" ? template.slots.map(mirrorSlotX) : template.slots;
}

/**
 * 白地に枠線だけを描いた raster を返す（canvas 非依存の中核）。
 *
 * 枠線は「多角形の内側かつ、辺からの距離が枠線幅未満」の画素を黒で塗る。
 * stroke の中心合わせではなく内側だけに引くので、隣接コマのガター幅
 * （テンプレの 3%）が枠線で削られない。
 *
 * 寸法は `structurePageSize(template.pageAspect)` から取る（2026-08-10 STΛCK決定の
 * テンプレ比率追従）。3:4テンプレは従来どおり1080×1440、4:5テンプレは1080×1350。
 */
export function renderTemplateScaffoldRaster(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): RgbaRaster {
  const page = structurePageSize(template.pageAspect);
  const raster = createRaster(page.w, page.h, parseHexRgb(STENCIL_PAGE_PAPER));
  const quads = stencilSlots(template, direction).map((slot) =>
    slotQuadPx(slot, page.w, page.h),
  );

  for (const quad of quads) {
    const bounds = scanBounds(quad, raster.width, raster.height);
    for (let y = bounds.fromY; y <= bounds.toY; y += 1) {
      for (let x = bounds.fromX; x <= bounds.toX; x += 1) {
        const sampleX = x + 0.5;
        const sampleY = y + 0.5;
        if (!isInsidePolygon(sampleX, sampleY, quad)) continue;
        if (distanceToPolygonEdges(sampleX, sampleY, quad) >= STENCIL_PANEL_BORDER_PX) {
          continue;
        }
        const offset = (y * raster.width + x) * 4;
        raster.rgba[offset] = 0;
        raster.rgba[offset + 1] = 0;
        raster.rgba[offset + 2] = 0;
        raster.rgba[offset + 3] = 255;
      }
    }
  }
  return raster;
}

/**
 * コマ内側だけが白いマスク raster を返す（canvas 非依存の中核）。
 *
 * 白は「多角形の内側かつ、辺からの距離が 枠線幅 + にじみ代 以上」。
 * 枠線画素とは構造的に重ならない（同じ辺距離で判定しているため、
 * にじみ代が正である限り白と黒線が接することがない）。
 *
 * 寸法は scaffold と同じ `structurePageSize(template.pageAspect)` から取る。
 * 同じテンプレから作る限り両者は必ず同寸になり、合成時の寸法不一致が起きない。
 */
export function renderPanelMaskRaster(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): RgbaRaster {
  const page = structurePageSize(template.pageAspect);
  const raster = createRaster(page.w, page.h, [
    MASK_BLACK,
    MASK_BLACK,
    MASK_BLACK,
  ]);
  const inset = STENCIL_PANEL_BORDER_PX + STENCIL_MASK_BLEED_PX;
  const quads = stencilSlots(template, direction).map((slot) =>
    slotQuadPx(slot, page.w, page.h),
  );

  for (const quad of quads) {
    const bounds = scanBounds(quad, raster.width, raster.height);
    for (let y = bounds.fromY; y <= bounds.toY; y += 1) {
      for (let x = bounds.fromX; x <= bounds.toX; x += 1) {
        const sampleX = x + 0.5;
        const sampleY = y + 0.5;
        if (!isInsidePolygon(sampleX, sampleY, quad)) continue;
        if (distanceToPolygonEdges(sampleX, sampleY, quad) < inset) continue;
        const offset = (y * raster.width + x) * 4;
        raster.rgba[offset] = MASK_WHITE;
        raster.rgba[offset + 1] = MASK_WHITE;
        raster.rgba[offset + 2] = MASK_WHITE;
        raster.rgba[offset + 3] = 255;
      }
    }
  }
  return raster;
}

function assertSameSize(a: RgbaRaster, b: RgbaRaster, label: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `${label}の寸法が一致しません（${a.width}x${a.height} と ${b.width}x${b.height}）。`,
    );
  }
}

/**
 * AI 出力を下地に、マスクが黒の画素を scaffold で上書きした raster を返す
 * （canvas 非依存の中核）。合成は決定論で、失敗しうるのは寸法不一致だけ。
 */
export function compositeStencilRaster(
  aiImage: RgbaRaster,
  scaffold: RgbaRaster,
  mask: RgbaRaster,
): RgbaRaster {
  assertSameSize(aiImage, scaffold, "生成画像と枠画像");
  assertSameSize(aiImage, mask, "生成画像とマスク");

  const composite: RgbaRaster = {
    width: aiImage.width,
    height: aiImage.height,
    rgba: new Uint8ClampedArray(aiImage.rgba),
  };
  for (let offset = 0; offset < composite.rgba.length; offset += 4) {
    // マスクが白い画素だけ AI の絵を採用する。それ以外（枠線・ガター・外周）は
    // 機械が描いた scaffold をそのまま焼き戻す。
    if (mask.rgba[offset] === MASK_WHITE) continue;
    composite.rgba[offset] = scaffold.rgba[offset];
    composite.rgba[offset + 1] = scaffold.rgba[offset + 1];
    composite.rgba[offset + 2] = scaffold.rgba[offset + 2];
    composite.rgba[offset + 3] = scaffold.rgba[offset + 3];
  }
  return composite;
}

/**
 * マスク黒領域の RGBA が scaffold と完全一致することを検証する。
 * 1画素でも違えば throw（設計書 §3・実機ゲート2の機械照合）。
 */
export function assertStencilFramesRaster(
  composite: RgbaRaster,
  scaffold: RgbaRaster,
  mask: RgbaRaster,
): void {
  assertSameSize(composite, scaffold, "合成結果と枠画像");
  assertSameSize(composite, mask, "合成結果とマスク");

  for (let offset = 0; offset < composite.rgba.length; offset += 4) {
    if (mask.rgba[offset] === MASK_WHITE) continue;
    for (let channel = 0; channel < 4; channel += 1) {
      if (composite.rgba[offset + channel] === scaffold.rgba[offset + channel]) {
        continue;
      }
      const pixel = offset / 4;
      throw new Error(
        `枠外の画素が枠画像と一致しません（x=${pixel % composite.width}, y=${Math.floor(
          pixel / composite.width,
        )}）。`,
      );
    }
  }
}

// --- canvas 境界（上の純関数を HTMLCanvasElement へ載せるだけ） ---

function createCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("塗り絵合成に必要なcanvasを取得できません。");
  return { canvas, context };
}

function rasterToCanvas(raster: RgbaRaster): HTMLCanvasElement {
  const { canvas, context } = createCanvas(raster.width, raster.height);
  context.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

function canvasToRaster(source: CanvasImageSource, width: number, height: number): RgbaRaster {
  const { context } = createCanvas(width, height);
  context.drawImage(source, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return { width, height, rgba: imageData.data };
}

/** 幅1080・高さはテンプレ比率。白地に各コマの枠線 3px #000 を描く。 */
export function renderTemplateScaffold(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): HTMLCanvasElement {
  return rasterToCanvas(renderTemplateScaffoldRaster(template, direction));
}

/** 幅1080・高さはテンプレ比率。黒地に各コマ内側（枠線内からさらに 2px 内側）を白で塗る。 */
export function renderPanelMask(
  template: ComicLayoutTemplate,
  direction: ComicReadingDirection,
): HTMLCanvasElement {
  return rasterToCanvas(renderPanelMaskRaster(template, direction));
}

/**
 * AI 出力を下地に、マスクが黒の画素を scaffold で上書きする。
 * 出力は必ず scaffold と同寸（= 幅1080・高さはテンプレ比率）。
 */
export function compositeStencilResult(
  aiImage: CanvasImageSource,
  scaffold: HTMLCanvasElement,
  mask: HTMLCanvasElement,
): HTMLCanvasElement {
  const scaffoldRaster = canvasToRaster(scaffold, scaffold.width, scaffold.height);
  const maskRaster = canvasToRaster(mask, mask.width, mask.height);
  // AI 出力はここで scaffold と同寸へ読み出す。寸法不一致は呼び出し側が
  // 生成前に検査する契約（設計書 S3）で、この時点では下地として揃える。
  const aiRaster = canvasToRaster(aiImage, scaffold.width, scaffold.height);
  return rasterToCanvas(compositeStencilRaster(aiRaster, scaffoldRaster, maskRaster));
}

/** 合成済み canvas のマスク黒領域が scaffold と完全一致することを検証する。 */
export function assertStencilFrames(
  canvas: HTMLCanvasElement,
  scaffold: HTMLCanvasElement,
  mask: HTMLCanvasElement,
): void {
  assertStencilFramesRaster(
    canvasToRaster(canvas, canvas.width, canvas.height),
    canvasToRaster(scaffold, scaffold.width, scaffold.height),
    canvasToRaster(mask, mask.width, mask.height),
  );
}
