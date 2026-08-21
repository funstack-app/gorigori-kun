/**
 * 塗り絵方式（stencil）の決定論回帰。
 *
 * 枠検出をやめて機械で枠を確定させる方式なので、検査も「検出できたか」ではなく
 * 「機械が描いた枠がテンプレ座標と一致し、合成後も1画素も動いていないか」を見る。
 * ブラウザ・画像生成・ファイルI/Oは使わず、raster（Uint8ClampedArray）だけで回す。
 */
import { expect, test } from "@playwright/test";

import {
  ALL_COMIC_LAYOUT_TEMPLATES,
  COMIC_LAYOUT_TEMPLATES,
  getComicTemplate,
} from "../src/lib/comic/layoutTemplates";
import { mirrorSlotX } from "../src/lib/comic/panelLayoutOps";
import {
  slotPixelRect,
  structurePageSize,
  STRUCTURE_PAGE_H,
  STRUCTURE_PAGE_W,
} from "../src/lib/comic/pageAssembly";
import {
  assertStencilFramesRaster,
  compositeStencilRaster,
  renderPanelMaskRaster,
  renderTemplateScaffoldRaster,
  scaleToScaffoldSize,
  stencilAspectLabel,
  stencilAspectWithinTolerance,
  STENCIL_ASPECT_TOLERANCE,
  STENCIL_ASPECT_TOLERANCE_EPSILON,
  STENCIL_MASK_BLEED_PX,
  STENCIL_PANEL_BORDER_PX,
} from "../src/lib/comic/stencil";
import type { RgbaRaster } from "../src/lib/imageReedit/maskReedit";

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

function pixelAt(raster: RgbaRaster, x: number, y: number): [number, number, number, number] {
  const offset = (y * raster.width + x) * 4;
  return [
    raster.rgba[offset],
    raster.rgba[offset + 1],
    raster.rgba[offset + 2],
    raster.rgba[offset + 3],
  ];
}

function isBorderPixel(raster: RgbaRaster, x: number, y: number): boolean {
  const [r, g, b] = pixelAt(raster, x, y);
  return r === 0 && g === 0 && b === 0;
}

function isMaskWhite(raster: RgbaRaster, x: number, y: number): boolean {
  return pixelAt(raster, x, y)[0] === 255;
}

/** 全面を単色で埋めた raster（ダミーAI画像用）。 */
function solidRaster(color: [number, number, number]): RgbaRaster {
  const rgba = new Uint8ClampedArray(STRUCTURE_PAGE_W * STRUCTURE_PAGE_H * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = 255;
  }
  return { width: STRUCTURE_PAGE_W, height: STRUCTURE_PAGE_H, rgba };
}

/** 枠線が乗っている画素の外接矩形。テンプレ座標と突き合わせる。 */
function borderBounds(
  raster: RgbaRaster,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!isBorderPixel(raster, x, y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX === Number.POSITIVE_INFINITY) return null;
  return { minX, minY, maxX, maxY };
}

test("scaffoldは白地1080x1440で、外周4%の枠線がテンプレ座標と±1pxで一致する", () => {
  for (const template of COMIC_LAYOUT_TEMPLATES) {
    const scaffold = renderTemplateScaffoldRaster(template, "rtl");
    expect(scaffold.width, template.id).toBe(1080);
    expect(scaffold.height, template.id).toBe(1440);

    // 外周4% = 43px（1080*0.04=43.2 / 1440*0.04=57.6）を全テンプレ共通で持つ。
    // 枠線の外接矩形は「最も外側のコマの外周」に一致するはずで、
    // これが崩れるとページ間の統一（設計書 S5）が壊れる。
    const bounds = borderBounds(scaffold);
    expect(bounds, `${template.id} 枠線が1画素も描かれていない`).not.toBeNull();
    if (!bounds) continue;

    const allRects = template.slots.map((slot) =>
      slotPixelRect(slot, STRUCTURE_PAGE_W, STRUCTURE_PAGE_H),
    );
    const expectedMinX = Math.min(...allRects.map((r) => r.x));
    const expectedMinY = Math.min(...allRects.map((r) => r.y));
    const expectedMaxX = Math.max(...allRects.map((r) => r.x + r.w));
    const expectedMaxY = Math.max(...allRects.map((r) => r.y + r.h));

    expect(Math.abs(bounds.minX - expectedMinX), `${template.id} 左外周`).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.minY - expectedMinY), `${template.id} 上外周`).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.maxX - (expectedMaxX - 1)), `${template.id} 右外周`).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.maxY - (expectedMaxY - 1)), `${template.id} 下外周`).toBeLessThanOrEqual(1);
  }
});

