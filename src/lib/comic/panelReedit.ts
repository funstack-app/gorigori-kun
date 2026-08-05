/**
 * 漫画のコマ部分再編集のうち、**漫画固有**のロジック。
 *
 * ## 2026-08-05 の分解（設計書 v3 §1.5.2 / S3）
 *
 * 本ファイルにあった汎用の純粋関数群（多角形バリデータ・マスクRGBA生成・寸法一致検証・
 * 合成・マスク外差分ゼロ検証・量子化寸法の救済・ブラウザI/O）は
 * `src/lib/imageReedit/maskReedit.ts` へ **verbatim で移動**した。
 * スタンプの個別編集が同じ部品を使うため、**コピーせず1箇所へ集約**したもの。
 *
 * ここに残るのは漫画にしか無い概念だけ:
 *
 * | 残す | 理由 |
 * |---|---|
 * | `detectPanelInterior` | ページ画像から**枠線を勾配検出**してコマ内側を決める。スタンプに枠線もコマも無い |
 * | `panelGuidePoints` | `ComicPanelSlot`（テンプレのコマ座標）に依存 |
 * | `resolvePanelReeditReferences` | `ComicPanel.characters` に依存 |
 * | 隣接コマ制約の実体 | 隣のコマへ白が漏れない保証。スタンプに隣は無い |
 *
 * **既存の import は無変更で通る**（受入基準 T12）: 汎用群は下の re-export で
 * このモジュールからも従来どおり読める。`ComicWorkspace.tsx` / `panelLayoutOps.ts` /
 * `panelSlotRecovery.ts` / `tests-quality/*.check.ts` は1行も変えていない。
 */
import {
  setNeighborGuideResolver,
  validatePanelPolygon,
  type PanelImageData,
  type PanelPolygonConstraints,
  type PanelReeditPoint,
} from "../imageReedit/maskReedit";
import type { ComicPanelSlot } from "./layoutTemplates";
import type { ComicCharacter, ComicPanel } from "./types";

/**
 * 汎用層の re-export。
 *
 * 移動前と同じ名前・同じ実体をこのモジュールから読めるようにするための橋。
 * 新規コードは `src/lib/imageReedit/maskReedit.ts` から直接 import すること。
 */
export {
  assertSameRasterDimensions,
  buildBrushMaskArtifact,
  buildPanelReeditGenerationRequest,
  buildPanelReeditImageInputs,
  compositePanelImages,
  compositePanelRgba,
  countMaskWhitePixels,
  countOutsideMaskDifferences,
  createPanelMaskPng,
  createPanelMaskRgba,
  isCurrentPanelReeditRun,
  isPanelReeditResizable,
  normalizeBrushMaskRgba,
  PANEL_REEDIT_ASPECT_TOLERANCE,
  readPanelImageData,
  validatePanelPolygon,
} from "../imageReedit/maskReedit";
export type {
  PanelImageData,
  PanelMaskArtifact,
  PanelPolygonConstraints,
  PanelReeditPoint,
  RgbaRaster,
} from "../imageReedit/maskReedit";

export type PanelDetectionMetrics = {
  borderSupport: number;
  edgeContrast: number;
  areaPlausibility: number;
  neighborClearance: number;
  threshold: number;
  sampleStepPx: number;
  innerPaddingPx: number;
};

export type PanelDetection = {
  points: PanelReeditPoint[];
  confidence: number;
  generationDisabled: boolean;
  failureCode?: "low-confidence" | "border-support" | "neighbor-clearance" | "invalid-polygon";
  metrics: PanelDetectionMetrics;
};

