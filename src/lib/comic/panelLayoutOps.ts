/**
 * 生成後のページ画像に対する「コマ割りの変更」（分割 / 統合）。
 *
 * 設計の芯: **スロット座標が既知のまま進化する**こと。
 * 分割は1つの quad を2つの quad へ、統合は隣接2 quad を1つの quad へ写すため、
 * どちらの操作でもスロット集合は「4点 quad の集合」であり続ける。
 * これにより panelReedit.ts の検出（detectPanelInterior）・隣接制約
 * （validatePanelPolygon）・マスク合成（createPanelMaskPng / compositePanelImages）を
 * 一切改変せず再利用できる。フル再レイアウト（スロットの自由再配置）はこの性質を壊すため
 * スコープ外。
 *
 * なぜ panelReedit.ts へ追記せず別ファイルか: panelReedit.ts はラボ検証済みの
 * verbatim 資産で、そのまま本体へ移植したものが回帰の境界になっている。追記すると
 * 「どこまでが検証済みか」の線が消えるため、新規ロジックは本ファイルへ閉じ込める。
 *
 * loadImage / imageRaster / pngBlob 相当のブラウザ I/O は panelReedit.ts では module 私有
 * （非公開）のため、本ファイルへ同型で再掲している。公開 API 化して panelReedit.ts に
 * 手を入れるより、verbatim 維持を優先した判断（重複は約45行）。
 */
import { convertFileSrc } from "@tauri-apps/api/core";

import {
  panelGuidePoints,
  type PanelReeditPoint,
  type RgbaRaster,
} from "./panelReedit";
import type { ComicPanelSlot } from "./layoutTemplates";
import type { ComicPanel, ComicStoryPage } from "./types";

/** "vertical" = 縦の分割線で左右に分ける / "horizontal" = 横の分割線で上下に分ける。 */
export type SplitDirection = "vertical" | "horizontal";

/** 分割後のガター（コマ間隔）。テンプレ正典の約3%（layoutTemplates.ts 冒頭コメント）に合わせる。 */
export const SPLIT_GUTTER_PERCENT = 3;

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

/**
 * points から bbox を導出して ComicPanelSlot を作る。
 * layoutTemplates.ts の poly() と同じ規約（bbox は手書きせず points から導出）だが、
 * poly() は非公開なので同等の私有ヘルパを置く。
 */
function slotFromPoints(points: PanelReeditPoint[]): ComicPanelSlot {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    w: Math.max(...xs) - x,
    h: Math.max(...ys) - y,
    points: points.map((p) => [p.x, p.y] as [number, number]),
  };
}

function midpoint(a: PanelReeditPoint, b: PanelReeditPoint): PanelReeditPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * スロットを2分割する。first = 読み順で先（rtl 前提: vertical→右半分 / horizontal→上半分）、
 * second = 読み順で後（空白になる側）。ガターは分割線の両側へ半分ずつ取る。
 * 入口ゲートが rtl 限定を保証している前提（ltr は本機能ごと対象外）。
 *
 * 4点は TL→TR→BR→BL の時計回り固定（ComicPanelSlot.points 型正典）。
 */
export function splitSlotQuads(
  slot: ComicPanelSlot,
  direction: SplitDirection,
): { first: ComicPanelSlot; second: ComicPanelSlot } {
  const [tl, tr, br, bl] = panelGuidePoints(slot);
  const half = SPLIT_GUTTER_PERCENT / 2;
  if (direction === "vertical") {
    // 上辺・下辺の中点を結ぶ縦の分割線。右半分（読み順で先）と左半分に分ける。
    const midTop = midpoint(tl, tr);
    const midBottom = midpoint(bl, br);
    // 右半分の左辺は分割線から右へ half、左半分の右辺は左へ half 寄せてガターを作る。
    const rightTop = { x: midTop.x + half, y: midTop.y };
    const rightBottom = { x: midBottom.x + half, y: midBottom.y };
    const leftTop = { x: midTop.x - half, y: midTop.y };
    const leftBottom = { x: midBottom.x - half, y: midBottom.y };
    return {
      first: slotFromPoints([rightTop, tr, br, rightBottom]),
      second: slotFromPoints([tl, leftTop, leftBottom, bl]),
    };
  }
  // 左辺・右辺の中点を結ぶ横の分割線。上半分（読み順で先）と下半分に分ける。
  const midLeft = midpoint(tl, bl);
  const midRight = midpoint(tr, br);
  const topLeft = { x: midLeft.x, y: midLeft.y - half };
  const topRight = { x: midRight.x, y: midRight.y - half };
  const bottomLeft = { x: midLeft.x, y: midLeft.y + half };
  const bottomRight = { x: midRight.x, y: midRight.y + half };
  return {
    first: slotFromPoints([tl, tr, topRight, topLeft]),
    second: slotFromPoints([bottomLeft, bottomRight, br, bl]),
  };
}