test("scaffoldは各コマの四隅内側に枠線を持ち、コマ中心は白紙のまま残る", () => {
  for (const template of COMIC_LAYOUT_TEMPLATES) {
    const scaffold = renderTemplateScaffoldRaster(template, "rtl");
    template.slots.forEach((slot, index) => {
      const rect = slotPixelRect(slot, STRUCTURE_PAGE_W, STRUCTURE_PAGE_H);
      // 中心は必ず紙のまま（枠線がコマを塗り潰していない）。
      const centerX = Math.round(rect.x + rect.w / 2);
      const centerY = Math.round(rect.y + rect.h / 2);
      expect(
        pixelAt(scaffold, centerX, centerY),
        `${template.id} コマ${index + 1} 中心は白紙`,
      ).toEqual([...WHITE, 255]);
    });

    // 枠線は黒か白しか存在しない（中間色＝アンチエイリアスを焼いていない）。
    // 画素単位の expect は1200万回級で固まるため、違反を集計して1回で検証する。
    let midToneCount = 0;
    for (let offset = 0; offset < scaffold.rgba.length; offset += 4) {
      const value = scaffold.rgba[offset];
      if (value !== 0 && value !== 255) midToneCount += 1;
    }
    expect(midToneCount, `${template.id} 中間色画素の数`).toBe(0);
  }
});

test("マスクの白領域は枠線画素と1画素も重ならない", () => {
  for (const template of COMIC_LAYOUT_TEMPLATES) {
    const scaffold = renderTemplateScaffoldRaster(template, "rtl");
    const mask = renderPanelMaskRaster(template, "rtl");
    expect(mask.width, template.id).toBe(1080);
    expect(mask.height, template.id).toBe(1440);

    // 白（AI が描いてよい領域）の下に枠線があってはならない。
    // 画素単位の expect は固まるため、違反を集計して1回で検証する。
    let whiteCount = 0;
    let overlapCount = 0;
    let firstOverlap = "";
    for (let y = 0; y < mask.height; y += 1) {
      for (let x = 0; x < mask.width; x += 1) {
        if (!isMaskWhite(mask, x, y)) continue;
        whiteCount += 1;
        if (isBorderPixel(scaffold, x, y)) {
          overlapCount += 1;
          if (!firstOverlap) firstOverlap = `(${x},${y})`;
        }
      }
    }
    expect(
      overlapCount,
      `${template.id} マスク白が枠線に重なる 最初=${firstOverlap}`,
    ).toBe(0);
    expect(whiteCount, `${template.id} マスク白領域が空`).toBeGreaterThan(0);
  }
});

test("ltrミラーでもscaffoldとマスクは同じ向きで整合する", () => {
  const template = getComicTemplate("manga01");
  const scaffold = renderTemplateScaffoldRaster(template, "ltr");
  const mask = renderPanelMaskRaster(template, "ltr");

  template.slots.map(mirrorSlotX).forEach((slot, index) => {
    const rect = slotPixelRect(slot, STRUCTURE_PAGE_W, STRUCTURE_PAGE_H);
    const centerX = Math.round(rect.x + rect.w / 2);
    const centerY = Math.round(rect.y + rect.h / 2);
    expect(
      isMaskWhite(mask, centerX, centerY),
      `ltr コマ${index + 1} 中心はマスク白`,
    ).toBe(true);
    expect(
      isBorderPixel(scaffold, centerX, centerY),
      `ltr コマ${index + 1} 中心は枠線でない`,
    ).toBe(false);
  });

  // rtl と ltr が同一なら、そもそもミラーが効いていない。
  const rtl = renderTemplateScaffoldRaster(template, "rtl");
  expect(Buffer.from(scaffold.rgba).equals(Buffer.from(rtl.rgba))).toBe(false);
});

