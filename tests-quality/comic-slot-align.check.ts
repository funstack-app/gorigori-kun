/**
 * テンプレ照合検出器の合成フィクスチャ検査。
 * ブラウザやファイルI/Oを使わず、白いページへ固定座標の模擬コマを直描きする。
 */
import { expect, test } from "@playwright/test";

import { alignSlotsToTemplate } from "../src/lib/comic/panelSlotRecovery";
import {
  COMIC_LAYOUT_TEMPLATES,
  getComicTemplate,
} from "../src/lib/comic/layoutTemplates";
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
  { x: 66, y: 4, w: 34, h: 26 },
  { x: 35, y: 4, w: 28, h: 26 },
  { x: 0, y: 4, w: 32, h: 26 },
  { x: 0, y: 33, w: 100, h: 30 },
  { x: 57, y: 66, w: 43, h: 30 },
  { x: 0, y: 66, w: 54, h: 30 },
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

type Point = readonly [number, number];

function slotQuad(slot: ComicPanelSlot): readonly [Point, Point, Point, Point] {
  if (slot.points) return slot.points;
  return [
    [slot.x, slot.y],
    [slot.x + slot.w, slot.y],
    [slot.x + slot.w, slot.y + slot.h],
    [slot.x, slot.y + slot.h],
  ];
}

function pointInsidePolygon(x: number, y: number, points: readonly Point[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const [currentX, currentY] = points[current];
    const [previousX, previousY] = points[previous];
    if (
      (currentY > y) !== (previousY > y) &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  x: number,
  y: number,
  start: Point,
  end: Point,
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - start[0], y - start[1]);
  const progress = Math.max(
    0,
    Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / lengthSquared),
  );
  return Math.hypot(x - (start[0] + progress * dx), y - (start[1] + progress * dy));
}

function isPaperEdge(start: Point, end: Point): boolean {
  return (
    (start[0] === 0 && end[0] === 0) ||
    (start[0] === WIDTH && end[0] === WIDTH) ||
    (start[1] === 0 && end[1] === 0) ||
    (start[1] === HEIGHT && end[1] === HEIGHT)
  );
}

/** 斜めコマも含め、紙端だけ枠線を省いた模擬ページを描く。 */
function templateFixturePage(template: ComicLayoutTemplate): PanelImageData {
  const image = blankPage();
  for (const slot of template.slots) {
    const points = slotQuad(slot).map(
      ([x, y]) => [x * WIDTH / 100, y * HEIGHT / 100] as const,
    );
    const minX = Math.max(0, Math.floor(Math.min(...points.map(([x]) => x))));
    const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(...points.map(([x]) => x))) - 1);
    const minY = Math.max(0, Math.floor(Math.min(...points.map(([, y]) => y))));
    const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(...points.map(([, y]) => y))) - 1);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const centerX = x + 0.5;
        const centerY = y + 0.5;
        if (!pointInsidePolygon(centerX, centerY, points)) continue;
        const onBorder = points.some((start, index) => {
          const end = points[(index + 1) % points.length];
          return !isPaperEdge(start, end) &&
            distanceToSegment(centerX, centerY, start, end) <= BORDER_PX;
        });
        paint(image, x, y, onBorder ? 24 : 180);
      }
    }
  }
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

test("全12テンプレの左右紙端を枠線なしで固定し、全境界をスナップする", () => {
  expect(COMIC_LAYOUT_TEMPLATES.map(({ id }) => id)).toEqual(
    Array.from({ length: 12 }, (_, index) => `manga${String(index + 1).padStart(2, "0")}`),
  );

  for (const template of COMIC_LAYOUT_TEMPLATES) {
    const result = alignSlotsToTemplate(templateFixturePage(template), template, "rtl");
    expect(result.ok, `${template.id}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) continue;
    expect(result.metrics.snappedBoundaries, template.id).toBe(template.panelCount * 4);
    expect(result.metrics.totalBoundaries, template.id).toBe(template.panelCount * 4);

    template.slots.forEach((expectedSlot, slotIndex) => {
      const expected = slotQuad(expectedSlot);
      const actual = slotQuad(result.slots[slotIndex]);
      if (expected[0][0] === 0 && expected[3][0] === 0) {
        expect(actual[0][0], `${template.id} コマ${slotIndex + 1} 左紙端`).toBeCloseTo(0, 10);
        expect(actual[3][0], `${template.id} コマ${slotIndex + 1} 左紙端`).toBeCloseTo(0, 10);
      }
      if (expected[1][0] === 100 && expected[2][0] === 100) {
        expect(actual[1][0], `${template.id} コマ${slotIndex + 1} 右紙端`).toBeCloseTo(100, 10);
        expect(actual[2][0], `${template.id} コマ${slotIndex + 1} 右紙端`).toBeCloseTo(100, 10);
      }
    });
  }
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

test("紙端から4%の外枠を8%帯で見つけ、枠線より内側をクロップ開始にする", () => {
  const fullBleedTemplate: ComicLayoutTemplate = {
    id: "edge-margin-crop-fixture",
    label: "edge margin crop fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 0, y: 0, w: 100, h: 100 }],
    roles: ["1"],
  };
  const outerFrame = { x: 4, y: 4, w: 92, h: 92 };
  const result = alignSlotsToTemplate(fixturePage([outerFrame]), fullBleedTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(4);
  expect(result.metrics.totalBoundaries).toBe(4);
  expect(result.borderPx).toBe(BORDER_PX);
  expect(result.insetPx).toBe(BORDER_PX + 1);
  expectRectNear(result.slots[0], outerFrame);

  const cropStartX = result.slots[0].x + (result.insetPx * 100) / WIDTH;
  const cropStartY = result.slots[0].y + (result.insetPx * 100) / HEIGHT;
  expect(cropStartX, "牙: 端帯が0%なら4%外枠を拾えず、クロップ開始が枠内へ進まない").toBeGreaterThan(4);
  expect(cropStartY, "実測枠線+1pxだけ内側から切り出す").toBeGreaterThan(4);
});

test("本当に端まで絵がある場合は紙端固定・インセット0のままにする", () => {
  const fullBleedTemplate: ComicLayoutTemplate = {
    id: "true-full-bleed-fixture",
    label: "true full bleed fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 0, y: 0, w: 100, h: 100 }],
    roles: ["1"],
  };
  const image = blankPage();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 180;
    image.data[offset + 1] = 180;
    image.data[offset + 2] = 180;
  }

  const result = alignSlotsToTemplate(image, fullBleedTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.slots).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  expect(result.borderPx).toBe(0);
  expect(result.insetPx).toBe(0);
  expect(result.metrics.snappedBoundaries).toBe(4);
});