/** bbox の重なり長さ（負なら離れている＝ギャップ）。 */
function overlapLength(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

/**
 * 選択スロットに隣接するスロット index の一覧（統合候補）。bbox ベースの決定論判定:
 * 水平隣接 = x ギャップ ≤ 8% かつ y 重なり ≥ min(h)の50%。垂直も対称。
 */
export function adjacentSlotIndices(slots: ComicPanelSlot[], index: number): number[] {
  const target = slots[index];
  if (!target) return [];
  const result: number[] = [];
  for (let other = 0; other < slots.length; other += 1) {
    if (other === index) continue;
    const candidate = slots[other];
    const xOverlap = overlapLength(target.x, target.x + target.w, candidate.x, candidate.x + candidate.w);
    const yOverlap = overlapLength(target.y, target.y + target.h, candidate.y, candidate.y + candidate.h);
    const minHeight = Math.min(target.h, candidate.h);
    const minWidth = Math.min(target.w, candidate.w);
    // 水平隣接: x は接する（ギャップ ≤ 8%）が、y は十分に重なっている。
    const horizontal = -xOverlap <= 8 && xOverlap <= 8 && yOverlap >= minHeight * 0.5;
    // 垂直隣接: y が接し、x が十分に重なっている。
    const vertical = -yOverlap <= 8 && yOverlap <= 8 && xOverlap >= minWidth * 0.5;
    if (horizontal || vertical) result.push(other);
  }
  return result;
}

/**
 * 隣接2スロットの統合 quad。TL→TR→BR→BL 固定順を利用し、外側4頂点で構成する
 * （水平統合: [左.TL, 右.TR, 右.BR, 左.BL] / 垂直統合: [上.TL, 上.TR, 下.BR, 下.BL]）。
 */
export function mergedSlot(
  a: ComicPanelSlot,
  b: ComicPanelSlot,
): { slot: ComicPanelSlot; axis: "horizontal" | "vertical" } {
  const xOverlap = overlapLength(a.x, a.x + a.w, b.x, b.x + b.w);
  const yOverlap = overlapLength(a.y, a.y + a.h, b.y, b.y + b.h);
  // 重なりが大きい軸の「反対側」が並びの軸。x が重なっているなら上下に並んでいる。
  const axis: "horizontal" | "vertical" =
    yOverlap >= xOverlap ? "horizontal" : "vertical";
  const [aTl, aTr, aBr, aBl] = panelGuidePoints(a);
  const [bTl, bTr, bBr, bBl] = panelGuidePoints(b);
  if (axis === "horizontal") {
    // 左右に並ぶ。左側のコマの左辺 + 右側のコマの右辺で外周を作る。
    const aIsLeft = a.x <= b.x;
    const left = aIsLeft ? { tl: aTl, bl: aBl } : { tl: bTl, bl: bBl };
    const right = aIsLeft ? { tr: bTr, br: bBr } : { tr: aTr, br: aBr };
    return {
      slot: slotFromPoints([left.tl, right.tr, right.br, left.bl]),
      axis,
    };
  }
  // 上下に並ぶ。上側の上辺 + 下側の下辺で外周を作る。
  const aIsTop = a.y <= b.y;
  const top = aIsTop ? { tl: aTl, tr: aTr } : { tl: bTl, tr: bTr };
  const bottom = aIsTop ? { br: bBr, bl: bBl } : { br: aBr, bl: aBl };
  return {
    slot: slotFromPoints([top.tl, top.tr, bottom.br, bottom.bl]),
    axis,
  };
}

/** 点が多角形の内側か（偶奇判定。panelReedit.ts の isInsidePolygon と同型）。 */
function isInsidePolygon(x: number, y: number, points: PanelReeditPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects =
      (a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** percent 座標 → px 座標（panelReedit.ts と同じスケーリング）。 */
function toPixels(points: PanelReeditPoint[], width: number, height: number): PanelReeditPoint[] {
  return points.map((point) => ({ x: (point.x / 100) * width, y: (point.y / 100) * height }));
}

function bounds(points: PanelReeditPoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function distanceToSegment(
  x: number,
  y: number,
  a: PanelReeditPoint,
  b: PanelReeditPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(x - a.x, y - a.y);
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

function cloneRaster(raster: RgbaRaster): RgbaRaster {
  return {
    width: raster.width,
    height: raster.height,
    rgba: new Uint8ClampedArray(raster.rgba),
  };
}

function paint(
  raster: RgbaRaster,
  x: number,
  y: number,
  color: [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const offset = (y * raster.width + x) * 4;
  raster.rgba[offset] = color[0];
  raster.rgba[offset + 1] = color[1];
  raster.rgba[offset + 2] = color[2];
  raster.rgba[offset + 3] = color[3];
}

/** 枠線の太さ（短辺 0.3%・最小2px）。テンプレ生成画像の枠線と同オーダーに揃える。 */
function borderWidthPx(raster: RgbaRaster): number {
  return Math.max(2, Math.round(Math.min(raster.width, raster.height) * 0.003));
}

/** 統合時に消す帯の幅（短辺 1%・最小8px）。旧ガター + 旧枠線を確実に覆う。 */
function erasePx(raster: RgbaRaster): number {
  return Math.max(8, Math.round(Math.min(raster.width, raster.height) * 0.01));
}

/**
 * quad の辺の上に線を引く（線は辺の上に中心置き）。
 *
 * `clipPx` の内側だけに塗る。枠線は辺の上に中心置きするため、クリップしないと
 * 線幅の半分が元スロットの外へはみ出し、隣のコマ・外周枠線を書き換えてしまう
 * （「元スロットの外は1画素も変えない」という本機能の保証そのものを壊す）。
 */
function strokeEdges(
  raster: RgbaRaster,
  quadPx: PanelReeditPoint[],
  edges: Array<[number, number]>,
  widthPx: number,
  clipPx: PanelReeditPoint[],
): void {
  const half = widthPx / 2;
  const box = bounds(quadPx);
  const fromY = Math.max(0, Math.floor(box.minY - widthPx));
  const toY = Math.min(raster.height - 1, Math.ceil(box.maxY + widthPx));
  const fromX = Math.max(0, Math.floor(box.minX - widthPx));
  const toX = Math.min(raster.width - 1, Math.ceil(box.maxX + widthPx));
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      if (!isInsidePolygon(centerX, centerY, clipPx)) continue;
      const onEdge = edges.some(([from, to]) =>
        distanceToSegment(centerX, centerY, quadPx[from], quadPx[to]) <= half,
      );
      if (onEdge) paint(raster, x, y, BLACK);
    }
  }
}

/**
 * 分割をラスタへ描く純関数。変更されるのは元スロット quad の内側のみ:
 *  1) 元 quad 内で kept quad の内側「以外」を白塗り（空白側 + 新ガター）
 *  2) blank quad の4辺 + kept quad の分割線側1辺に黒枠線を描く
 * 元 quad の外側の画素差分は常に 0。
 */
export function drawSplitOnRaster(
  original: RgbaRaster,
  originalQuad: PanelReeditPoint[],
  keptQuad: PanelReeditPoint[],
  blankQuad: PanelReeditPoint[],
  direction: SplitDirection,
): RgbaRaster {
  const next = cloneRaster(original);
  const originalPx = toPixels(originalQuad, original.width, original.height);
  const keptPx = toPixels(keptQuad, original.width, original.height);
  const blankPx = toPixels(blankQuad, original.width, original.height);
  const box = bounds(originalPx);
  const fromY = Math.max(0, Math.floor(box.minY));
  const toY = Math.min(original.height - 1, Math.ceil(box.maxY));
  const fromX = Math.max(0, Math.floor(box.minX));
  const toX = Math.min(original.width - 1, Math.ceil(box.maxX));
  // 元 quad の内側のうち、残す側でない画素を白へ戻す（空白コマ + 新ガター）。
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      if (!isInsidePolygon(centerX, centerY, originalPx)) continue;
      if (isInsidePolygon(centerX, centerY, keptPx)) continue;
      paint(next, x, y, WHITE);
    }
  }
  const widthPx = borderWidthPx(original);
  // 空白コマは4辺すべてに枠線を描く。元 quad でクリップして外へはみ出させない。
  strokeEdges(next, blankPx, [[0, 1], [1, 2], [2, 3], [3, 0]], widthPx, originalPx);
  // 残す側は分割線側の1辺だけ描く（他3辺は元の枠線がそのまま残っている）。
  // kept/blank の頂点順は splitSlotQuads が保証する:
  //   vertical → kept=[分割線上, TR, BR, 分割線下] なので分割線側は辺 3→0
  //   horizontal → kept=[TL, TR, 分割線右, 分割線左] なので分割線側は辺 2→3
  // 方向は呼び出し側が確定して渡す。頂点座標からの推測（頂点0-3の x/y 差の比較）は
  // 斜めコマで逆の辺を選び、分割線が描かれないまま残る欠陥になっていた（Codex検分 2026-07-30）。
  const keptSharedEdge: Array<[number, number]> =
    direction === "vertical" ? [[3, 0]] : [[2, 3]];
  strokeEdges(next, keptPx, keptSharedEdge, widthPx, originalPx);
  return next;
}

/**
 * 統合をラスタへ描く純関数。統合 quad の内側のうち、
 * 「各元 quad を分割線側だけ erasePx 内側へ縮めた領域」のどちらにも属さない帯
 * （旧ガター + 旧枠線）を白塗りする。統合 quad の外側の画素差分は常に 0。
 */
export function drawMergeOnRaster(
  original: RgbaRaster,
  mergedQuad: PanelReeditPoint[],
  quadA: PanelReeditPoint[],
  quadB: PanelReeditPoint[],
  axis: "horizontal" | "vertical",
): RgbaRaster {
  const next = cloneRaster(original);
  const mergedPx = toPixels(mergedQuad, original.width, original.height);
  const aPx = toPixels(quadA, original.width, original.height);
  const bPx = toPixels(quadB, original.width, original.height);
  const erase = erasePx(original);
  const aBox = bounds(aPx);
  const bBox = bounds(bPx);
  /**
   * 各 quad を「相手側の辺」だけ内側へ縮めた領域。この2領域の外側 = 消す帯。
   * 縮めるのは bbox 判定で足りる（帯は相手との境界付近にしか出ない）。
   */
  const shrunk = (
    quadPx: PanelReeditPoint[],
    box: ReturnType<typeof bounds>,
    otherBox: ReturnType<typeof bounds>,
  ) => {
    const towardMaxX = axis === "horizontal" && box.minX < otherBox.minX;
    const towardMinX = axis === "horizontal" && box.minX > otherBox.minX;
    const towardMaxY = axis === "vertical" && box.minY < otherBox.minY;
    const towardMinY = axis === "vertical" && box.minY > otherBox.minY;
    return (x: number, y: number) => {
      if (!isInsidePolygon(x, y, quadPx)) return false;
      if (towardMaxX && x > box.maxX - erase) return false;
      if (towardMinX && x < box.minX + erase) return false;
      if (towardMaxY && y > box.maxY - erase) return false;
      if (towardMinY && y < box.minY + erase) return false;
      return true;
    };
  };
  const keepA = shrunk(aPx, aBox, bBox);
  const keepB = shrunk(bPx, bBox, aBox);
  const box = bounds(mergedPx);
  const fromY = Math.max(0, Math.floor(box.minY));
  const toY = Math.min(original.height - 1, Math.ceil(box.maxY));
  const fromX = Math.max(0, Math.floor(box.minX));
  const toX = Math.min(original.width - 1, Math.ceil(box.maxX));
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      if (!isInsidePolygon(centerX, centerY, mergedPx)) continue;
      if (keepA(centerX, centerY) || keepB(centerX, centerY)) continue;
      paint(next, x, y, WHITE);
    }
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * ストーリー（構成データ）側の変換。UI から独立に検証できる純関数。
 * ------------------------------------------------------------------ */

/** 初出順維持の完全一致 dedupe（assignCastName と同型）。 */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** index を 1..N へ振り直す（panelCount と panels.length の同時更新を守る）。 */
function renumber(panels: ComicPanel[]): ComicPanel[] {
  return panels.map((panel, i) => ({ ...panel, index: i + 1 }));
}

/**
 * 分割後のページ構成。分割元 index の直後へ空コマを挿入し、
 * slotsOverride を [first, second] へ差し替える。
 * 空コマの形は addStoryPanel の newPanel と同形（生成側の前提を揃える）。
 */
export function splitStoryPage(
  page: ComicStoryPage,
  panelIndex: number,
  first: ComicPanelSlot,
  second: ComicPanelSlot,
  currentSlots?: ComicPanelSlot[],
): ComicStoryPage {
  const slots = currentSlots ?? page.slotsOverride;
  if (!slots || slots.length !== page.panels.length) {
    throw new Error("コマ割りの情報とコマ数が一致しないため、このページは編集できません。");
  }
  const position = page.panels.findIndex((panel) => panel.index === panelIndex);
  if (position < 0) {
    throw new Error("編集元のコマが見つかりません。");
  }
  const blankPanel: ComicPanel = {
    index: panelIndex + 1,
    composition: "",
    characters: [],
    acting: "",
    balloons: [],
    sfx: [],
    prompt: "",
  };
  const panels = renumber([
    ...page.panels.slice(0, position + 1),
    blankPanel,
    ...page.panels.slice(position + 1),
  ]);
  const slotsOverride = [
    ...slots.slice(0, position),
    first,
    second,
    ...slots.slice(position + 1),
  ];
  return { ...page, panelCount: panels.length, panels, slotsOverride };
}

/**
 * 統合後のページ構成。読み順で先のコマを残し、後のコマの吹き出し・擬音・キャラを
 * 残す側へ合流させる（消さない原則。上限2はネーム生成時の目安でありデータ制約ではない）。
 * slotsOverride は2スロットを merged へ置換する。
 */
export function mergeStoryPage(
  page: ComicStoryPage,
  panelIndex: number,
  neighborIndex: number,
  merged: ComicPanelSlot,
  currentSlots?: ComicPanelSlot[],
): ComicStoryPage {
  const slots = currentSlots ?? page.slotsOverride;
  if (!slots || slots.length !== page.panels.length) {
    throw new Error("コマ割りの情報とコマ数が一致しないため、このページは編集できません。");
  }
  if (panelIndex === neighborIndex) {
    throw new Error("同じコマ同士は統合できません。");
  }
  const keptIndex = Math.min(panelIndex, neighborIndex);
  const removedIndex = Math.max(panelIndex, neighborIndex);
  const keptPosition = page.panels.findIndex((panel) => panel.index === keptIndex);
  const removedPosition = page.panels.findIndex((panel) => panel.index === removedIndex);
  if (keptPosition < 0 || removedPosition < 0) {
    throw new Error("編集元のコマが見つかりません。");
  }
  const kept = page.panels[keptPosition];
  const removed = page.panels[removedPosition];
  const mergedPanel: ComicPanel = {
    ...kept,
    characters: dedupe([...kept.characters, ...removed.characters]),
    balloons: [...kept.balloons, ...removed.balloons],
    sfx: [...kept.sfx, ...removed.sfx],
  };
  const panels = renumber(
    page.panels
      .map((panel) => (panel.index === keptIndex ? mergedPanel : panel))
      .filter((panel) => panel.index !== removedIndex),
  );
  const slotsOverride = slots
    .map((slot, i) => (i === keptPosition ? merged : slot))
    .filter((_, i) => i !== removedPosition);
  return { ...page, panelCount: panels.length, panels, slotsOverride };
}

/* ------------------------------------------------------------------ *
 * ブラウザ境界（panelReedit.ts の私有 I/O と同型の再掲）。
 * ------------------------------------------------------------------ */

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`画像を読み込めません: ${path}`));
    image.src = convertFileSrc(path);
  });
}