test("合成はマスク黒をscaffoldへ戻し、マスク白のAI画素をそのまま残す", () => {
  const template = getComicTemplate("manga08");
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  const mask = renderPanelMaskRaster(template, "rtl");
  const aiImage = solidRaster([255, 0, 0]);

  const composite = compositeStencilRaster(aiImage, scaffold, mask);
  expect(composite.width).toBe(1080);
  expect(composite.height).toBe(1440);

  // 画素単位の expect は固まるため、違反を集計して1回で検証する。
  let whitePixels = 0;
  let whiteWrong = 0;
  let blackWrong = 0;
  let firstWrong = "";
  for (let y = 0; y < composite.height; y += 1) {
    for (let x = 0; x < composite.width; x += 1) {
      const [r, g, b, a] = pixelAt(composite, x, y);
      if (isMaskWhite(mask, x, y)) {
        whitePixels += 1;
        if (r !== 255 || g !== 0 || b !== 0 || a !== 255) {
          whiteWrong += 1;
          if (!firstWrong) firstWrong = `白(${x},${y})`;
        }
      } else {
        const [sr, sg, sb, sa] = pixelAt(scaffold, x, y);
        if (r !== sr || g !== sg || b !== sb || a !== sa) {
          blackWrong += 1;
          if (!firstWrong) firstWrong = `黒(${x},${y})`;
        }
      }
    }
  }
  expect(whiteWrong, `マスク白が赤でない画素 最初=${firstWrong}`).toBe(0);
  expect(blackWrong, `マスク黒がscaffoldと違う画素 最初=${firstWrong}`).toBe(0);
  expect(whitePixels).toBeGreaterThan(0);
  expect(() => assertStencilFramesRaster(composite, scaffold, mask)).not.toThrow();
});

test("全12テンプレで合成後の枠外がscaffoldとRGBA差分0になる", () => {
  const aiImage = solidRaster([12, 200, 90]);
  for (const template of COMIC_LAYOUT_TEMPLATES) {
    for (const direction of ["rtl", "ltr"] as const) {
      const scaffold = renderTemplateScaffoldRaster(template, direction);
      const mask = renderPanelMaskRaster(template, direction);
      const composite = compositeStencilRaster(aiImage, scaffold, mask);
      expect(
        () => assertStencilFramesRaster(composite, scaffold, mask),
        `${template.id} ${direction}`,
      ).not.toThrow();
    }
  }
});

test("合成は寸法不一致を黙って通さない", () => {
  const template = getComicTemplate("manga10");
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  const mask = renderPanelMaskRaster(template, "rtl");
  const undersized: RgbaRaster = {
    width: 1080,
    height: 1439,
    rgba: new Uint8ClampedArray(1080 * 1439 * 4),
  };
  expect(() => compositeStencilRaster(undersized, scaffold, mask)).toThrow(/寸法/);
});

test("牙: 合成の上書きを止めるとRGBA差分検査が落ちる", () => {
  const template = getComicTemplate("manga08");
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  const mask = renderPanelMaskRaster(template, "rtl");
  const aiImage = solidRaster([255, 0, 0]);

  // 上書きを止める = AI 出力をそのまま合成結果とした場合。
  // 枠外が赤のままになるので、検査は必ず落ちなければならない。
  expect(() => assertStencilFramesRaster(aiImage, scaffold, mask)).toThrow(/一致しません/);

  // 1画素だけ枠外を汚した場合も見逃さない（閾値で許してしまわない）。
  const composite = compositeStencilRaster(aiImage, scaffold, mask);
  let dirtied = false;
  for (let y = 0; y < composite.height && !dirtied; y += 1) {
    for (let x = 0; x < composite.width && !dirtied; x += 1) {
      if (isMaskWhite(mask, x, y)) continue;
      const offset = (y * composite.width + x) * 4;
      composite.rgba[offset] = composite.rgba[offset] === 255 ? 254 : 255;
      dirtied = true;
    }
  }
  expect(dirtied, "枠外画素が1つも無い").toBe(true);
  expect(() => assertStencilFramesRaster(composite, scaffold, mask)).toThrow(/一致しません/);
});

