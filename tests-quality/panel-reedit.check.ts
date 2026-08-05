import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

import {
  assertSameRasterDimensions,
  buildPanelReeditGenerationRequest,
  buildPanelReeditImageInputs,
  compositePanelRgba,
  countOutsideMaskDifferences,
  createPanelMaskRgba,
  detectPanelInterior,
  isCurrentPanelReeditRun,
  isPanelReeditResizable,
  PANEL_REEDIT_ASPECT_TOLERANCE,
  panelGuidePoints,
  resolvePanelReeditReferences,
  validatePanelPolygon,
} from "../src/lib/comic/panelReedit";
import type { PanelMaskArtifact } from "../src/lib/comic/panelReedit";
import { getComicTemplate } from "../src/lib/comic/layoutTemplates";

type FixtureEntry = {
  templateId: string;
  panelIndex: number;
  width: number;
  height: number;
  /** 実画像に描く固定外枠。テンプレ座標とは独立した正解データ。 */
  borderPoints: [number, number][];
  /** 枠保護余白を引いた、固定の期待内側頂点。 */
  truthPoints: [number, number][];
  /** 実正解の白画素を直接復元する行RLE。 */
  truthInnerMask: { encoding: "row-spans-v1"; rows: number[][] };
  variant: "solid-rect" | "broken-border" | "diagonal" | "balloon-overlap";
  breaks?: [number, number, number][];
  balloon?: { cx: number; cy: number; radius: number };
};

const autoDetectManifest = JSON.parse(
  readFileSync(new URL("./fixtures/panel-autodetect/manifest.json", import.meta.url), "utf8"),
) as { entries: FixtureEntry[]; lowConfidence: { width: number; height: number; variant: "low-confidence" } };

const fixtureEntriesByTemplate = new Map<string, FixtureEntry[]>();
for (const entry of autoDetectManifest.entries) {
  fixtureEntriesByTemplate.set(entry.templateId, [...(fixtureEntriesByTemplate.get(entry.templateId) ?? []), entry]);
}

function raster(width: number, height: number, value: number) {
  return { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(value) };
}

/** manifestの固定borderPointsだけを描く。layout templateは入力画像の作成に使わない。 */
function fixtureRgba(templateId: string, width = 300, height = 400) {
  const data = new Uint8ClampedArray(width * height * 4).fill(245);
  const paint = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  const entries = fixtureEntriesByTemplate.get(templateId);
  if (!entries) throw new Error(`固定fixtureがありません: ${templateId}`);
  for (const entry of entries) {
    const points = entry.borderPoints.map(([x, y]) => ({ x: x * width / 100, y: y * height / 100 }));
    for (let edge = 0; edge < points.length; edge += 1) {
      const start = points[edge];
      const end = points[(edge + 1) % points.length];
      const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y));
      for (let step = 0; step <= steps; step += 1) {
        const broken = entry.breaks?.some(([targetEdge, from, to]) => targetEdge === edge && step > steps * from && step < steps * to);
        if (broken) continue;
        const x = Math.round(start.x + (end.x - start.x) * step / steps);
        const y = Math.round(start.y + (end.y - start.y) * step / steps);
        // 300px短辺は契約の基準画像(1200px短辺)の1/4なので、枠線も1pxに固定する。
        paint(x, y, 8);
      }
    }
  }
  for (const entry of entries) {
    if (entry.balloon) {
      // manifestで固定した吹き出しが枠を隠す。variant名だけのダミーにはしない。
      for (let y = Math.floor(entry.balloon.cy - entry.balloon.radius); y <= Math.ceil(entry.balloon.cy + entry.balloon.radius); y += 1) {
        for (let x = Math.floor(entry.balloon.cx - entry.balloon.radius); x <= Math.ceil(entry.balloon.cx + entry.balloon.radius); x += 1) {
          if ((x - entry.balloon.cx) ** 2 + (y - entry.balloon.cy) ** 2 <= entry.balloon.radius ** 2) paint(x, y, 255);
        }
      }
    }
  }
  return { width, height, data };
}

