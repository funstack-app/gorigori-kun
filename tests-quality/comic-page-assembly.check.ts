/**
 * 「きっちりコマ割り」の決定論はめ込み回帰。
 * 座標・等方cover・斜めclip・枠線を、画像生成やTauriなしで固定する。
 */
import { expect, test } from "@playwright/test";

import {
  COMIC_LAYOUT_TEMPLATES,
  getComicTemplate,
} from "../src/lib/comic/layoutTemplates";
import {
  assembleStructurePage,
  borderWidthPxFor,
  buildAssemblyPlan,
  buildRecompositionPlan,
  coverCrop,
  nearestAspectLabel,
  recomposePageToTemplate,
  RECOMPOSE_PANEL_BORDER_PX,
  slotPixelRect,
  STRUCTURE_PAGE_H,
  STRUCTURE_PAGE_W,
  type PxRect,
} from "../src/lib/comic/pageAssembly";

function rectanglesOverlap(a: PxRect, b: PxRect): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

function assertIsotropicCover(
  crop: { sw: number; sh: number },
  dstW: number,
  dstH: number,
): void {
  const scaleX = dstW / crop.sw;
  const scaleY = dstH / crop.sh;
  if (Math.abs(scaleX - scaleY) > 1e-12) {
    throw new Error("非等方スケールです");
  }
}

test("coverCropは中央切り出しで出力比率と一致し、歪めない", () => {
  const crop = coverCrop(1600, 900, 400, 400);
  expect(crop.sw / crop.sh).toBeCloseTo(1, 12);
  expect(crop.sx * 2 + crop.sw).toBeCloseTo(1600, 12);
  expect(crop.sy * 2 + crop.sh).toBeCloseTo(900, 12);
  expect(() => assertIsotropicCover(crop, 400, 400)).not.toThrow();
});

test("coverCropは元画像と出力先が同比率なら全面を採用する", () => {
  expect(coverCrop(1080, 1440, 540, 720)).toEqual({
    sx: 0,
    sy: 0,
    sw: 1080,
    sh: 1440,
  });
});

test("牙: 全面を縦横別々に引き伸ばす誤った期待値は等方検査で落ちる", () => {
  const stretched = { sw: 1600, sh: 900 };
  expect(() => assertIsotropicCover(stretched, 400, 400)).toThrow(/非等方/);
  expect(coverCrop(1600, 900, 400, 400)).not.toEqual({
    sx: 0,
    sy: 0,
    sw: 1600,
    sh: 900,
  });
});

test("manga01の全スロットをpercentから正確な1080x1440 pxへ変換する", () => {
  const template = getComicTemplate("manga01");
  const rects = template.slots.map((slot) =>
    slotPixelRect(slot, STRUCTURE_PAGE_W, STRUCTURE_PAGE_H),
  );
  expect(rects).toEqual([
    { x: 702, y: 58, w: 378, h: 331 },
    { x: 367, y: 58, w: 324, h: 346 },
    { x: 0, y: 58, w: 356, h: 359 },
    { x: 0, y: 418, w: 1080, h: 562 },
    { x: 551, y: 1008, w: 529, h: 374 },
    { x: 0, y: 994, w: 540, h: 389 },
  ]);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      expect(rectanglesOverlap(rects[i], rects[j]), `${i + 1}と${j + 1}`).toBe(
        false,
      );
    }
  }
});

test("nearestAspectLabelは代表比率とlog中点の両側で切り替わる", () => {
  expect(nearestAspectLabel(0.5625)).toBe("9:16");
  expect(nearestAspectLabel(0.75)).toBe("3:4");
  expect(nearestAspectLabel(1)).toBe("1:1");
  expect(nearestAspectLabel(1.77)).toBe("16:9");

  const boundary = Math.sqrt(0.75 * 1);
  expect(nearestAspectLabel(boundary * (1 - 1e-9))).toBe("3:4");
  expect(nearestAspectLabel(boundary * (1 + 1e-9))).toBe("1:1");
});