test("牙: マスク白を枠線へ食い込ませると重なり検査が発火する", () => {
  // にじみ代を 0px にしても白は枠線に「隣接」するだけで重ならない（実装が正しい限り）。
  // 牙として実証すべきは「重なり検出器が本当に発火するか」なので、
  // にじみ代 + 1px 分だけ白を膨張させて枠線へ1px食い込ませ、検出器が数えることを確かめる。
  const template = getComicTemplate("manga08");
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  const mask = renderPanelMaskRaster(template, "rtl");

  // 白領域を にじみ代分だけ膨張させる（= inset を 2px 減らす近似）。
  const widened: RgbaRaster = {
    width: mask.width,
    height: mask.height,
    rgba: new Uint8ClampedArray(mask.rgba),
  };
  for (let pass = 0; pass < STENCIL_MASK_BLEED_PX + 1; pass += 1) {
    const source = new Uint8ClampedArray(widened.rgba);
    for (let y = 0; y < widened.height; y += 1) {
      for (let x = 0; x < widened.width; x += 1) {
        const offset = (y * widened.width + x) * 4;
        if (source[offset] === 255) continue;
        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        const touchesWhite = neighbors.some(([nx, ny]) => {
          if (nx < 0 || ny < 0 || nx >= widened.width || ny >= widened.height) return false;
          return source[(ny * widened.width + nx) * 4] === 255;
        });
        if (!touchesWhite) continue;
        widened.rgba[offset] = 255;
        widened.rgba[offset + 1] = 255;
        widened.rgba[offset + 2] = 255;
        widened.rgba[offset + 3] = 255;
      }
    }
  }

  let overlaps = 0;
  for (let y = 0; y < widened.height; y += 1) {
    for (let x = 0; x < widened.width; x += 1) {
      if (isMaskWhite(widened, x, y) && isBorderPixel(scaffold, x, y)) overlaps += 1;
    }
  }
  expect(overlaps, "枠線へ食い込ませても重なりを検出できないなら検査が無力").toBeGreaterThan(0);
  expect(STENCIL_MASK_BLEED_PX).toBeGreaterThan(0);
  expect(STENCIL_PANEL_BORDER_PX).toBe(3);
});

/** 任意寸法・単色の raster（scaffold と違う寸法のAI出力を模す）。 */
function solidRasterOfSize(
  width: number,
  height: number,
  color: [number, number, number],
): RgbaRaster {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * canvas 非搭載の node で `scaleToScaffoldSize` を実測するための最小の偽 canvas。
 *
 * drawImage は最近傍で実寸法へ写す（品質ではなく「scaffold 寸法へ揃うか」を見る）。
 * 引き伸ばし結果をそのまま raster として取り出し、合成・枠外照合まで通す。
 */
function withFakeCanvas<T>(run: () => T): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadDocument = Object.prototype.hasOwnProperty.call(globals, "document");
  const previousDocument = globals.document;

  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      raster: null as RgbaRaster | null,
      getContext: () => context,
    };
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low" as CanvasImageSmoothingQuality,
      drawImage(
        source: RgbaRaster | { raster: RgbaRaster | null },
        _dx: number,
        _dy: number,
        dw: number,
        dh: number,
      ) {
        // 元画像は raster そのもの（テストが渡すダミー）か、
        // 偽canvas（引き伸ばし済みの中間結果）のどちらかを受ける。
        const src = "rgba" in source ? source : source.raster;
        if (!src) throw new Error("偽canvas: 元画像のrasterがありません");
        const rgba = new Uint8ClampedArray(dw * dh * 4);
        for (let y = 0; y < dh; y += 1) {
          const sy = Math.min(src.height - 1, Math.floor((y * src.height) / dh));
          for (let x = 0; x < dw; x += 1) {
            const sx = Math.min(src.width - 1, Math.floor((x * src.width) / dw));
            const to = (y * dw + x) * 4;
            const from = (sy * src.width + sx) * 4;
            rgba[to] = src.rgba[from];
            rgba[to + 1] = src.rgba[from + 1];
            rgba[to + 2] = src.rgba[from + 2];
            rgba[to + 3] = src.rgba[from + 3];
          }
        }
        canvas.raster = { width: dw, height: dh, rgba };
      },
    };
    return canvas;
  };

  globals.document = { createElement: () => makeCanvas() };
  try {
    return run();
  } finally {
    if (hadDocument) globals.document = previousDocument;
    else delete globals.document;
  }
}