function polygonArea(points: PanelReeditPoint[]): number {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function grayscaleGradient(image: PanelImageData, x: number, y: number): number {
  const sample = (sx: number, sy: number) => {
    const px = Math.max(0, Math.min(image.width - 1, Math.round(sx)));
    const py = Math.max(0, Math.min(image.height - 1, Math.round(sy)));
    const index = (py * image.width + px) * 4;
    return image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
  };
  const horizontal = sample(x + 1, y) - sample(x - 1, y);
  const vertical = sample(x, y + 1) - sample(x, y - 1);
  return Math.min(255, Math.hypot(horizontal, vertical));
}

function lineIntersection(
  first: { point: PanelReeditPoint; direction: PanelReeditPoint },
  second: { point: PanelReeditPoint; direction: PanelReeditPoint },
): PanelReeditPoint | null {
  const denominator = first.direction.x * second.direction.y - first.direction.y * second.direction.x;
  if (Math.abs(denominator) < 0.00001) return null;
  const dx = second.point.x - first.point.x;
  const dy = second.point.y - first.point.y;
  const t = (dx * second.direction.y - dy * second.direction.x) / denominator;
  return { x: first.point.x + first.direction.x * t, y: first.point.y + first.direction.y * t };
}

function insetPoints(points: PanelReeditPoint[], insetPx: number, width: number, height: number): PanelReeditPoint[] {
  const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  centroid.x /= points.length;
  centroid.y /= points.length;
  return points.map((point) => {
    const dx = centroid.x - point.x;
    const dy = centroid.y - point.y;
    const scale = Math.hypot(dx, dy) || 1;
    return {
      x: Math.max(0, Math.min(100, point.x + ((dx / scale) * insetPx * 100) / width)),
      y: Math.max(0, Math.min(100, point.y + ((dy / scale) * insetPx * 100) / height)),
    };
  });
}

/**
 * テンプレ近傍だけを走査して、実画像の枠線からコマ内側を決定する純粋関数。
 * テンプレ座標は探索開始位置であり、返すpointsは採用した画像勾配の位置から作る。
 */
export function detectPanelInterior(
  image: PanelImageData,
  selectedSlotIndex: number,
  slots: ComicPanelSlot[],
): PanelDetection {
  const slot = slots[selectedSlotIndex];
  const emptyMetrics: PanelDetectionMetrics = {
    borderSupport: 0, edgeContrast: 0, areaPlausibility: 0, neighborClearance: 0,
    threshold: 24, sampleStepPx: 1, innerPaddingPx: 0,
  };
  if (!slot || image.width <= 0 || image.height <= 0) {
    return { points: [], confidence: 0, generationDisabled: true, failureCode: "invalid-polygon", metrics: emptyMetrics };
  }
  const shortSide = Math.min(image.width, image.height);
  const bandPx = shortSide * 0.025;
  const sampleStepPx = Math.max(1, shortSide * 0.0025);
  const source = panelGuidePoints(slot);
  const allGradients: number[] = [];
  // 辺方向の各サンプルを分けて保持する。後で「枠線を見付けた長さ」を
  // 画素候補の総数ではなく、実際に支持されたサンプル数で計算するため。
  const edgeSamples: Array<Array<Array<{ offset: number; gradient: number }>>> = [];
  for (let edge = 0; edge < source.length; edge += 1) {
    const start = { x: source[edge].x * image.width / 100, y: source[edge].y * image.height / 100 };
    const endPoint = source[(edge + 1) % source.length];
    const end = { x: endPoint.x * image.width / 100, y: endPoint.y * image.height / 100 };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const normal = { x: -dy / length, y: dx / length };
    const samples: Array<Array<{ offset: number; gradient: number }>> = [];
    for (let along = 0; along <= length; along += sampleStepPx) {
      const baseX = start.x + (dx * along) / length;
      const baseY = start.y + (dy * along) / length;
      const alongSamples: Array<{ offset: number; gradient: number }> = [];
      for (let offset = -bandPx; offset <= bandPx; offset += 1) {
        const gradient = grayscaleGradient(image, baseX + normal.x * offset, baseY + normal.y * offset);
        allGradients.push(gradient);
        alongSamples.push({ offset, gradient });
      }
      samples.push(alongSamples);
    }
    edgeSamples.push(samples);
  }
  const threshold = Math.max(24, percentile(allGradients, 0.75));
  const detectedEdges = source.map((point, edge) => {
    const next = source[(edge + 1) % source.length];
    const dx = (next.x - point.x) * image.width / 100;
    const dy = (next.y - point.y) * image.height / 100;
    const length = Math.hypot(dx, dy) || 1;
    const normal = { x: -dy / length, y: dx / length };
    const candidateRows = edgeSamples[edge].map((samples) => samples.filter((sample) => sample.gradient >= threshold));
    const candidates = candidateRows.flat();
    // 1つの枠線は両側で勾配が立つため、各辺方向サンプルではテンプレ近傍に
    // 最も近い候補を1つだけ選ぶ。全候補を混ぜると線幅ぶん外側へ寄る。
    const offsets = candidateRows
      .filter((samples) => samples.length > 0)
      .map((samples) => samples.reduce((best, sample) =>
        Math.abs(sample.offset) < Math.abs(best.offset) ||
          (Math.abs(sample.offset) === Math.abs(best.offset) && sample.offset > best.offset)
          ? sample
          : best,
      ).offset);
    return {
      // 勾配の山は1px枠線の外縁にも立つ。内側の稜線へ1px寄せてから、
      // 後段の0.4%保護余白を引くことで、枠線そのものを白マスクに含めない。
      point: { x: point.x * image.width / 100 + normal.x * (percentile(offsets, 0.5) + 1), y: point.y * image.height / 100 + normal.y * (percentile(offsets, 0.5) + 1) },
      direction: { x: dx, y: dy },
      // 探索帯内の候補画素数ではなく、枠線候補を得た辺方向の割合で正規化する。
      support: candidateRows.filter((samples) => samples.length > 0).length / Math.max(1, candidateRows.length),
      contrast: percentile(candidates.map((sample) => sample.gradient), 0.5),
    };
  });
  const detectedOuter = detectedEdges.map((edge, index) =>
    lineIntersection(detectedEdges[(index - 1 + detectedEdges.length) % detectedEdges.length], edge),
  );
  if (detectedOuter.some((point) => point === null)) {
    return { points: [], confidence: 0, generationDisabled: true, failureCode: "invalid-polygon", metrics: { ...emptyMetrics, threshold, sampleStepPx, innerPaddingPx: shortSide * 0.004 } };
  }
  const outerPercent = detectedOuter.map((point) => ({ x: point!.x * 100 / image.width, y: point!.y * 100 / image.height }));
  const innerPaddingPx = shortSide * 0.004;
  const points = insetPoints(outerPercent, innerPaddingPx, image.width, image.height);
  let valid = true;
  try {
    validatePanelPolygon(points, { selectedSlotIndex, slots });
  } catch {
    valid = false;
  }
  const templateArea = polygonArea(source);
  const detectedArea = polygonArea(points);
  const areaPlausibility = templateArea > 0 && detectedArea > 0 ? Math.min(detectedArea / templateArea, templateArea / detectedArea) : 0;
  const borderSupport = detectedEdges.reduce((sum, edge) => sum + edge.support, 0) / detectedEdges.length;
  const edgeContrast = Math.min(1, percentile(detectedEdges.map((edge) => edge.contrast), 0.5) / 255);
  const neighborClearance = valid ? 1 : 0;
  const confidence = 0.5 * borderSupport + 0.25 * edgeContrast + 0.15 * areaPlausibility + 0.1 * neighborClearance;
  const generationDisabled = !valid || confidence < 0.8 || borderSupport < 0.7;
  const failureCode = !valid ? "neighbor-clearance" : borderSupport < 0.7 ? "border-support" : confidence < 0.8 ? "low-confidence" : undefined;
  return {
    points,
    confidence,
    generationDisabled,
    failureCode,
    metrics: { borderSupport, edgeContrast, areaPlausibility, neighborClearance, threshold, sampleStepPx, innerPaddingPx },
  };
}

/** テンプレの座標は、利用者が動かす前の初期ガイドとしてだけ変換する。 */
export function panelGuidePoints(slot: ComicPanelSlot): PanelReeditPoint[] {
  if (slot.points) {
    return slot.points.map(([x, y]) => ({ x, y }));
  }
  return [
    { x: slot.x, y: slot.y },
    { x: slot.x + slot.w, y: slot.y },
    { x: slot.x + slot.w, y: slot.y + slot.h },
    { x: slot.x, y: slot.y + slot.h },
  ];
}

/**
 * 隣接コマ制約の頂点変換を汎用層へ登録する。
 *
 * 汎用層は `ComicPanelSlot` を知らない（知ると comic へ依存し、スタンプから使えなくなる）。
 * そこで「slot → 頂点列」の変換だけをこちらから注入する。
 * このモジュールが import された時点で登録されるので、`validatePanelPolygon` に
 * constraints を渡す漫画側の経路は従来どおり隣接判定が効く。
 */
setNeighborGuideResolver((slot) => panelGuidePoints(slot as ComicPanelSlot));

/**
 * 漫画用の型付きラッパ。`slots` を `ComicPanelSlot[]` に固定して、
 * 呼び出し側が誤った配列を渡せないようにする。
 */
export type ComicPanelPolygonConstraints = Omit<PanelPolygonConstraints, "slots"> & {
  slots: ComicPanelSlot[];
};

/** このコマに完全一致する登録キャラだけを参照に採用する。fallbackは作らない。 */
export function resolvePanelReeditReferences(
  panel: Pick<ComicPanel, "characters">,
  characters: ComicCharacter[],
): { characters: ComicCharacter[]; refPaths: string[] } {
  const names = new Set(panel.characters.map((name) => name.trim()).filter(Boolean));
  const matched = characters.filter((character) => names.has(character.name.trim()));
  return { characters: matched, refPaths: matched.flatMap((character) => character.referenceImagePaths) };
}
