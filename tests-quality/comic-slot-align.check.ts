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
import { ALL_COMIC_LAYOUT_TEMPLATES } from "../src/lib/comic/layoutTemplates";
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
      paint(image, left + inset, y, 24);
      paint(image, right - inset, y, 24);
    }
  }
}

function fixturePage(rects: Rect[]): PanelImageData {
  const image = blankPage();
  for (const rect of rects) drawPanel(image, rect);
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

/** 斜めコマも含め、全辺に枠線がある模擬ページを描く。 */
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
          return distanceToSegment(centerX, centerY, start, end) <= BORDER_PX;
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

test("全12テンプレの外周4%枠を含む全境界をスナップする", () => {
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
      expected.forEach(([expectedX, expectedY], pointIndex) => {
        expect(
          Math.abs(actual[pointIndex][0] - expectedX),
          `${template.id} コマ${slotIndex + 1} 点${pointIndex + 1} x`,
        ).toBeLessThanOrEqual(0.35);
        expect(
          Math.abs(actual[pointIndex][1] - expectedY),
          `${template.id} コマ${slotIndex + 1} 点${pointIndex + 1} y`,
        ).toBeLessThanOrEqual(0.35);
      });
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

test("四辺4%の外枠と内側境界を同じ枠線規則で実測する", () => {
  const uniformMarginTemplate: ComicLayoutTemplate = {
    id: "uniform-margin-fixture",
    label: "uniform margin fixture",
    panelCount: 2,
    pageAspect: { w: 2, h: 3 },
    slots: [
      { x: 52, y: 4, w: 44, h: 92 },
      { x: 4, y: 4, w: 45, h: 92 },
    ],
    roles: ["1", "2"],
  };
  const shiftedEdges: Rect[] = [
    { x: 54, y: 4, w: 42, h: 92 },
    { x: 4, y: 4, w: 47, h: 92 },
  ];
  const result = alignSlotsToTemplate(
    fixturePage(shiftedEdges),
    uniformMarginTemplate,
    "rtl",
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(8);
  expect(result.metrics.totalBoundaries).toBe(8);
  expect(result.borderPx, "外周と内側で同じ3px枠を実測").toBe(BORDER_PX);
  expect(result.insetPx).toBe(BORDER_PX + 1);
  result.slots.forEach((slot, index) => expectRectNear(slot, shiftedEdges[index]));
});

test("外枠線が1本も見つからなければテンプレ位置を維持したまま安全側へ倒す", () => {
  const uniformMarginTemplate: ComicLayoutTemplate = {
    id: "uniform-margin-fallback-fixture",
    label: "uniform margin fallback fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 4, y: 4, w: 92, h: 92 }],
    roles: ["1"],
  };
  const result = alignSlotsToTemplate(blankPage(), uniformMarginTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("low-confidence");
  expect(result.metrics).toMatchObject({
    snappedBoundaryRatio: 0,
    snappedBoundaries: 0,
    totalBoundaries: 4,
  });
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

test("牙: ±2.5%帯の外側3.2%は未検出境界をテンプレ位置に保ち、3本照合で通る", () => {
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
  expect(outside.ok, JSON.stringify(outside)).toBe(true);
  if (!outside.ok) return;
  expect(outside.metrics.snappedBoundaries).toBe(3);
  expect(outside.metrics.totalBoundaries).toBe(4);
  expect(outside.metrics.snappedBoundaryRatio).toBe(0.75);
  expect(outside.slots[0].x, "未検出の左境界はテンプレ位置を維持").toBe(20);
});

test("外周±8%帯で4%ずれた外枠を見つけ、枠線より内側をクロップ開始にする", () => {
  const uniformMarginTemplate: ComicLayoutTemplate = {
    id: "outer-margin-crop-fixture",
    label: "outer margin crop fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 4, y: 4, w: 92, h: 92 }],
    roles: ["1"],
  };
  const outerFrame = { x: 8, y: 8, w: 84, h: 84 };
  const result = alignSlotsToTemplate(fixturePage([outerFrame]), uniformMarginTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(4);
  expect(result.metrics.totalBoundaries).toBe(4);
  expect(result.borderPx).toBe(BORDER_PX);
  expect(result.insetPx).toBe(BORDER_PX + 1);
  expectRectNear(result.slots[0], outerFrame);

  const cropStartX = result.slots[0].x + (result.insetPx * 100) / WIDTH;
  const cropStartY = result.slots[0].y + (result.insetPx * 100) / HEIGHT;
  expect(cropStartX, "牙: 外周が±2.5%のままなら4%ずれた枠を拾えない").toBeGreaterThan(8);
  expect(cropStartY, "実測枠線+1pxだけ内側から切り出す").toBeGreaterThan(8);
});

test("端まで絵があり外枠線が無い場合は安全側へ倒す", () => {
  const uniformMarginTemplate: ComicLayoutTemplate = {
    id: "edge-art-fallback-fixture",
    label: "edge art fallback fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 4, y: 4, w: 92, h: 92 }],
    roles: ["1"],
  };
  const image = blankPage();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 180;
    image.data[offset + 1] = 180;
    image.data[offset + 2] = 180;
  }

  const result = alignSlotsToTemplate(image, uniformMarginTemplate, "rtl");
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("low-confidence");
  expect(result.metrics.snappedBoundaries).toBe(0);
});

function drawPanelEdges(
  image: PanelImageData,
  rect: Rect,
  edges: ReadonlySet<"top" | "right" | "bottom" | "left">,
): void {
  const left = Math.round((rect.x * image.width) / 100);
  const top = Math.round((rect.y * image.height) / 100);
  const right = Math.round(((rect.x + rect.w) * image.width) / 100) - 1;
  const bottom = Math.round(((rect.y + rect.h) * image.height) / 100) - 1;
  for (let inset = 0; inset < BORDER_PX; inset += 1) {
    if (edges.has("top")) {
      for (let x = left; x <= right; x += 1) paint(image, x, top + inset, 24);
    }
    if (edges.has("right")) {
      for (let y = top; y <= bottom; y += 1) paint(image, right - inset, y, 24);
    }
    if (edges.has("bottom")) {
      for (let x = left; x <= right; x += 1) paint(image, x, bottom - inset, 24);
    }
    if (edges.has("left")) {
      for (let y = top; y <= bottom; y += 1) paint(image, left + inset, y, 24);
    }
  }
}

const PARTIAL_BOUNDARY_TEMPLATE: ComicLayoutTemplate = {
  id: "partial-boundary-fixture",
  label: "partial boundary fixture",
  panelCount: 4,
  pageAspect: { w: 2, h: 3 },
  slots: [
    { x: 55, y: 10, w: 25, h: 30 },
    { x: 20, y: 10, w: 25, h: 30 },
    { x: 55, y: 60, w: 25, h: 30 },
    { x: 20, y: 60, w: 25, h: 30 },
  ],
  roles: ["1", "2", "3", "4"],
};

test("境界の5割だけ実在しても、残りをテンプレ位置に保って照合できる", () => {
  const image = fixturePage(PARTIAL_BOUNDARY_TEMPLATE.slots.slice(0, 2));
  const result = alignSlotsToTemplate(image, PARTIAL_BOUNDARY_TEMPLATE, "rtl");
  expect(result.ok, `牙: しきい値を0.8へ戻すと失敗する: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) return;

  expect(result.metrics.snappedBoundaries).toBe(8);
  expect(result.metrics.totalBoundaries).toBe(16);
  expect(result.metrics.snappedBoundaryRatio).toBe(0.5);
  expect(result.slots.slice(2)).toEqual(PARTIAL_BOUNDARY_TEMPLATE.slots.slice(2));
});

test("照合できた境界が2本だけならtoo-few-boundariesになる", () => {
  const onePanelTemplate: ComicLayoutTemplate = {
    id: "two-boundaries-fixture",
    label: "two boundaries fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 20, y: 20, w: 60, h: 60 }],
    roles: ["1"],
  };
  const image = blankPage();
  drawPanelEdges(image, onePanelTemplate.slots[0], new Set(["top", "right"]));
  const result = alignSlotsToTemplate(image, onePanelTemplate, "rtl");

  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode).toBe("too-few-boundaries");
  expect(result.metrics.snappedBoundaries).toBe(2);
  expect(result.metrics.snappedBoundaryRatio).toBe(0.5);
});

test("全境界が探索幅いっぱいにずれていればdrift-too-largeになる", () => {
  const onePanelTemplate: ComicLayoutTemplate = {
    id: "full-drift-fixture",
    label: "full drift fixture",
    panelCount: 1,
    pageAspect: { w: 2, h: 3 },
    slots: [{ x: 20, y: 20, w: 60, h: 60 }],
    roles: ["1"],
  };
  const searchRadiusPx = Math.floor(Math.min(WIDTH, HEIGHT) * 0.025);
  // 右端・下端は描画矩形の包含端が-1pxになるため、全4辺が探索帯へ入る上限は半径-1px。
  const driftPx = searchRadiusPx - 1;
  const insetX = (driftPx * 100) / WIDTH;
  const insetY = (driftPx * 100) / HEIGHT;
  const shiftedInward: Rect = {
    x: 20 + insetX,
    y: 20 + insetY,
    w: 60 - insetX * 2,
    h: 60 - insetY * 2,
  };
  const result = alignSlotsToTemplate(fixturePage([shiftedInward]), onePanelTemplate, "rtl");

  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return;
  expect(result.failureCode, JSON.stringify(result)).toBe("drift-too-large");
  expect(result.metrics.snappedBoundaries).toBe(4);
  expect(result.metrics.averageDriftPercent).toBeGreaterThan(1.5);
});

test("手作り01を全テンプレ一覧から実測slot座標のまま解決する", () => {
  const template = ALL_COMIC_LAYOUT_TEMPLATES.find(({ id }) => id === "user01");
  expect(template).toBeDefined();
  if (!template) return;

  expect(template).toMatchObject({
    id: "user01",
    label: "手作り01",
    panelCount: 3,
  });
  expect(template.slots).toEqual([
    { x: 58.80, y: 2.36, w: 37.69, h: 36.04 },
    { x: 3.52, y: 2.36, w: 52.92, h: 36.04 },
    { x: 3.52, y: 41.53, w: 92.96, h: 56.01 },
  ]);
});