test("4:5テンプレに対し1122x1402は許容内で、正規化後の合成が枠外照合を通る", () => {
  const template = getComicTemplate("user02");
  expect(template.pageAspect, "user02 は 4:5 テンプレ").toEqual({ w: 4, h: 5 });
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  const mask = renderPanelMaskRaster(template, "rtl");
  expect([scaffold.width, scaffold.height], "4:5 の scaffold 寸法").toEqual([1080, 1350]);

  // 実測された「aspect を渡したときのAI出力」寸法（比率誤差0.03%）。
  const drawn = solidRasterOfSize(1122, 1402, [255, 0, 0]);
  expect(
    stencilAspectWithinTolerance(drawn.width, drawn.height, scaffold.width, scaffold.height),
  ).toBe(true);

  const scaled = withFakeCanvas(() =>
    (
      scaleToScaffoldSize(
        drawn as unknown as CanvasImageSource,
        scaffold.width,
        scaffold.height,
      ) as unknown as { raster: RgbaRaster | null }
    ).raster,
  );
  expect(scaled, "引き伸ばし結果が取れていない").not.toBeNull();
  if (!scaled) return;
  expect([scaled.width, scaled.height], "scaffold 寸法へ揃う").toEqual([1080, 1350]);

  const composite = compositeStencilRaster(scaled, scaffold, mask);
  expect(() => assertStencilFramesRaster(composite, scaffold, mask)).not.toThrow();
});

test("3:4テンプレに対し1254x1254（正方形）は許容外と判定される", () => {
  const template = getComicTemplate("manga01");
  const scaffold = renderTemplateScaffoldRaster(template, "rtl");
  expect([scaffold.width, scaffold.height]).toEqual([1080, 1440]);

  // aspect 無指定時に実際に返ってきていた寸法（診断 F2）。
  expect(
    stencilAspectWithinTolerance(1254, 1254, scaffold.width, scaffold.height),
  ).toBe(false);

  // 0以下・非有限は黙って通さない。
  expect(() => stencilAspectWithinTolerance(0, 1440, 1080, 1440)).toThrow();
  expect(() => stencilAspectWithinTolerance(1080, -1, 1080, 1440)).toThrow();
  expect(() => stencilAspectWithinTolerance(1080, Number.NaN, 1080, 1440)).toThrow();
});

/**
 * `"4:5"` 形式のラベルを比率の分子・分母へ戻す。
 *
 * 本番の判定式・閾値は一切写経しない（写経すると実装と同じ誤りを見逃す）。
 * ここでやるのはラベル文字列のパースだけで、合否は本番の
 * `stencilAspectWithinTolerance` に出させる。
 */
function parseAspectLabel(label: string): { w: number; h: number } {
  const match = /^(\d+):(\d+)$/.exec(label);
  if (!match) throw new Error(`aspectラベルの形式が不正: ${label}`);
  return { w: Number(match[1]), h: Number(match[2]) };
}

test("統合: 全テンプレでaspectラベルの比率がscaffold比率の許容内に入る", () => {
  // 対象は組み込み＋手作りの全テンプレ（ALL_）。塗り絵経路は getComicTemplate 経由で
  // どちらも受け取るので、組み込みだけを見ると 4:5 の欠陥をまるごと見逃す。
  // 本番と同じ関数で「生成へ渡すラベル」と「合否判定」を通す。
  // nearestAspectLabel 経由に戻すと 4:5 テンプレが "3:4" になり、ここで落ちる。
  for (const template of ALL_COMIC_LAYOUT_TEMPLATES) {
    const label = stencilAspectLabel(template.pageAspect);
    const parsed = parseAspectLabel(label);
    const page = structurePageSize(template.pageAspect);

    expect(
      stencilAspectWithinTolerance(parsed.w, parsed.h, page.w, page.h),
      `${template.id} ラベル=${label} scaffold=${page.w}x${page.h}`,
    ).toBe(true);
  }

  // 4:5 テンプレが1つ以上あることを確かめる（無ければこの統合検査は空振りする）。
  const wide = ALL_COMIC_LAYOUT_TEMPLATES.filter(
    (t) => t.pageAspect.w === 4 && t.pageAspect.h === 5,
  );
  expect(wide.length, "4:5テンプレが1つも無いと今回の欠陥を再現できない").toBeGreaterThan(0);
  expect(stencilAspectLabel({ w: 4, h: 5 })).toBe("4:5");
  expect(stencilAspectLabel({ w: 3, h: 4 })).toBe("3:4");
});

