/**
 * テンプレ照合検出器の合成フィクスチャ検査。
 * ブラウザやファイルI/Oを使わず、白いページへ固定座標の模擬コマを直描きする。
 */
import { expect, test } from "@playwright/test";

import { alignSlotsToTemplate } from "../src/lib/comic/panelSlotRecovery";
import { getComicTemplate } from "../src/lib/comic/layoutTemplates";
import type { ComicLayoutTemplate, ComicPanelSlot } from "../src/lib/comic/layoutTemplates";
import type { PanelImageData } from "../src/lib/comic/panelReedit";

const WIDTH = 400;
const HEIGHT = 600;
const BORDER_PX = 3;

type Rect = Pick<ComicPanelSlot, "x" | "y" | "w" | "h">;

const TEMPLATE: ComicLayoutTemplate = {
  id: "slot-align-fixture",
  label: "slot align fixture",
  panelCount: 4,
  pageAspect: { w: 2, h: 3 },
  slots: [
    { x: 52, y: 4, w: 44, h: 44 },
    { x: 4, y: 4, w: 44, h: 44 },
    { x: 52, y: 52, w: 44, h: 44 },
    { x: 4, y: 52, w: 44, h: 44 },
  ],
  roles: ["1", "2", "3", "4"],
};

// 描画側の正解はテンプレ参照で作らず固定する。実装がtemplateをそのまま返すだけでも
// 「2%ずれ」の検査で必ず露見する。
const FIXTURE_RECTS: Rect[] = [
  { x: 52, y: 4, w: 44, h: 44 },
  { x: 4, y: 4, w: 44, h: 44 },
  { x: 52, y: 52, w: 44, h: 44 },
  { x: 4, y: 52, w: 44, h: 44 },
];

/** layoutTemplates.ts の manga08 と独立に固定した描画正解。 */
const MANGA08_RECTS: Rect[] = [
  { x: 66, y: 4, w: 30, h: 26 },
  { x: 35, y: 4, w: 28, h: 26 },
  { x: 4, y: 4, w: 28, h: 26 },
  { x: 4, y: 33, w: 92, h: 30 },
  { x: 57, y: 66, w: 39, h: 30 },
  { x: 4, y: 66, w: 50, h: 30 },
];

function blankPage(): PanelImageData {
  return { width: WIDTH, height: HEIGHT, data: new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255) };
}

function paint(image: PanelImageData, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = value;
  image.data[offset + 1] = value;
  image.data[offset + 2] = value;
  image.data[offset + 3] = 255;
}

/** 白ガター・3px暗線・灰色の模擬絵を持つコマを描く。 */
function drawPanel(
  image: PanelImageData,
  rect: Rect,
  borderPx = BORDER_PX,
  omitPaperEdgeBorders = false,
): void {
  const left = Math.round((rect.x * image.width) / 100);
  const top = Math.round((rect.y * image.height) / 100);
  const right = Math.round(((rect.x + rect.w) * image.width) / 100) - 1;
  const bottom = Math.round(((rect.y + rect.h) * image.height) / 100) - 1;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) paint(image, x, y, 180);
  }
  for (let inset = 0; inset < borderPx; inset += 1) {
    for (let x = left; x <= right; x += 1) {
      paint(image, x, top + inset, 24);
      paint(image, x, bottom - inset, 24);
    }
    for (let y = top; y <= bottom; y += 1) {
      if (!omitPaperEdgeBorders || left > 0) paint(image, left + inset, y, 24);
      if (!omitPaperEdgeBorders || right < image.width - 1) {
        paint(image, right - inset, y, 24);
      }
    }
  }
}

function fixturePage(rects: Rect[], omitPaperEdgeBorders = false): PanelImageData {
  const image = blankPage();
  for (const rect of rects) drawPanel(image, rect, BORDER_PX, omitPaperEdgeBorders);
  return image;
}

function expectRectNear(actual: ComicPanelSlot, expected: Rect, tolerance = 0.35): void {
  expect(actual.x, `x actual=${actual.x} want=${expected.x}`).toBeCloseTo(expected.x, 0);
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.w - expected.w)).toBeLessThanOrEqual(tolerance * 2);
  expect(Math.abs(actual.h - expected.h)).toBeLessThanOrEqual(tolerance * 2);
}