/** 偽装実装を模すためだけのテンプレinset。正解データやfixtureの作成には使わない。 */
function templateCheatPoints(points: { x: number; y: number }[], width: number, height: number) {
  const insetPx = Math.min(width, height) * 0.004;
  const centroid = points.reduce((sum, { x, y }) => ({ x: sum.x + x, y: sum.y + y }), { x: 0, y: 0 });
  centroid.x /= points.length;
  centroid.y /= points.length;
  return points.map(({ x, y }) => {
    const dx = centroid.x - x;
    const dy = centroid.y - y;
    const distance = Math.hypot(dx, dy) || 1;
    return { x: x + ((dx / distance) * insetPx * 100) / width, y: y + ((dy / distance) * insetPx * 100) / height };
  });
}

function whiteMaskPixels(mask: Uint8ClampedArray) {
  return new Set(Array.from({ length: mask.length / 4 }, (_, pixel) => pixel).filter((pixel) => mask[pixel * 4] === 255));
}

function fixedTruthMaskPixels(mask: FixtureEntry["truthInnerMask"]) {
  expect(mask.encoding).toBe("row-spans-v1");
  const pixels = new Set<number>();
  for (const row of mask.rows) {
    const [y, ...spans] = row;
    expect(spans.length % 2).toBe(0);
    for (let index = 0; index < spans.length; index += 2) {
      for (let x = spans[index]; x <= spans[index + 1]; x += 1) pixels.add(y * 300 + x);
    }
  }
  return pixels;
}

function iou(actual: Set<number>, truth: Set<number>) {
  const intersection = [...actual].filter((pixel) => truth.has(pixel)).length;
  return intersection / (actual.size + truth.size - intersection);
}

function boundaryDistances(actual: { x: number; y: number }[], truth: { x: number; y: number }[], width: number, height: number) {
  return actual.map((point, index) => Math.hypot((point.x - truth[index].x) * width / 100, (point.y - truth[index].y) * height / 100)).sort((a, b) => a - b);
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

test("長方形と斜め多角形の初期ガイドから、枠線保護済みマスクを作る", () => {
  const rectangleTemplate = getComicTemplate("manga08");
  const diagonalTemplate = getComicTemplate("manga01");
  const rectangle = panelGuidePoints(rectangleTemplate.slots[0]);
  const diagonal = panelGuidePoints(diagonalTemplate.slots[0]);
  const rectangularMask = createPanelMaskRgba(300, 400, rectangle, 6);
  const diagonalMask = createPanelMaskRgba(300, 400, diagonal, 6);

  expect(() => validatePanelPolygon(rectangle, { selectedSlotIndex: 0, slots: rectangleTemplate.slots })).not.toThrow();
  expect(() => validatePanelPolygon(diagonal, { selectedSlotIndex: 0, slots: diagonalTemplate.slots })).not.toThrow();

  // コマ外・ページ端・枠線近傍はいずれも黒。白は内側にだけ残る。
  expect(rectangularMask[0]).toBe(0);
  expect(rectangularMask[(30 * 300 + 210) * 4]).toBe(255);
  expect(rectangularMask[(30 * 300 + 201) * 4]).toBe(0);
  expect(diagonalMask[0]).toBe(0);
  expect([...diagonalMask].filter((value, index) => index % 4 === 0 && value === 255).length).toBeGreaterThan(0);
});

test("合成後はマスク外のRGBA差分が常に0で、内側だけAI画像を採用する", () => {
  const original = raster(3, 1, 10);
  const generated = raster(3, 1, 200);
  const mask = raster(3, 1, 0);
  mask.rgba[4] = 255;
  mask.rgba[5] = 255;
  mask.rgba[6] = 255;
  mask.rgba[7] = 255;

  const composite = compositePanelRgba(original, generated, mask);

  expect(composite.rgba[0]).toBe(10);
  expect(composite.rgba[4]).toBe(200);
  expect(composite.rgba[8]).toBe(10);
  expect(countOutsideMaskDifferences(original, composite, mask)).toBe(0);
});

test("保存用PNGと同じメモリ保持マスクを合成へ渡し、hidden maskPathの読込を不要にする", () => {
  const maskRaster = {
    width: 3,
    height: 1,
    rgba: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]),
  };
  const artifact: PanelMaskArtifact = {
    pngBytes: new Uint8Array([137, 80, 78, 71]),
    width: maskRaster.width,
    height: maskRaster.height,
    raster: maskRaster,
  };
  const original = raster(3, 1, 10);
  const generated = raster(3, 1, 200);
  const composite = compositePanelRgba(original, generated, artifact.raster);

  expect(artifact.raster).toBe(maskRaster);
  expect(composite.rgba[0]).toBe(10);
  expect(composite.rgba[4]).toBe(200);
  expect(countOutsideMaskDifferences(original, composite, artifact.raster)).toBe(0);
  expect(() => assertSameRasterDimensions(original, generated, { ...artifact.raster, width: 2 })).toThrow("サイズが一致しない");
});