test("枠線は1080x1440で thin=2 / standard=3 / bold=6 px", () => {
  expect(borderWidthPxFor("thin", 1080, 1440)).toBe(2);
  expect(borderWidthPxFor("standard", 1080, 1440)).toBe(3);
  expect(borderWidthPxFor("bold", 1080, 1440)).toBe(6);
});

test("描画計画はpointsの有無をclipへ写し、退化スロットを拒否する", () => {
  const slanted = getComicTemplate("manga01").slots[0];
  const rectangular = getComicTemplate("manga08").slots[0];
  const plan = buildAssemblyPlan([slanted, rectangular], "standard");
  expect(plan.pageW).toBe(1080);
  expect(plan.pageH).toBe(1440);
  expect(plan.panels[0].clipPolygon).toHaveLength(4);
  expect(plan.panels[1].clipPolygon).toBeUndefined();
  expect(plan.panels.map((panel) => panel.borderWidthPx)).toEqual([3, 3]);

  expect(() => buildAssemblyPlan([], "standard")).toThrow(/コマがありません/);
  expect(() =>
    buildAssemblyPlan([{ x: 0, y: 0, w: 0, h: 20 }], "standard"),
  ).toThrow(/退化/);
});

test("枠線はclip内側へ決定論幅で描かれ、未生成コマは白地のまま残る", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadDocument = Object.prototype.hasOwnProperty.call(globals, "document");
  const hadPath2D = Object.prototype.hasOwnProperty.call(globals, "Path2D");
  const previousDocument = globals.document;
  const previousPath2D = globals.Path2D;
  const strokes: Array<{ lineWidth: number; strokeStyle: unknown }> = [];
  const fills: Array<{ fillStyle: unknown; args: number[] }> = [];
  const clips: string[][] = [];

  class FakePath2D {
    commands: string[] = [];
    moveTo() {
      this.commands.push("moveTo");
    }
    lineTo() {
      this.commands.push("lineTo");
    }
    closePath() {
      this.commands.push("closePath");
    }
    rect() {
      this.commands.push("rect");
    }
  }
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    lineCap: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect(...args: number[]) {
      fills.push({ fillStyle: this.fillStyle, args });
    },
    save() {},
    clip(path: FakePath2D) {
      clips.push(path.commands);
    },
    drawImage() {},
    stroke() {
      strokes.push({ lineWidth: this.lineWidth, strokeStyle: this.strokeStyle });
    },
    restore() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: (blob: Blob) => void) =>
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
  };
  globals.document = { createElement: () => canvas };
  globals.Path2D = FakePath2D;

  try {
    const bytes = await assembleStructurePage({
      panelImagePaths: [undefined],
      slots: [getComicTemplate("manga01").slots[0]],
      frameStyle: "standard",
    });
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
    expect(canvas).toMatchObject({ width: 1080, height: 1440 });
    expect(fills).toEqual([
      { fillStyle: "#ffffff", args: [0, 0, 1080, 1440] },
    ]);
    expect(clips).toEqual([
      ["moveTo", "lineTo", "lineTo", "lineTo", "closePath"],
    ]);
    // stroke中心の外側半分はclipで切られるため、指定3pxの2倍=6pxで描く。
    expect(strokes).toEqual([{ lineWidth: 6, strokeStyle: "#000" }]);
  } finally {
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
    if (hadPath2D) globals.Path2D = previousPath2D;
    else delete globals.Path2D;
  }
});

