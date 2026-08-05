/**
 * コマ分割 / 統合（panelLayoutOps.ts）の回帰。ブラウザ不要の純ロジック検査。
 *
 * 入力ラスタは panel-reedit.check.ts と同じ流儀で、独立 manifest の borderPoints
 * （テンプレ座標とは別の正解データ）から合成する。テンプレ座標を入力画像の作成に
 * 使わないので、「テンプレどおりに描いてテンプレどおりに読む」自己言及の罠を避ける。
 *
 * 検査の芯は2つ:
 *  1) スロット集合が閉じたまま進化する（分割/統合の結果も隣接制約を通る quad）
 *  2) 描画は指定領域の外を1画素も変えない（他コマ・枠線の保護）
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

import {
  panelGuidePoints,
  validatePanelPolygon,
  type PanelReeditPoint,
  type RgbaRaster,
} from "../src/lib/comic/panelReedit";
import {
  adjacentSlotIndices,
  drawMergeOnRaster,
  drawSplitOnRaster,
  mergeStoryPage,
  mergedSlot,
  splitSlotQuads,
  splitStoryPage,
  SPLIT_GUTTER_PERCENT,
} from "../src/lib/comic/panelLayoutOps";
import {
  COMIC_LAYOUT_TEMPLATES,
  getComicTemplate,
  type ComicPanelSlot,
} from "../src/lib/comic/layoutTemplates";
import type { ComicPanel, ComicStoryPage } from "../src/lib/comic/types";

type FixtureEntry = {
  templateId: string;
  /** 1始まり。manifest 側の規約（panel-reedit.check.ts と同じ）。 */
  panelIndex: number;
  borderPoints: [number, number][];
};

const manifest = JSON.parse(
  readFileSync(new URL("./fixtures/panel-autodetect/manifest.json", import.meta.url), "utf8"),
) as { entries: FixtureEntry[] };

const entriesByTemplate = new Map<string, FixtureEntry[]>();
for (const entry of manifest.entries) {
  entriesByTemplate.set(entry.templateId, [...(entriesByTemplate.get(entry.templateId) ?? []), entry]);
}

const WIDTH = 300;
const HEIGHT = 400;