function imageRaster(image: HTMLImageElement): RgbaRaster {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("画像の確認に必要な canvas を取得できません。");
  context.drawImage(image, 0, 0);
  return {
    width: canvas.width,
    height: canvas.height,
    rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

async function pngBytes(raster: RgbaRaster): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像の保存に必要な canvas を取得できません。");
  context.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("画像のPNG化に失敗しました。");
  return new Uint8Array(await blob.arrayBuffer());
}

/** ブラウザ境界: 画像パス → ラスタ読込 → drawSplitOnRaster → PNG bytes。 */
export async function applyPanelSplitToImage(
  imagePath: string,
  originalQuad: PanelReeditPoint[],
  keptQuad: PanelReeditPoint[],
  blankQuad: PanelReeditPoint[],
  direction: SplitDirection,
): Promise<Uint8Array> {
  const original = imageRaster(await loadImage(imagePath));
  return pngBytes(drawSplitOnRaster(original, originalQuad, keptQuad, blankQuad, direction));
}

/** ブラウザ境界: 画像パス → ラスタ読込 → drawMergeOnRaster → PNG bytes。 */
export async function applyPanelMergeToImage(
  imagePath: string,
  mergedQuad: PanelReeditPoint[],
  quadA: PanelReeditPoint[],
  quadB: PanelReeditPoint[],
  axis: "horizontal" | "vertical",
): Promise<Uint8Array> {
  const original = imageRaster(await loadImage(imagePath));
  return pngBytes(drawMergeOnRaster(original, mergedQuad, quadA, quadB, axis));
}