test("断ち切りは紙端の枠線だけを描かず、内側の3px枠は保つ", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadDocument = Object.prototype.hasOwnProperty.call(globals, "document");
  const hadPath2D = Object.prototype.hasOwnProperty.call(globals, "Path2D");
  const previousDocument = globals.document;
  const previousPath2D = globals.Path2D;
  const strokedPaths: FakePath2D[] = [];

  class FakePath2D {
    commands: Array<
      | { kind: "moveTo" | "lineTo"; x: number; y: number }
      | { kind: "rect"; x: number; y: number; w: number; h: number }
      | { kind: "closePath" }
    > = [];
    moveTo(x: number, y: number) {
      this.commands.push({ kind: "moveTo", x, y });
    }
    lineTo(x: number, y: number) {
      this.commands.push({ kind: "lineTo", x, y });
    }
    closePath() {
      this.commands.push({ kind: "closePath" });
    }
    rect(x: number, y: number, w: number, h: number) {
      this.commands.push({ kind: "rect", x, y, w, h });
    }
  }
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    lineCap: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect() {},
    save() {},
    clip() {},
    drawImage() {},
    stroke(path: FakePath2D) {
      strokedPaths.push(path);
    },
    restore() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (callback: (blob: Blob) => void) =>
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
  };
  globals.document = { createElement: () => canvas };
  globals.Path2D = FakePath2D;

  try {
    await assembleStructurePage({
      panelImagePaths: [undefined],
      slots: [getComicTemplate("manga08").slots[0]],
      frameStyle: "standard",
    });
    expect(strokedPaths).toHaveLength(1);
    expect(strokedPaths[0].commands).toEqual([
      { kind: "moveTo", x: 1080, y: 432 },
      { kind: "lineTo", x: 713, y: 432 },
      { kind: "lineTo", x: 713, y: 58 },
      { kind: "lineTo", x: 1080, y: 58 },
    ]);
    expect(context.lineWidth, "内側の指定3pxは従来どおり倍幅6pxでclip").toBe(6);

    for (const template of COMIC_LAYOUT_TEMPLATES) {
      const strokeOffset = strokedPaths.length;
      await assembleStructurePage({
        panelImagePaths: template.slots.map(() => undefined),
        slots: template.slots,
        frameStyle: "standard",
      });
      const templatePaths = strokedPaths.slice(strokeOffset);
      expect(templatePaths, `${template.id} 全コマの内側枠`).toHaveLength(template.panelCount);
      template.slots.forEach((slot, slotIndex) => {
        const quad = slot.points ?? [
          [slot.x, slot.y],
          [slot.x + slot.w, slot.y],
          [slot.x + slot.w, slot.y + slot.h],
          [slot.x, slot.y + slot.h],
        ];
        const touchesLeft = quad[0][0] === 0 && quad[3][0] === 0;
        const touchesRight = quad[1][0] === 100 && quad[2][0] === 100;
        if (!touchesLeft && !touchesRight) return;

        const path = templatePaths[slotIndex];
        expect(
          path.commands.some((command) => command.kind === "rect" || command.kind === "closePath"),
          `${template.id} コマ${slotIndex + 1} 紙端を閉じた枠で描かない`,
        ).toBe(false);
        let cursor: { x: number; y: number } | null = null;
        for (const command of path.commands) {
          if (command.kind === "moveTo") {
            cursor = { x: command.x, y: command.y };
            continue;
          }
          if (command.kind !== "lineTo") continue;
          expect(
            cursor !== null &&
              ((cursor.x === 0 && command.x === 0) ||
                (cursor.x === STRUCTURE_PAGE_W && command.x === STRUCTURE_PAGE_W)),
            `${template.id} コマ${slotIndex + 1} 左右紙端の枠線`,
          ).toBe(false);
          cursor = { x: command.x, y: command.y };
        }
      });
    }

    const strokeCountBeforeFullPage = strokedPaths.length;
    await assembleStructurePage({
      panelImagePaths: [undefined],
      slots: [{ x: 0, y: 0, w: 100, h: 100 }],
      frameStyle: "standard",
    });
    expect(strokedPaths, "上下左右すべて紙端なら枠線は0本").toHaveLength(
      strokeCountBeforeFullPage,
    );
  } finally {
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
    if (hadPath2D) globals.Path2D = previousPath2D;
    else delete globals.Path2D;
  }
});

test("牙: コマ画像数とスロット数が違うassemble呼び出しは描画前に落ちる", async () => {
  await expect(
    assembleStructurePage({
      panelImagePaths: [],
      slots: [getComicTemplate("manga01").slots[0]],
      frameStyle: "standard",
    }),
  ).rejects.toThrow(/数が一致しません/);
});