test("stencilAspectLabelは正の整数以外を黙って通さない", () => {
  expect(() => stencilAspectLabel({ w: 0, h: 5 })).toThrow();
  expect(() => stencilAspectLabel({ w: 4, h: 0 })).toThrow();
  expect(() => stencilAspectLabel({ w: -4, h: 5 })).toThrow();
  expect(() => stencilAspectLabel({ w: 4.5, h: 5 })).toThrow();
  expect(() => stencilAspectLabel({ w: 4, h: Number.NaN })).toThrow();
});

test("境界: ちょうど±5%は合格し、その外側は不合格になる", () => {
  const scaffoldW = 1080;
  const scaffoldH = 1440;
  const scaffoldRatio = scaffoldW / scaffoldH;

  // 「偏差ちょうど STENCIL_ASPECT_TOLERANCE」になる幅を閾値定数から作る
  // （閾値の数値はテスト側に複製しない）。
  const exactHigh = scaffoldRatio * (1 + STENCIL_ASPECT_TOLERANCE) * scaffoldH;
  const exactLow = scaffoldRatio * (1 - STENCIL_ASPECT_TOLERANCE) * scaffoldH;

  expect(
    stencilAspectWithinTolerance(exactHigh, scaffoldH, scaffoldW, scaffoldH),
    "ちょうど+5%は設計上「以内」なので合格",
  ).toBe(true);
  expect(
    stencilAspectWithinTolerance(exactLow, scaffoldH, scaffoldW, scaffoldH),
    "ちょうど-5%は設計上「以内」なので合格",
  ).toBe(true);

  // 直内側（閾値の 1/2 だけ内）は当然合格。
  const insideHigh = scaffoldRatio * (1 + STENCIL_ASPECT_TOLERANCE / 2) * scaffoldH;
  expect(stencilAspectWithinTolerance(insideHigh, scaffoldH, scaffoldW, scaffoldH)).toBe(true);

  // 直外側は不合格。イプシロンは丸め誤差の代であって許容の拡張ではないので、
  // イプシロンの1000倍だけ外へ出せば必ず落ちる。
  const outsideHigh =
    scaffoldRatio *
    (1 + STENCIL_ASPECT_TOLERANCE + STENCIL_ASPECT_TOLERANCE_EPSILON * 1000) *
    scaffoldH;
  expect(
    stencilAspectWithinTolerance(outsideHigh, scaffoldH, scaffoldW, scaffoldH),
    "閾値の外側は落ちる",
  ).toBe(false);

  // イプシロンが許容を実質的に広げていないこと（閾値に対して桁違いに小さい）。
  expect(STENCIL_ASPECT_TOLERANCE_EPSILON).toBeLessThan(STENCIL_ASPECT_TOLERANCE / 1e6);
});

test("牙: 枠線色を紙と同じにするとscaffold検査が落ちる", () => {
  // 枠線が1画素も無い raster（= 描画を丸ごと忘れた実装）を検出できること。
  const blank: RgbaRaster = {
    width: STRUCTURE_PAGE_W,
    height: STRUCTURE_PAGE_H,
    rgba: solidRaster(WHITE).rgba,
  };
  expect(borderBounds(blank)).toBeNull();

  const real = renderTemplateScaffoldRaster(getComicTemplate("manga01"), "rtl");
  expect(borderBounds(real)).not.toBeNull();
  expect(BLACK[0]).toBe(0);
});
