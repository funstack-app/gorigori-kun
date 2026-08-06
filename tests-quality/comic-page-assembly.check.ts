/**
 * 「きっちりコマ割り」の決定論はめ込み回帰。
 * 座標・等方cover・斜めclip・枠線を、画像生成やTauriなしで固定する。
 */
import { expect, test } from "@playwright/test";

import { getComicTemplate } from "../src/lib/comic/layoutTemplates";
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
    { x: 702, y: 58, w: 335, h: 331 },
    { x: 367, y: 58, w: 324, h: 346 },
    { x: 43, y: 58, w: 313, h: 360 },
    { x: 43, y: 418, w: 994, h: 562 },
    { x: 551, y: 1008, w: 486, h: 374 },
    { x: 43, y: 994, w: 497, h: 389 },
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
    x: 43,
    y: 58,
    w: 994,
    h: 374,
  });
  expect(sameShape.panels[0].insetRect).toEqual({
    x: 47,
    y: 62,
    w: 986,
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
        { x: 713, y: 58, w: 324, h: 374 },
        { x: 378, y: 58, w: 302, h: 374 },
        { x: 43, y: 58, w: 302, h: 374 },
        { x: 43, y: 475, w: 994, h: 432 },
        { x: 616, y: 950, w: 421, h: 432 },
        { x: 43, y: 950, w: 540, h: 432 },
      ],
    },
    {
      templateId: "manga10",
      expected: [
        { x: 43, y: 58, w: 994, h: 374 },
        { x: 562, y: 475, w: 475, h: 432 },
        { x: 43, y: 475, w: 486, h: 432 },
        { x: 43, y: 950, w: 994, h: 432 },
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