test("牙: 再組立は検出枠線+1pxを除き、比率差10%超だけcoverする", () => {
  const template = getComicTemplate("manga10");
  const sameShape = buildRecompositionPlan({
    alignedSlots: template.slots,
    template,
    sourceWidth: 1080,
    sourceHeight: 1440,
    borderPx: 3,
  });
  expect(sameShape.panels[0].matchedRect).toEqual({
    x: 0,
    y: 58,
    w: 1080,
    h: 374,
  });
  expect(sameShape.panels[0].insetRect).toEqual({
    x: 4,
    y: 62,
    w: 1072,
    h: 366,
  });
  expect(sameShape.panels[0].coverApplied).toBe(false);

  const mismatchedSlots = template.slots.map((slot, index) =>
    index === 0 ? { x: 4, y: 4, w: 30, h: 40 } : slot,
  );
  const mismatched = buildRecompositionPlan({
    alignedSlots: mismatchedSlots,
    template,
    sourceWidth: 1080,
    sourceHeight: 1440,
    borderPx: 3,
  });
  const first = mismatched.panels[0];
  expect(first.coverApplied).toBe(true);
  expect(first.sourceCrop.w / first.sourceCrop.h).toBeCloseTo(
    first.rect.w / first.rect.h,
    12,
  );
  expect(first.sourceCrop.x).toBeGreaterThanOrEqual(first.insetRect.x);
  expect(first.sourceCrop.y).toBeGreaterThanOrEqual(first.insetRect.y);
  expect(first.sourceCrop.x + first.sourceCrop.w).toBeLessThanOrEqual(
    first.insetRect.x + first.insetRect.w,
  );
  expect(first.sourceCrop.y + first.sourceCrop.h).toBeLessThanOrEqual(
    first.insetRect.y + first.insetRect.h,
  );
});