test("寸法が違うAI返却画像は合成前に不採用にする", () => {
  expect(() => assertSameRasterDimensions(raster(2, 2, 0), raster(3, 2, 0), raster(2, 2, 0))).toThrow(
    "サイズが一致しない",
  );
});

test("量子化寸法（比率同一・画素数違い）のAI返却だけを、元ページ寸法へ揃えて救済する", () => {
  // 実機で起きる形: 元ページ 2048x3072 に対し、AIは 1024x1536 で返す。
  // 比率は完全一致なので、合成前のリサイズで採用できなければならない。
  expect(isPanelReeditResizable({ width: 2048, height: 3072 }, { width: 1024, height: 1536 })).toBe(true);
  // 端数丸めで1pxずれた量子化寸法も、比率2%以内なので救済する。
  expect(isPanelReeditResizable({ width: 1000, height: 1500 }, { width: 1024, height: 1535 })).toBe(true);
  // 等倍（そもそも一致）も当然 true。
  expect(isPanelReeditResizable({ width: 1024, height: 1536 }, { width: 1024, height: 1536 })).toBe(true);

  // 比率が違う＝構図が違う別の絵。従来どおり弾く。
  expect(isPanelReeditResizable({ width: 1024, height: 1536 }, { width: 1024, height: 1024 })).toBe(false);
  expect(isPanelReeditResizable({ width: 1000, height: 1000 }, { width: 1030, height: 1000 })).toBe(false);
  // 0/負の寸法は比率を計算できないので救済しない。
  expect(isPanelReeditResizable({ width: 0, height: 1536 }, { width: 1024, height: 1536 })).toBe(false);
  expect(isPanelReeditResizable({ width: 1024, height: 1536 }, { width: 1024, height: 0 })).toBe(false);

  // 許容幅の境界そのものを固定する（実装値が動いたら落ちる）。
  expect(PANEL_REEDIT_ASPECT_TOLERANCE).toBe(0.02);
  const tallerThanTolerance = { width: 1024, height: Math.round(1536 / 1.03) };
  expect(isPanelReeditResizable({ width: 1024, height: 1536 }, tallerThanTolerance)).toBe(false);

  // 救済後は「元ページ寸法へ揃った」状態なので、寸法ガードを通過する。
  // 逆に、揃えないまま渡せば従来どおり不採用になる（救済を外すと落ちる側）。
  const original = raster(4, 6, 10);
  const mask = raster(4, 6, 0);
  expect(() => assertSameRasterDimensions(original, raster(4, 6, 200), mask)).not.toThrow();
  expect(() => assertSameRasterDimensions(original, raster(2, 3, 200), mask)).toThrow("サイズが一致しない");
});

test("元ページとマスクの寸法不一致は、比率が同じでも救済せず必ず落とす", () => {
  // マスクは元ページから作るので、ここが食い違うのはロジック異常。
  // 比率が同じ（=isPanelReeditResizableはtrue）でも合成させない。
  const original = raster(4, 6, 10);
  const halfSizeMask = raster(2, 3, 0);
  expect(isPanelReeditResizable(original, halfSizeMask)).toBe(true);
  expect(() => assertSameRasterDimensions(original, halfSizeMask)).toThrow("サイズが一致しない");
});

test("隣接コマへの侵入と自己交差は、確定前に理由付きで拒否する", () => {
  const template = getComicTemplate("manga08");
  const first = panelGuidePoints(template.slots[0]);
  const second = panelGuidePoints(template.slots[1]);
  expect(() =>
    validatePanelPolygon(second, { selectedSlotIndex: 0, slots: template.slots }),
  ).toThrow("隣のコマ");
  expect(() =>
    validatePanelPolygon(
      [first[0], first[2], first[1], first[3]],
      { selectedSlotIndex: 0, slots: template.slots },
    ),
  ).toThrow("辺が交差");
});