/** manifest の固定 borderPoints だけを黒で描いた白地ラスタ。 */
function fixtureRaster(templateId: string): RgbaRaster {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(245);
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  const put = (x: number, y: number, value: number) => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const offset = (y * WIDTH + x) * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  };
  const entries = entriesByTemplate.get(templateId);
  if (!entries) throw new Error(`固定fixtureがありません: ${templateId}`);
  for (const entry of entries) {
    const points = entry.borderPoints.map(([x, y]) => ({ x: (x * WIDTH) / 100, y: (y * HEIGHT) / 100 }));
    for (let edge = 0; edge < points.length; edge += 1) {
      const start = points[edge];
      const end = points[(edge + 1) % points.length];
      const steps = Math.ceil(Math.hypot(end.x - start.x, end.y - start.y));
      for (let step = 0; step <= steps; step += 1) {
        put(
          Math.round(start.x + ((end.x - start.x) * step) / steps),
          Math.round(start.y + ((end.y - start.y) * step) / steps),
          8,
        );
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, rgba };
}

function toPx(points: PanelReeditPoint[]): PanelReeditPoint[] {
  return points.map((point) => ({ x: (point.x / 100) * WIDTH, y: (point.y / 100) * HEIGHT }));
}

function insidePolygon(x: number, y: number, points: PanelReeditPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** quad の外側で before/after の RGBA が違う画素数。0 が保護の証拠。 */
function differencesOutsideQuad(
  before: RgbaRaster,
  after: RgbaRaster,
  quadPercent: PanelReeditPoint[],
): number {
  const quadPx = toPx(quadPercent);
  let count = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (insidePolygon(x + 0.5, y + 0.5, quadPx)) continue;
      const offset = (y * WIDTH + x) * 4;
      if (
        before.rgba[offset] !== after.rgba[offset] ||
        before.rgba[offset + 1] !== after.rgba[offset + 1] ||
        before.rgba[offset + 2] !== after.rgba[offset + 2] ||
        before.rgba[offset + 3] !== after.rgba[offset + 3]
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function luminanceAt(raster: RgbaRaster, x: number, y: number): number {
  const offset = (Math.round(y) * WIDTH + Math.round(x)) * 4;
  return raster.rgba[offset];
}

function centroid(points: PanelReeditPoint[]): PanelReeditPoint {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function bboxOf(points: PanelReeditPoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * 分割線をまたぐ「同じ高さ（または同じ横位置）での隙間」を測る。
 *
 * bbox 差では測れない: 斜めコマでは両半分の分割線側の辺が傾いているため、
 * bbox の最小/最大は別の y で取られ、実際のガターより小さい値が出る
 * （manga01 slot0 は真のガター3%に対し bbox 差2%）。
 * 分割線は両半分で平行なので、辺上の同一パラメータ位置どうしの距離を測るのが正しい。
 */
function gutterAcrossSplit(
  first: PanelReeditPoint[],
  second: PanelReeditPoint[],
  direction: "vertical" | "horizontal",
): number {
  // splitSlotQuads の頂点順から、分割線側の2頂点を取り出す。
  //   vertical  : first=[分割線上, TR, BR, 分割線下] / second=[TL, 分割線上, 分割線下, BL]
  //   horizontal: first=[TL, TR, 分割線右, 分割線左] / second=[分割線左, 分割線右, BR, BL]
  const firstEdge = direction === "vertical" ? [first[0], first[3]] : [first[3], first[2]];
  const secondEdge = direction === "vertical" ? [second[1], second[2]] : [second[0], second[1]];
  const axis: "x" | "y" = direction === "vertical" ? "x" : "y";
  // 対応する端点どうしの軸方向距離。両辺は平行なので2点で足りる。
  return Math.min(
    Math.abs(firstEdge[0][axis] - secondEdge[0][axis]),
    Math.abs(firstEdge[1][axis] - secondEdge[1][axis]),
  );
}

function panel(index: number, over: Partial<ComicPanel> = {}): ComicPanel {
  return {
    index,
    composition: `c${index}`,
    characters: [`キャラ${index}`],
    acting: `a${index}`,
    balloons: [
      { id: `b${index}`, speaker: "", text: `t${index}`, kind: "normal", pos: null, visible: true },
    ],
    sfx: [
      { id: `s${index}`, text: `sfx${index}`, intent: "impact", pos: null, rotation: 0, scale: 1, visible: true },
    ],
    prompt: `p${index}`,
    ...over,
  };
}

function storyPage(panelCount: number, slots: ComicPanelSlot[]): ComicStoryPage {
  return {
    page: 1,
    synopsis: "s",
    layoutHint: "",
    cast: [],
    panelCount,
    panels: Array.from({ length: panelCount }, (_, i) => panel(i + 1)),
    slotsOverride: slots,
  };
}

test("長方形と斜めスロットの2分割は、ガター付きの2つの妥当なコマを返す", () => {
  let checked = 0;
  for (const template of COMIC_LAYOUT_TEMPLATES) {
    for (let index = 0; index < template.slots.length; index += 1) {
      const original = template.slots[index];
      const originalQuad = panelGuidePoints(original);
      const originalBox = bboxOf(originalQuad);
      for (const direction of ["vertical", "horizontal"] as const) {
        const { first, second } = splitSlotQuads(original, direction);
        const nextSlots = [
          ...template.slots.slice(0, index),
          first,
          second,
          ...template.slots.slice(index + 1),
        ];
        const firstQuad = panelGuidePoints(first);
        const secondQuad = panelGuidePoints(second);

        // (a) 新スロット集合の中で、両方が隣接制約を通る。
        expect(
          () => validatePanelPolygon(firstQuad, { selectedSlotIndex: index, slots: nextSlots }),
          `${template.id} slot${index} ${direction} first`,
        ).not.toThrow();
        expect(
          () => validatePanelPolygon(secondQuad, { selectedSlotIndex: index + 1, slots: nextSlots }),
          `${template.id} slot${index} ${direction} second`,
        ).not.toThrow();

        // (b) 分割線をまたいで SPLIT_GUTTER_PERCENT 以上離れる。
        const gap = gutterAcrossSplit(firstQuad, secondQuad, direction);
        expect(gap, `${template.id} slot${index} ${direction} gutter`).toBeGreaterThanOrEqual(
          SPLIT_GUTTER_PERCENT - 0.0001,
        );

        // (c) 元 bbox 内に収まる（分割で紙面を広げない）。
        for (const quad of [firstQuad, secondQuad]) {
          const box = bboxOf(quad);
          expect(box.minX).toBeGreaterThanOrEqual(originalBox.minX - 0.0001);
          expect(box.maxX).toBeLessThanOrEqual(originalBox.maxX + 0.0001);
          expect(box.minY).toBeGreaterThanOrEqual(originalBox.minY - 0.0001);
          expect(box.maxY).toBeLessThanOrEqual(originalBox.maxY + 0.0001);
        }

        // (d) first が読み順で先（rtl: vertical→x が大きい側 / horizontal→y が小さい側）。
        const firstCenter = centroid(firstQuad);
        const secondCenter = centroid(secondQuad);
        if (direction === "vertical") {
          expect(firstCenter.x, `${template.id} slot${index} vertical order`).toBeGreaterThan(secondCenter.x);
        } else {
          expect(firstCenter.y, `${template.id} slot${index} horizontal order`).toBeLessThan(secondCenter.y);
        }
        checked += 1;
      }
    }
  }
  // 12テンプレ×全スロット×縦横を実際に回したことを件数で固定する。
  expect(checked).toBe(COMIC_LAYOUT_TEMPLATES.reduce((sum, t) => sum + t.slots.length, 0) * 2);
});

test("分割の描画は元スロットの外の画素を1つも変えない", () => {
  const template = getComicTemplate("manga08");
  const before = fixtureRaster("manga08");
  const original = template.slots[3]; // 中央の大ゴマ（横長・矩形）
  const originalQuad = panelGuidePoints(original);
  const { first, second } = splitSlotQuads(original, "vertical");
  const keptQuad = panelGuidePoints(first);
  const blankQuad = panelGuidePoints(second);
  const after = drawSplitOnRaster(before, originalQuad, keptQuad, blankQuad, "vertical");

  // 元 quad の外側は1画素も変わらない（他コマ・外周枠線の保護）。
  expect(differencesOutsideQuad(before, after, originalQuad)).toBe(0);

  // 空白側の内側は白へ塗られている（中心付近を実測）。
  const blankCenter = centroid(blankQuad);
  expect(luminanceAt(after, (blankCenter.x / 100) * WIDTH, (blankCenter.y / 100) * HEIGHT)).toBe(255);

  // 空白側の辺の上には黒枠線が存在する（上辺の中点付近を探す）。
  const blankPx = toPx(blankQuad);
  const edgeMid = { x: (blankPx[0].x + blankPx[1].x) / 2, y: (blankPx[0].y + blankPx[1].y) / 2 };
  let foundBorder = false;
  for (let dy = -4; dy <= 4 && !foundBorder; dy += 1) {
    for (let dx = -4; dx <= 4 && !foundBorder; dx += 1) {
      if (luminanceAt(after, edgeMid.x + dx, edgeMid.y + dy) === 0) foundBorder = true;
    }
  }
  expect(foundBorder, "空白コマの辺に黒枠線が描かれる").toBe(true);

  // 残す側の内部（重心）は元の画素のまま（絵を消さない）。
  const keptCenter = centroid(keptQuad);
  const kx = Math.round((keptCenter.x / 100) * WIDTH);
  const ky = Math.round((keptCenter.y / 100) * HEIGHT);
  expect(luminanceAt(after, kx, ky)).toBe(luminanceAt(before, kx, ky));
});

test("縦横どちらの分割でも、新しく引かれた分割線に黒枠線が描かれる", () => {
  // 牙のあるテスト (Codex検分 2026-07-30): 旧テストは「空白側の上辺」= 元コマの外周と
  // 重なる辺しか見ておらず、分割線の描画が消えても落ちなかった。ここでは
  // 「残す側の分割線側の辺」= 分割で新設された辺だけを直接検査する。
  // 分割線の位置は方向で決まる: vertical → 残す側の左辺 / horizontal → 残す側の下辺。
  const template = getComicTemplate("manga08");
  const before = fixtureRaster("manga08");
  const original = template.slots[3]; // 中央の大ゴマ（横長・矩形）
  const originalQuad = panelGuidePoints(original);

  for (const direction of ["vertical", "horizontal"] as const) {
    const { first, second } = splitSlotQuads(original, direction);
    const keptQuad = panelGuidePoints(first);
    const blankQuad = panelGuidePoints(second);
    const after = drawSplitOnRaster(before, originalQuad, keptQuad, blankQuad, direction);

    // 元 quad の外は不変（方向を変えても保証が崩れないこと）。
    expect(differencesOutsideQuad(before, after, originalQuad), `${direction} outside`).toBe(0);

    // 残す側の「分割線側の辺」の中点付近に黒画素があること。
    // vertical: kept=[分割線上, TR, BR, 分割線下] → 辺 3→0 が分割線
    // horizontal: kept=[TL, TR, 分割線右, 分割線左] → 辺 2→3 が分割線
    const keptPx = toPx(keptQuad);
    const [a, b] = direction === "vertical" ? [keptPx[3], keptPx[0]] : [keptPx[2], keptPx[3]];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let foundSplitBorder = false;
    for (let dy = -4; dy <= 4 && !foundSplitBorder; dy += 1) {
      for (let dx = -4; dx <= 4 && !foundSplitBorder; dx += 1) {
        if (luminanceAt(after, mid.x + dx, mid.y + dy) === 0) foundSplitBorder = true;
      }
    }
    expect(foundSplitBorder, `${direction} の分割線に黒枠線が描かれる`).toBe(true);

    // 空白側の内側は白（分割後の空きコマ）。
    const blankCenter = centroid(blankQuad);
    expect(
      luminanceAt(after, (blankCenter.x / 100) * WIDTH, (blankCenter.y / 100) * HEIGHT),
      `${direction} blank white`,
    ).toBe(255);
  }
});

test("隣接判定と統合quadは、テンプレの実スロットで外側4頂点を返す", () => {
  // manga08 = 矩形の横並び。0,1,2 が上段の右→左、4,5 が下段。
  const rect = getComicTemplate("manga08");
  expect(adjacentSlotIndices(rect.slots, 0)).toContain(1);
  expect(adjacentSlotIndices(rect.slots, 1)).toContain(2);
  // 上段の端(0)と下段(5)は対角なので隣接ではない。
  expect(adjacentSlotIndices(rect.slots, 0)).not.toContain(5);
  expect(adjacentSlotIndices(rect.slots, 2)).not.toContain(4);

  // manga05 = 斜め辺を共有する多角形。上段の2コマは隣接する。
  const diagonal = getComicTemplate("manga05");
  expect(adjacentSlotIndices(diagonal.slots, 0)).toContain(1);
  expect(adjacentSlotIndices(diagonal.slots, 4)).toContain(5);

  // 統合 quad は両スロットの外側頂点で構成される。
  const merged = mergedSlot(rect.slots[0], rect.slots[1]);
  expect(merged.axis).toBe("horizontal");
  const mergedQuad = panelGuidePoints(merged.slot);
  const left = panelGuidePoints(rect.slots[1]); // x が小さい側
  const right = panelGuidePoints(rect.slots[0]);
  expect(mergedQuad[0]).toEqual(left[0]); // TL = 左コマの TL
  expect(mergedQuad[3]).toEqual(left[3]); // BL = 左コマの BL
  expect(mergedQuad[1]).toEqual(right[1]); // TR = 右コマの TR
  expect(mergedQuad[2]).toEqual(right[2]); // BR = 右コマの BR

  // 統合後のスロット集合（2つを1つへ）で、残り全スロット相手の隣接制約を通る。
  const nextSlots = [merged.slot, ...rect.slots.slice(2)];
  expect(() =>
    validatePanelPolygon(mergedQuad, { selectedSlotIndex: 0, slots: nextSlots }),
  ).not.toThrow();

  // 斜めコマの統合も quad（4点）を返す。
  const diagonalMerged = mergedSlot(diagonal.slots[4], diagonal.slots[5]);
  expect(panelGuidePoints(diagonalMerged.slot)).toHaveLength(4);
});

test("統合の描画は旧ガターと旧枠線を白にし、統合quadの外を変えない", () => {
  const template = getComicTemplate("manga08");
  const before = fixtureRaster("manga08");
  const a = template.slots[0];
  const b = template.slots[1];
  const merged = mergedSlot(a, b);
  const mergedQuad = panelGuidePoints(merged.slot);
  const quadA = panelGuidePoints(a);
  const quadB = panelGuidePoints(b);
  const after = drawMergeOnRaster(before, mergedQuad, quadA, quadB, merged.axis);

  // 統合 quad の外側は1画素も変わらない。
  expect(differencesOutsideQuad(before, after, mergedQuad)).toBe(0);

  // 旧枠線が実際に消えていることを、manifest の borderPoints 上の画素で確かめる。
  // 統合の seam に面した辺（右コマ=slots[0] の左辺 / 左コマ=slots[1] の右辺）は、
  // fixture で黒(8)に塗られている実体。これが白へ戻って初めて「枠線を消した」と言える。
  const seamBorderPixels = manifest.entries
    .filter((entry) => entry.templateId === "manga08" && (entry.panelIndex === 1 || entry.panelIndex === 2))
    .flatMap((entry) => {
      const points = entry.borderPoints.map(([x, y]) => ({ x: (x * WIDTH) / 100, y: (y * HEIGHT) / 100 }));
      // 右コマ(panelIndex 1)は左辺 = BL→TL、左コマ(panelIndex 2)は右辺 = TR→BR。
      const [from, to] = entry.panelIndex === 1 ? [points[3], points[0]] : [points[1], points[2]];
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y));
      return Array.from({ length: steps + 1 }, (_, step) => ({
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps),
      }));
    });
  expect(seamBorderPixels.length, "seam の枠線画素が manifest から取れている").toBeGreaterThan(50);
  // まず fixture 側で本当に黒く描かれていることを確認する（テストの牙の自己検査）。
  const blackBefore = seamBorderPixels.filter((p) => luminanceAt(before, p.x, p.y) === 8);
  expect(blackBefore.length, "統合前は seam に黒い枠線がある").toBeGreaterThan(50);
  // 統合後、その枠線画素はすべて白へ戻っている。
  const stillBlack = blackBefore.filter((p) => luminanceAt(after, p.x, p.y) !== 255);
  expect(stillBlack.length, "統合後は seam の枠線が残らない").toBe(0);

  // 各コマ内部（erasePx より内側 = 重心）は元の画素のまま。
  for (const quad of [quadA, quadB]) {
    const center = centroid(quad);
    const cx = Math.round((center.x / 100) * WIDTH);
    const cy = Math.round((center.y / 100) * HEIGHT);
    expect(luminanceAt(after, cx, cy)).toBe(luminanceAt(before, cx, cy));
  }
});

test("分割・統合のストーリー変換は連番とpanelCountとslotsOverrideの整合を保つ", () => {
  const template = getComicTemplate("manga08");
  const page = storyPage(6, template.slots);

  // --- 分割: コマ2 を縦割り。空コマは index 3 に入り、以降が1つずつ繰り下がる。
  const { first, second } = splitSlotQuads(template.slots[1], "vertical");
  const split = splitStoryPage(page, 2, first, second, template.slots);
  expect(split.panels.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(split.panelCount).toBe(split.panels.length);
  expect(split.slotsOverride).toHaveLength(split.panels.length);
  // 挿入位置は分割元の直後。空コマは全フィールドが空。
  const blank = split.panels[2];
  expect(blank.composition).toBe("");
  expect(blank.characters).toEqual([]);
  expect(blank.balloons).toEqual([]);
  expect(blank.sfx).toEqual([]);
  expect(blank.prompt).toBe("");
  // 分割元のコマは中身を保持し、後続コマは中身ごと繰り下がる。
  expect(split.panels[1].prompt).toBe("p2");
  expect(split.panels[3].prompt).toBe("p3");
  // slotsOverride の該当位置が [first, second] に置換されている。
  expect(split.slotsOverride?.[1]).toEqual(first);
  expect(split.slotsOverride?.[2]).toEqual(second);
  expect(split.slotsOverride?.[3]).toEqual(template.slots[2]);

  // --- 統合: コマ1 と 2 を統合。読み順で先（1）が残り、2の中身が合流する。
  const merged = mergedSlot(template.slots[0], template.slots[1]);
  const mergedPage = mergeStoryPage(page, 1, 2, merged.slot, template.slots);
  expect(mergedPage.panels.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);
  expect(mergedPage.panelCount).toBe(mergedPage.panels.length);
  expect(mergedPage.slotsOverride).toHaveLength(mergedPage.panels.length);
  const kept = mergedPage.panels[0];
  // 吹き出し・擬音は結合（消さない原則）。キャラは初出順 union。
  expect(kept.balloons.map((b) => b.text)).toEqual(["t1", "t2"]);
  expect(kept.sfx.map((s) => s.text)).toEqual(["sfx1", "sfx2"]);
  expect(kept.characters).toEqual(["キャラ1", "キャラ2"]);
  // composition / acting / prompt は残す側の値を維持。
  expect(kept.composition).toBe("c1");
  expect(kept.prompt).toBe("p1");
  // slotsOverride は2スロットが merged 1つへ。
  expect(mergedPage.slotsOverride?.[0]).toEqual(merged.slot);
  expect(mergedPage.slotsOverride?.[1]).toEqual(template.slots[2]);

  // 逆順の指定でも「読み順で先」が残る（引数順に依存しない）。
  const reversed = mergeStoryPage(page, 2, 1, merged.slot, template.slots);
  expect(reversed.panels[0].prompt).toBe("p1");
  expect(reversed.panels.map((p) => p.index)).toEqual([1, 2, 3, 4, 5]);

  // キャラの重複は dedupe される（同名を2コマが持つ場合）。
  const sameCast: ComicStoryPage = {
    ...page,
    panels: [panel(1, { characters: ["A", "B"] }), panel(2, { characters: ["B", "C"] }), ...page.panels.slice(2)],
  };
  const dedupedMerge = mergeStoryPage(sameCast, 1, 2, merged.slot, template.slots);
  expect(dedupedMerge.panels[0].characters).toEqual(["A", "B", "C"]);

  // スロット数とコマ数が食い違う入力は、画像へ書く前に例外で止まる。
  expect(() => splitStoryPage(page, 2, first, second, template.slots.slice(0, 3))).toThrow();
  expect(() => mergeStoryPage(page, 1, 1, merged.slot, template.slots)).toThrow();
});