test("牙: 再組立出力は2テンプレの実slot座標と全コマ±1pxで一致する", () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadDocument = Object.prototype.hasOwnProperty.call(globals, "document");
  const hadPath2D = Object.prototype.hasOwnProperty.call(globals, "Path2D");
  const previousDocument = globals.document;
  const previousPath2D = globals.Path2D;
  const renderedPages: Array<{
    canvas: { width: number; height: number };
    fills: Array<{ fillStyle: unknown; args: number[] }>;
    draws: number[][];
    strokes: Array<{ lineWidth: number; strokeStyle: unknown }>;
  }> = [];

  class FakePath2D {
    moveTo() {}
    lineTo() {}
    closePath() {}
    rect() {}
  }

  globals.document = {
    createElement: () => {
      const fills: Array<{ fillStyle: unknown; args: number[] }> = [];
      const draws: number[][] = [];
      const strokes: Array<{ lineWidth: number; strokeStyle: unknown }> = [];
      const context = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        lineJoin: "",
        lineCap: "",
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        fillRect(...args: number[]) {
          fills.push({ fillStyle: this.fillStyle, args });
        },
        save() {},
        clip() {},
        drawImage(_source: unknown, ...args: number[]) {
          draws.push(args);
        },
        stroke() {
          strokes.push({ lineWidth: this.lineWidth, strokeStyle: this.strokeStyle });
        },
        restore() {},
      };
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => context,
      };
      renderedPages.push({ canvas, fills, draws, strokes });
      return canvas;
    },
  };
  globals.Path2D = FakePath2D;

  const cases = [
    {
      templateId: "manga08",
      expected: [
        { x: 713, y: 58, w: 367, h: 374 },
        { x: 378, y: 58, w: 302, h: 374 },
        { x: 0, y: 58, w: 346, h: 374 },
        { x: 0, y: 475, w: 1080, h: 432 },
        { x: 616, y: 950, w: 464, h: 432 },
        { x: 0, y: 950, w: 583, h: 432 },
      ],
    },
    {
      templateId: "manga10",
      expected: [
        { x: 0, y: 58, w: 1080, h: 374 },
        { x: 562, y: 475, w: 518, h: 432 },
        { x: 0, y: 475, w: 529, h: 432 },
        { x: 0, y: 950, w: 1080, h: 432 },
      ],
    },
  ] as const;

  try {
    for (const item of cases) {
      const template = getComicTemplate(item.templateId);
      const canvas = recomposePageToTemplate({
        sourceImage: {} as CanvasImageSource,
        sourceWidth: 1080,
        sourceHeight: 1440,
        alignedSlots: template.slots,
        template,
        borderPx: 3,
      });
      const rendered = renderedPages[renderedPages.length - 1];
      expect(canvas).toBe(rendered.canvas);
      expect(rendered.canvas).toMatchObject({ width: 1080, height: 1440 });
      expect(rendered.fills).toEqual([
        { fillStyle: "#ffffff", args: [0, 0, 1080, 1440] },
      ]);
      expect(rendered.draws).toHaveLength(item.expected.length);
      expect(rendered.strokes).toEqual(
        item.expected.map(() => ({ lineWidth: 6, strokeStyle: "#000" })),
      );
      expect(RECOMPOSE_PANEL_BORDER_PX).toBe(3);

      for (let index = 0; index < item.expected.length; index += 1) {
        const draw = rendered.draws[index];
        const actual = { x: draw[4], y: draw[5], w: draw[6], h: draw[7] };
        const expected = item.expected[index];
        for (const key of ["x", "y", "w", "h"] as const) {
          expect(
            Math.abs(actual[key] - expected[key]),
            `${item.templateId} コマ${index + 1} ${key}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  } finally {
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
    if (hadPath2D) globals.Path2D = previousPath2D;
    else delete globals.Path2D;
  }
});

import { mirrorSlotX } from "../src/lib/comic/panelLayoutOps";

type FramePoint = readonly [number, number];
type FrameGapPair = readonly [number, number];
type FrameSlot = ReturnType<typeof getComicTemplate>["slots"][number];

const COMMON_FRAME_TEMPLATE_IDS = [
  "manga01",
  "manga02",
  "manga03",
  "manga04",
  "manga05",
  "manga06",
  "manga07",
  "manga08",
  "manga09",
  "manga10",
  "manga11",
  "manga12",
] as const;

const HORIZONTAL_GAP_PAIRS: Record<string, readonly FrameGapPair[]> = {
  manga01: [[0, 1], [1, 2], [4, 5]],
  manga02: [[0, 1], [3, 4]],
  manga03: [[0, 1], [3, 4]],
  manga04: [[0, 1], [0, 2], [3, 2]],
  manga05: [[0, 1], [2, 3], [4, 5]],
  manga06: [[0, 1], [3, 4]],
  manga07: [[0, 1], [3, 4]],
  manga08: [[0, 1], [1, 2], [4, 5]],
  manga09: [[0, 1], [2, 3]],
  manga10: [[1, 2]],
  manga11: [[2, 3]],
  manga12: [[0, 1], [2, 3], [4, 5]],
};

const VERTICAL_GAP_PAIRS: Record<string, readonly FrameGapPair[]> = {
  manga01: [[0, 3], [1, 3], [2, 3], [3, 4], [3, 5]],
  manga02: [[0, 2], [1, 2], [2, 3], [2, 4]],
  manga03: [[0, 2], [1, 2], [2, 3], [2, 4]],
  manga04: [[0, 3], [1, 2], [2, 4], [3, 4]],
  manga05: [[0, 2], [1, 3], [2, 4], [3, 5]],
  manga06: [[0, 2], [1, 2], [2, 3], [2, 4]],
  manga07: [[0, 2], [1, 2], [2, 3], [2, 4]],
  manga08: [[0, 3], [1, 3], [2, 3], [3, 4], [3, 5]],
  manga09: [[0, 2], [0, 3], [1, 3], [2, 4], [3, 4]],
  manga10: [[0, 1], [0, 2], [1, 3], [2, 3]],
  manga11: [[0, 1], [1, 2], [1, 3]],
  manga12: [[0, 2], [1, 3], [2, 4], [3, 5]],
};

type OuterSide = "left" | "right" | "top" | "bottom";

function frameQuad(slot: FrameSlot): [FramePoint, FramePoint, FramePoint, FramePoint] {
  if (slot.points) return slot.points;
  return [
    [slot.x, slot.y],
    [slot.x + slot.w, slot.y],
    [slot.x + slot.w, slot.y + slot.h],
    [slot.x, slot.y + slot.h],
  ];
}

function frameCenter(slot: FrameSlot): { x: number; y: number } {
  const quad = frameQuad(slot);
  return {
    x: quad.reduce((sum, point) => sum + point[0], 0) / quad.length,
    y: quad.reduce((sum, point) => sum + point[1], 0) / quad.length,
  };
}

function edgeValueAt(
  edge: readonly [FramePoint, FramePoint],
  sample: number,
  fixedAxis: 0 | 1,
): number {
  const [a, b] = edge;
  const span = b[fixedAxis] - a[fixedAxis];
  if (Math.abs(span) < 1e-12) return (a[1 - fixedAxis] + b[1 - fixedAxis]) / 2;
  const progress = (sample - a[fixedAxis]) / span;
  return a[1 - fixedAxis] + progress * (b[1 - fixedAxis] - a[1 - fixedAxis]);
}

function medianOfThree(values: readonly [number, number, number]): number {
  return [...values].sort((a, b) => a - b)[1];
}

/** 同じ高さの両端+中央でx差を測り、斜め横ガターの代表厚みを返す。 */
function horizontalGap(slots: readonly FrameSlot[], pair: FrameGapPair): number {
  const [a, b] = pair.map((index) => slots[index]) as [FrameSlot, FrameSlot];
  const [right, left] = frameCenter(a).x > frameCenter(b).x ? [a, b] : [b, a];
  const rightEdge: [FramePoint, FramePoint] = [frameQuad(right)[0], frameQuad(right)[3]];
  const leftEdge: [FramePoint, FramePoint] = [frameQuad(left)[1], frameQuad(left)[2]];
  const from = Math.max(
    Math.min(rightEdge[0][1], rightEdge[1][1]),
    Math.min(leftEdge[0][1], leftEdge[1][1]),
  );
  const to = Math.min(
    Math.max(rightEdge[0][1], rightEdge[1][1]),
    Math.max(leftEdge[0][1], leftEdge[1][1]),
  );
  expect(to, "横ガターを同じ高さで測れません").toBeGreaterThanOrEqual(from);
  const samples = [from, (from + to) / 2, to] as const;
  return medianOfThree(
    samples.map(
      (sample) => edgeValueAt(rightEdge, sample, 1) - edgeValueAt(leftEdge, sample, 1),
    ) as [number, number, number],
  );
}

/** 同じ横位置の両端+中央でy差を測り、斜め縦ガターの代表厚みを返す。 */
function verticalGap(slots: readonly FrameSlot[], pair: FrameGapPair): number {
  const [a, b] = pair.map((index) => slots[index]) as [FrameSlot, FrameSlot];
  const [upper, lower] = frameCenter(a).y < frameCenter(b).y ? [a, b] : [b, a];
  const upperEdge: [FramePoint, FramePoint] = [frameQuad(upper)[2], frameQuad(upper)[3]];
  const lowerEdge: [FramePoint, FramePoint] = [frameQuad(lower)[0], frameQuad(lower)[1]];
  const from = Math.max(
    Math.min(upperEdge[0][0], upperEdge[1][0]),
    Math.min(lowerEdge[0][0], lowerEdge[1][0]),
  );
  const to = Math.min(
    Math.max(upperEdge[0][0], upperEdge[1][0]),
    Math.max(lowerEdge[0][0], lowerEdge[1][0]),
  );
  expect(to, "縦ガターを同じ横位置で測れません").toBeGreaterThanOrEqual(from);
  const samples = [from, (from + to) / 2, to] as const;
  return medianOfThree(
    samples.map(
      (sample) => edgeValueAt(lowerEdge, sample, 0) - edgeValueAt(upperEdge, sample, 0),
    ) as [number, number, number],
  );
}

function frameSideEdge(
  slot: FrameSlot,
  side: OuterSide,
): readonly [FramePoint, FramePoint] {
  const quad = frameQuad(slot);
  if (side === "left") return [quad[0], quad[3]];
  if (side === "right") return [quad[1], quad[2]];
  if (side === "top") return [quad[0], quad[1]];
  return [quad[3], quad[2]];
}

function assertCommonFrame(
  templateId: string,
  slots: readonly FrameSlot[],
  topologyId = templateId,
): void {
  const innerSides = slots.map(() => new Set<OuterSide>());
  for (const pair of HORIZONTAL_GAP_PAIRS[topologyId]) {
    const [aIndex, bIndex] = pair;
    const [rightIndex, leftIndex] =
      frameCenter(slots[aIndex]).x > frameCenter(slots[bIndex]).x
        ? [aIndex, bIndex]
        : [bIndex, aIndex];
    innerSides[rightIndex].add("left");
    innerSides[leftIndex].add("right");
    expect(
      Number(horizontalGap(slots, pair).toFixed(2)),
      `${templateId} 横ガター ${pair[0] + 1}-${pair[1] + 1}`,
    ).toBe(3);
  }
  for (const pair of VERTICAL_GAP_PAIRS[topologyId]) {
    const [aIndex, bIndex] = pair;
    const [upperIndex, lowerIndex] =
      frameCenter(slots[aIndex]).y < frameCenter(slots[bIndex]).y
        ? [aIndex, bIndex]
        : [bIndex, aIndex];
    innerSides[upperIndex].add("bottom");
    innerSides[lowerIndex].add("top");
    expect(
      Number(verticalGap(slots, pair).toFixed(2)),
      `${templateId} 縦ガター ${pair[0] + 1}-${pair[1] + 1}`,
    ).toBe(3);
  }

  const expectedOuterCoordinate: Record<OuterSide, number> = {
    left: 0,
    right: 100,
    top: 4,
    bottom: 96,
  };
  const sides: OuterSide[] = ["left", "right", "top", "bottom"];
  slots.forEach((slot, slotIndex) => {
    for (const side of sides) {
      if (innerSides[slotIndex].has(side)) continue;
      const axis = side === "left" || side === "right" ? 0 : 1;
      const expected = expectedOuterCoordinate[side];
      for (const point of frameSideEdge(slot, side)) {
        expect(
          point[axis],
          `${templateId} コマ${slotIndex + 1} ${side} ${axis === 0 ? "紙端" : "上下外周"}`,
        ).toBe(expected);
      }
    }
  });
}

test("全12テンプレの左右紙端・上下外周4%・内側ガター3%をltrミラー後も保つ", () => {
  for (const templateId of COMMON_FRAME_TEMPLATE_IDS) {
    const template = getComicTemplate(templateId);
    assertCommonFrame(templateId, template.slots);
    assertCommonFrame(`${templateId} ltr`, template.slots.map(mirrorSlotX), templateId);
  }
});

test("テンプレ一覧はid・表示名を保ったマンガ01〜12だけで構成する", () => {
  expect(
    COMIC_LAYOUT_TEMPLATES.map(({ id, label }) => ({ id, label })),
  ).toEqual(
    COMMON_FRAME_TEMPLATE_IDS.map((id, index) => ({
      id,
      label: `マンガ${String(index + 1).padStart(2, "0")}`,
    })),
  );
});

test("牙: 1テンプレの右紙端に0.5%の余白を作ると落ちる", () => {
  const template = getComicTemplate("manga08");
  const broken = template.slots.map((slot, index) =>
    index === 0 ? { ...slot, w: slot.w - 0.5 } : { ...slot },
  );
  expect(() => assertCommonFrame("manga08 broken", broken, "manga08")).toThrow();
});

test("牙: 紙端を保ったまま内側ガターを0.5%崩すと落ちる", () => {
  const template = getComicTemplate("manga08");
  const broken = template.slots.map((slot, index) =>
    index === 0 ? { ...slot, x: slot.x + 0.5, w: slot.w - 0.5 } : { ...slot },
  );
  expect(() => assertCommonFrame("manga08 broken", broken, "manga08")).toThrow();
});