test("選択コマと完全一致する登録キャラだけを追加参照にし、元画像とマスクの順を固定する", () => {
  const characters = [
    { name: "A", referenceImagePaths: ["/refs/a-1.png", "/refs/a-2.png"] },
    { name: "B", referenceImagePaths: ["/refs/b.png"] },
  ];
  const matched = resolvePanelReeditReferences({ characters: ["A", "未登録"] }, characters);
  const unmatched = resolvePanelReeditReferences({ characters: ["未登録"] }, characters);
  expect(matched.refPaths).toEqual(["/refs/a-1.png", "/refs/a-2.png"]);
  expect(unmatched.refPaths).toEqual([]);
  expect(buildPanelReeditImageInputs("/page.png", "/mask.png", matched.refPaths)).toEqual({
    refImagePaths: ["/page.png", "/refs/a-1.png", "/refs/a-2.png"],
    maskPaths: ["/mask.png", "", ""],
  });
});

test("編集生成は確定マスクを対応入力にし、固定aspectを渡さない", () => {
  const request = buildPanelReeditGenerationRequest(
    "edit panel 1",
    "/page-1024x1536.png",
    "/page-1024x1536.mask.png",
    ["/refs/a.png"],
    "panel-run-1",
  );
  expect(request).toMatchObject({
    count: 1,
    refImagePaths: ["/page-1024x1536.png", "/refs/a.png"],
    maskPaths: ["/page-1024x1536.mask.png", ""],
    sourceTag: "panel-run-1",
  });
  expect(request).not.toHaveProperty("aspect");
});

test("構成をやり直した後の古い1コマrunは採用できない", () => {
  const oldToken = 7;
  const newerStoryToken = 8;
  expect(isCurrentPanelReeditRun(oldToken, newerStoryToken)).toBe(false);
  expect(isCurrentPanelReeditRun(newerStoryToken, newerStoryToken)).toBe(true);
});

test("独立manifestは62件の実枠・実RLE正解・全variantを固定する", () => {
  expect(autoDetectManifest.entries).toHaveLength(62);
  expect(fixtureEntriesByTemplate.size).toBe(12);
  expect(new Set(autoDetectManifest.entries.map((entry) => entry.variant))).toEqual(
    new Set(["solid-rect", "broken-border", "diagonal", "balloon-overlap"]),
  );
  for (const entry of autoDetectManifest.entries) {
    expect(entry.borderPoints).toHaveLength(entry.truthPoints.length);
    expect(entry.truthInnerMask.rows.length).toBeGreaterThan(0);
  }
});

test("固定manifestの12テンプレ62コマで、独立した内側RLE・境界・面積・隣接0を全数検証する", () => {
  for (const entry of autoDetectManifest.entries) {
    const template = getComicTemplate(entry.templateId);
    const image = fixtureRgba(entry.templateId, entry.width, entry.height);
    const result = detectPanelInterior(image, entry.panelIndex - 1, template.slots);
    const truth = entry.truthPoints.map(([x, y]) => ({ x, y }));
    const actualMask = whiteMaskPixels(createPanelMaskRgba(entry.width, entry.height, result.points, 6));
    const truthMask = fixedTruthMaskPixels(entry.truthInnerMask);
    const distances = boundaryDistances(result.points, truth, entry.width, entry.height);
    const ratio = actualMask.size / truthMask.size;
    const diagonal = entry.variant === "diagonal";
    const neighborTruth = (fixtureEntriesByTemplate.get(entry.templateId) ?? [])
      .filter((candidate) => candidate.panelIndex !== entry.panelIndex)
      .flatMap((candidate) => [...fixedTruthMaskPixels(candidate.truthInnerMask)]);
    const neighborOverlap = [...actualMask].filter((pixel) => neighborTruth.includes(pixel)).length;

    expect(result.generationDisabled, `${entry.templateId} panel ${entry.panelIndex}`).toBe(false);
    expect(result.confidence, `${entry.templateId} panel ${entry.panelIndex}`).toBeGreaterThanOrEqual(0.8);
    expect(result.metrics.borderSupport).toBeGreaterThanOrEqual(0.7);
    expect(iou(actualMask, truthMask), `${entry.templateId} panel ${entry.panelIndex} IoU`).toBeGreaterThanOrEqual(diagonal ? 0.88 : 0.92);
    expect(median(distances), `${entry.templateId} panel ${entry.panelIndex} median boundary`).toBeLessThanOrEqual(1);
    expect(distances.at(-1), `${entry.templateId} panel ${entry.panelIndex} max boundary`).toBeLessThanOrEqual(3);
    expect(ratio, `${entry.templateId} panel ${entry.panelIndex} area ratio`).toBeGreaterThanOrEqual(0.85);
    expect(ratio, `${entry.templateId} panel ${entry.panelIndex} area ratio`).toBeLessThanOrEqual(1.05);
    expect(neighborOverlap, `${entry.templateId} panel ${entry.panelIndex} neighbor white overlap`).toBe(0);
  }
});