test("テンプレ通りの模擬ページは全境界をスナップし、枠3px・インセット4pxを実測する", () => {
  const result = alignSlotsToTemplate(fixturePage(FIXTURE_RECTS), TEMPLATE, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(16);
  expect(result.metrics.totalBoundaries).toBe(16);
  expect(result.metrics.snappedBoundaryRatio).toBe(1);
  expect(result.confidence).toBeGreaterThanOrEqual(0.99);
  expect(result.borderPx, "牙: 枠線太さの実測を固定").toBe(BORDER_PX);
  expect(result.insetPx, "牙: 切り出しは枠線+1px内側").toBe(BORDER_PX + 1);
  result.slots.forEach((slot, index) => expectRectNear(slot, FIXTURE_RECTS[index]));
});

test("正典manga08でも6コマ・全24境界をスナップする", () => {
  const result = alignSlotsToTemplate(
    fixturePage(MANGA08_RECTS),
    getComicTemplate("manga08"),
    "rtl",
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.metrics.snappedBoundaries).toBe(24);
  expect(result.metrics.totalBoundaries).toBe(24);
  result.slots.forEach((slot, index) => expectRectNear(slot, MANGA08_RECTS[index]));
});

test("わざと2%動かした境界へスナップし、テンプレ座標の丸写しをしない", () => {
  const shifted = FIXTURE_RECTS.map((rect) => ({ ...rect }));
  // 右上コマの左境界だけ x=52% → 54%。右境界は96%のまま。
  shifted[0] = { x: 54, y: 4, w: 42, h: 44 };
  const result = alignSlotsToTemplate(fixturePage(shifted), TEMPLATE, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaryRatio).toBe(1);
  expect(Math.abs(result.slots[0].x - 54)).toBeLessThanOrEqual(0.35);
  expect(Math.abs(result.slots[0].x - TEMPLATE.slots[0].x), "牙: template丸写し").toBeGreaterThan(1.5);
  expectRectNear(result.slots[0], shifted[0]);
});

test("断ち切りの左右端は線なしでも固定し、内側境界だけ従来どおり探索する", () => {
  const bleedTemplate: ComicLayoutTemplate = {
    id: "bleed-edge-fixture",
    label: "bleed edge fixture",
    panelCount: 2,
    pageAspect: { w: 2, h: 3 },
    slots: [
      { x: 51.5, y: 4, w: 48.5, h: 92 },
      { x: 0, y: 4, w: 48.5, h: 92 },
    ],
    roles: ["1", "2"],
  };
  const shiftedInnerEdges: Rect[] = [
    { x: 53.5, y: 4, w: 46.5, h: 92 },
    { x: 0, y: 4, w: 50.5, h: 92 },
  ];
  const result = alignSlotsToTemplate(
    fixturePage(shiftedInnerEdges, true),
    bleedTemplate,
    "rtl",
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(8);
  expect(result.metrics.totalBoundaries).toBe(8);
  expect(result.borderPx, "紙端の0pxを混ぜず内側枠だけ実測").toBe(BORDER_PX);
  expect(result.insetPx).toBe(BORDER_PX + 1);
  result.slots.forEach((slot, index) => expectRectNear(slot, shiftedInnerEdges[index]));
  expect(result.slots[0].x + result.slots[0].w, "右紙端を固定").toBe(100);
  expect(result.slots[1].x, "左紙端を固定").toBe(0);
});

test("上下左右すべて紙端なら探索せず固定し、枠・インセットを0にする", () => {
  const fullBleedTemplate: ComicLayoutTemplate = {
    id: "full-bleed-fixture",
    label: "full bleed fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 0, y: 0, w: 100, h: 100 }],
    roles: ["1"],
  };
  const borderlessImage = blankPage();
  for (let offset = 0; offset < borderlessImage.data.length; offset += 4) {
    borderlessImage.data[offset] = 180;
    borderlessImage.data[offset + 1] = 180;
    borderlessImage.data[offset + 2] = 180;
  }
  const result = alignSlotsToTemplate(borderlessImage, fullBleedTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.slots).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  expect(result.metrics).toMatchObject({
    snappedBoundaryRatio: 1,
    snappedBoundaries: 4,
    totalBoundaries: 4,
  });
  expect(result.borderPx).toBe(0);
  expect(result.insetPx).toBe(0);
});

test("全コマを40%ずらすと近傍帯に枠がなく、安全側のfailureになる", () => {
  const farAway = FIXTURE_RECTS.map((rect) => ({
    ...rect,
    x: rect.x + 40,
    y: rect.y + 40,
  }));
  const result = alignSlotsToTemplate(fixturePage(farAway), TEMPLATE, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("low-confidence");
  expect(result.metrics.snappedBoundaryRatio).toBeLessThan(0.8);
});

test("牙: ±2.5%帯の内側2%は通り、外側3.2%は境界80%未満で落ちる", () => {
  const onePanelTemplate: ComicLayoutTemplate = {
    id: "band-fence",
    label: "band fence",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 20, y: 20, w: 60, h: 60 }],
    roles: ["1"],
  };
  const within = alignSlotsToTemplate(
    fixturePage([{ x: 22, y: 20, w: 58, h: 60 }]),
    onePanelTemplate,
    "rtl",
  );
  expect(within.ok, JSON.stringify(within)).toBe(true);

  const outside = alignSlotsToTemplate(
    fixturePage([{ x: 23.2, y: 20, w: 56.8, h: 60 }]),
    onePanelTemplate,
    "rtl",
  );
  expect(outside.ok, JSON.stringify(outside)).toBe(false);
  if (outside.ok) return;
  expect(outside.metrics.snappedBoundaries).toBe(3);
  expect(outside.metrics.totalBoundaries).toBe(4);
  expect(outside.metrics.snappedBoundaryRatio).toBe(0.75);
});