test("テンプレguideを0.4% insetして返す偽装は、独立truthの数値ゲートで全件不合格になる", () => {
  let rejected = 0;
  for (const entry of autoDetectManifest.entries) {
    const template = getComicTemplate(entry.templateId);
    const cheat = templateCheatPoints(panelGuidePoints(template.slots[entry.panelIndex - 1]), entry.width, entry.height);
    const cheatMask = whiteMaskPixels(createPanelMaskRgba(entry.width, entry.height, cheat, 6));
    const truth = entry.truthPoints.map(([x, y]) => ({ x, y }));
    const truthMask = fixedTruthMaskPixels(entry.truthInnerMask);
    const distances = boundaryDistances(cheat, truth, entry.width, entry.height);
    const areaRatio = cheatMask.size / truthMask.size;
    const pass = iou(cheatMask, truthMask) >= (entry.variant === "diagonal" ? 0.88 : 0.92) &&
      median(distances) <= 1 && distances.at(-1)! <= 3 && areaRatio >= 0.85 && areaRatio <= 1.05;
    if (!pass) rejected += 1;
  }
  expect(rejected).toBe(62);
});

test("manifestの実枠を動かした入力では、検出pointsも同じ方向へ追従する", () => {
  const base = autoDetectManifest.entries[0];
  const template = getComicTemplate(base.templateId);
  const original = fixtureRgba(base.templateId, base.width, base.height);
  const moved = structuredClone(autoDetectManifest) as typeof autoDetectManifest;
  for (const point of moved.entries[0].borderPoints) point[0] += 0.8;
  const originalEntries = fixtureEntriesByTemplate.get(base.templateId)!;
  fixtureEntriesByTemplate.set(base.templateId, moved.entries.filter((entry) => entry.templateId === base.templateId));
  const shifted = fixtureRgba(base.templateId, base.width, base.height);
  fixtureEntriesByTemplate.set(base.templateId, originalEntries);
  const before = detectPanelInterior(original, base.panelIndex - 1, template.slots);
  const after = detectPanelInterior(shifted, base.panelIndex - 1, template.slots);
  expect(after.points.reduce((sum, point, index) => sum + point.x - before.points[index].x, 0) / after.points.length).toBeGreaterThan(0.35);
});

test("broken-borderとballoon-overlapはmanifestの入力RGBAへ実際に反映される", () => {
  const broken = autoDetectManifest.entries.find((entry) => entry.variant === "broken-border")!;
  const balloon = autoDetectManifest.entries.find((entry) => entry.variant === "balloon-overlap")!;
  const brokenImage = fixtureRgba(broken.templateId, broken.width, broken.height);
  const balloonImage = fixtureRgba(balloon.templateId, balloon.width, balloon.height);
  const [edge, from, to] = broken.breaks![0];
  const start = broken.borderPoints[edge];
  const end = broken.borderPoints[(edge + 1) % broken.borderPoints.length];
  const middle = (from + to) / 2;
  const x = Math.round((start[0] + (end[0] - start[0]) * middle) * broken.width / 100);
  const y = Math.round((start[1] + (end[1] - start[1]) * middle) * broken.height / 100);
  expect(brokenImage.data[(y * broken.width + x) * 4]).toBe(245);
  const balloonPixel = (Math.round(balloon.balloon!.cy) * balloon.width + Math.round(balloon.balloon!.cx)) * 4;
  expect(balloonImage.data[balloonPixel]).toBe(255);
});

test("枠線がない低信頼度fixtureは再生成を止める", () => {
  const template = getComicTemplate("manga08");
  const image = { width: autoDetectManifest.lowConfidence.width, height: autoDetectManifest.lowConfidence.height, data: new Uint8ClampedArray(300 * 400 * 4).fill(245) };
  const result = detectPanelInterior(image, 0, template.slots);
  expect(result.generationDisabled).toBe(true);
  expect(result.failureCode).toBeTruthy();
});
