/**
 * マスク部分再編集の**汎用層**（画像1枚 + マスク → AI再生成 → 安全合成）。
 *
 * ## 出自と、なぜここにあるか
 *
 * 本ファイルの中身は `src/lib/comic/panelReedit.ts` に実装され、漫画のコマ部分再編集で
 * 検証済みの純粋関数群を **verbatim で移動** したもの（設計書 v3 §1.5.2）。
 * スタンプの個別編集が「漫画のコマ編集と同じ部品を接続する」（STΛCK決定5）ため、
 * **コピーではなく移動**して1箇所に集約した。
 *
 * コピーにしなかった理由: マスク合成の安全性（マスク外差分ゼロ検証・寸法一致検証）は
 * この機構の中核であり、2箇所に散ると次にバグが見つかったとき片方だけ直る。
 *
 * ## ここに置くもの / 置かないもの
 *
 * | 置く | 置かない |
 * |---|---|
 * | 多角形バリデータ・マスクRGBA生成・寸法一致検証・合成・量子化寸法の救済 | **漫画固有**（ページ画像からの枠線勾配検出 `detectPanelInterior` / テンプレ座標 `panelGuidePoints` / 隣接コマ制約の実体 / `ComicPanel` 依存の参照解決） |
 *
 * 漫画固有のものは `src/lib/comic/panelReedit.ts` に残っており、同ファイルは本ファイルを
 * re-export するため **既存の import は無変更で通る**（受入基準 T12）。
 *
 * ## 隣接制約はこの層では「型だけ」持つ
 *
 * `validatePanelPolygon` の `constraints` は optional で、渡さなければ隣接判定を
 * スキップする（下記 `if (!constraints) return;`）。スタンプには隣のコマが無いので
 * constraints を渡さず、汎用の多角形バリデータとして使う。
 * 隣接判定に必要な `panelGuidePoints`（テンプレ座標 → 頂点）は漫画固有なので、
 * 呼び出し側から**注入**する形にしてこの層の comic 依存を断つ（`setNeighborGuideResolver`）。
 *
 * 命名は `Panel*` のまま維持している。改名すると既存の import・テスト・
 * 検証済みという事実の追跡可能性が同時に壊れるため（設計書 §1.5.2「既存の呼び出しを壊さない」）。
 */
import { convertFileSrc } from "@tauri-apps/api/core";

/** 画像左上を原点とする、利用者が確定した頂点（percent）。 */
export type PanelReeditPoint = { x: number; y: number };

export type RgbaRaster = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

/** AIへ渡すPNGと、同一白黒画素で安全合成するための一組。 */
export type PanelMaskArtifact = {
  pngBytes: Uint8Array;
  width: number;
  height: number;
  raster: RgbaRaster;
};

export type PanelImageData = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/**
 * 選択領域以外の実枠へ入らないための検証条件。
 *
 * `slots` の要素型をこの層では具体化しない（漫画の `ComicPanelSlot` に依存させないため）。
 * 頂点への変換は `setNeighborGuideResolver` で注入された関数が行う。
 */
export type PanelPolygonConstraints = {
  selectedSlotIndex: number;
  slots: unknown[];
  /** 隣接枠から取る安全域（percent）。 */
  neighborPaddingPercent?: number;
};

const MASK_WHITE = 255;
const MASK_BLACK = 0;

/**
 * slot → 頂点列の変換。**漫画側が起動時に注入する**（`panelReedit.ts` 末尾）。
 *
 * 未注入のまま constraints 付きで呼ぶのは呼び出し側の配線ミスなので、救済せず落とす。
 * スタンプのように constraints を渡さない経路では一切参照されない。
 */
let neighborGuideResolver: ((slot: unknown) => PanelReeditPoint[]) | null = null;

export function setNeighborGuideResolver(
  resolver: (slot: unknown) => PanelReeditPoint[],
): void {
  neighborGuideResolver = resolver;
}

function orientation(a: PanelReeditPoint, b: PanelReeditPoint, c: PanelReeditPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: PanelReeditPoint, b: PanelReeditPoint, point: PanelReeditPoint): boolean {
  return (
    Math.min(a.x, b.x) <= point.x &&
    point.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= point.y &&
    point.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(
  a: PanelReeditPoint,
  b: PanelReeditPoint,
  c: PanelReeditPoint,
  d: PanelReeditPoint,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)) return true;
  return (
    (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b))
  );
}

function hasSelfIntersection(points: PanelReeditPoint[]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    const nextI = (i + 1) % points.length;
    for (let j = i + 1; j < points.length; j += 1) {
      const nextJ = (j + 1) % points.length;
      if (i === j || nextI === j || nextJ === i) continue;
      if (segmentsIntersect(points[i], points[nextI], points[j], points[nextJ])) return true;
    }
  }
  return false;
}

export function isInsidePolygon(x: number, y: number, points: PanelReeditPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    const intersects =
      (a.y > y) !== (b.y > y) &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(
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

function minimumPolygonDistance(a: PanelReeditPoint[], b: PanelReeditPoint[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const point of a) {
    for (let index = 0; index < b.length; index += 1) {
      minimum = Math.min(minimum, distanceToSegment(point.x, point.y, b[index], b[(index + 1) % b.length]));
    }
  }
  for (const point of b) {
    for (let index = 0; index < a.length; index += 1) {
      minimum = Math.min(minimum, distanceToSegment(point.x, point.y, a[index], a[(index + 1) % a.length]));
    }
  }
  return minimum;
}

export function polygonsOverlap(a: PanelReeditPoint[], b: PanelReeditPoint[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return isInsidePolygon(a[0].x, a[0].y, b) || isInsidePolygon(b[0].x, b[0].y, a);
}

/**
 * 頂点が画像内にあり、面として扱えることを確認する。
 *
 * `constraints` は optional。渡さなければ隣接判定をスキップするので、
 * スタンプのような「隣が無い」用途では汎用の多角形バリデータとして使える。
 */
export function validatePanelPolygon(
  points: PanelReeditPoint[],
  constraints?: PanelPolygonConstraints,
): void {
  if (points.length < 3) throw new Error("編集範囲は3点以上で指定してください。");
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error("編集範囲の頂点が正しくありません。");
    }
    if (point.x < 0 || point.x > 100 || point.y < 0 || point.y > 100) {
      throw new Error("編集範囲はページの外へ出せません。");
    }
  }
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (hasSelfIntersection(points)) {
    throw new Error("編集範囲の辺が交差しています。頂点の順番を直してください。");
  }
  if (Math.abs(area) < 40) throw new Error("編集範囲が小さすぎます。");
  if (!constraints) return;
  if (!neighborGuideResolver) {
    // 隣接制約を要求しながら変換器が無いのは配線ミス。黙って隣接判定を飛ばすと
    // 「制約を渡したのに効いていない」という最も危険な壊れ方をするので、必ず落とす。
    throw new Error("隣接制約の頂点変換が登録されていません。");
  }
  const padding = constraints.neighborPaddingPercent ?? 0.75;
  for (let index = 0; index < constraints.slots.length; index += 1) {
    if (index === constraints.selectedSlotIndex) continue;
    const neighbor = neighborGuideResolver(constraints.slots[index]);
    if (polygonsOverlap(points, neighbor) || minimumPolygonDistance(points, neighbor) < padding) {
      throw new Error("編集範囲が隣のコマまたは枠線保護の安全域に入っています。");
    }
  }
}

/** 元画像を第1参照、マスクをその対として固定する。 */
export function buildPanelReeditImageInputs(
  originalPath: string,
  maskPath: string,
  referencePaths: string[],
): { refImagePaths: string[]; maskPaths: string[] } {
  return {
    refImagePaths: [originalPath, ...referencePaths],
    maskPaths: [maskPath, ...referencePaths.map(() => "")],
  };
}

/**
 * 部分再編集の生成入力。元画像とマスクの実寸を正とするため、
 * 全体生成用の固定aspectはここへ絶対に渡さない。
 */
export function buildPanelReeditGenerationRequest(
  prompt: string,
  originalPath: string,
  maskPath: string,
  referencePaths: string[],
  sourceTag: string,
): {
  prompt: string;
  count: number;
  refImagePaths: string[];
  maskPaths: string[];
  sourceTag: string;
} {
  return {
    prompt,
    count: 1,
    ...buildPanelReeditImageInputs(originalPath, maskPath, referencePaths),
    sourceTag,
  };
}

/** 古い非同期runが新しい状態を上書きしないための採用判定。 */
export function isCurrentPanelReeditRun(token: number, currentToken: number): boolean {
  return token === currentToken;
}

/**
 * 枠線を守る白黒マスク。白は編集可、黒は絶対に採用しない領域。
 * 頂点を単に縮小せず、各ピクセルを「多角形の内側かつ全辺から余白以上」で判定するため、
 * 斜めの枠でも隣接コマや枠線へ白が漏れない。
 */
export function createPanelMaskRgba(
  width: number,
  height: number,
  points: PanelReeditPoint[],
  borderPaddingPx = 6,
  constraints?: PanelPolygonConstraints,
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("元ページの画像サイズを取得できません。");
  }
  if (borderPaddingPx < 1) throw new Error("枠線保護の余白が不足しています。");
  validatePanelPolygon(points, constraints);
  const pixels = new Uint8ClampedArray(width * height * 4);
  const scaled = points.map((point) => ({
    x: (point.x / 100) * width,
    y: (point.y / 100) * height,
  }));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      const inside = isInsidePolygon(centerX, centerY, scaled);
      const farFromEveryEdge = scaled.every((point, index) =>
        distanceToSegment(centerX, centerY, point, scaled[(index + 1) % scaled.length]) >=
        borderPaddingPx,
      );
      const value = inside && farFromEveryEdge ? MASK_WHITE : MASK_BLACK;
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = MASK_WHITE;
    }
  }
  return pixels;
}

/** 人間可読の文言を保ったまま、呼び出し側がサイズ不一致だけを検知する固定接頭辞。 */
export const PANEL_SIZE_MISMATCH_PREFIX = "生成サイズ不一致: ";

/** 寸法不一致の返却画像・マスクは、合成前に必ず不採用にする。 */
export function assertSameRasterDimensions(...rasters: RgbaRaster[]): void {
  const first = rasters[0];
  if (!first || rasters.some((raster) => raster.width !== first.width || raster.height !== first.height)) {
    throw new Error(
      `${PANEL_SIZE_MISMATCH_PREFIX}元ページ・生成画像・マスクのサイズが一致しないため採用しませんでした。`,
    );
  }
}

/**
 * AIは要求どおりの実寸ではなく量子化寸法（1024x1536等）で返すため、
 * 元画像と同じ構図のまま画素数だけ違う返却が常態になる。
 * 比率が一致していれば「同じ絵」なので、この幅までは合成前に引き伸ばして救済する。
 * これ以上ズレたものは構図が違う＝別の絵なので、従来どおり不採用にする。
 */
export const PANEL_REEDIT_ASPECT_TOLERANCE = 0.02;

/** 生成画像を元画像寸法へ合わせられるかを、比率だけで判定する。 */
export function isPanelReeditResizable(
  original: Pick<RgbaRaster, "width" | "height">,
  generated: Pick<RgbaRaster, "width" | "height">,
): boolean {
  if (original.width <= 0 || original.height <= 0 || generated.width <= 0 || generated.height <= 0) {
    return false;
  }
  const originalAspect = original.width / original.height;
  const generatedAspect = generated.width / generated.height;
  return Math.abs(generatedAspect - originalAspect) / originalAspect <= PANEL_REEDIT_ASPECT_TOLERANCE;
}

/** マスク外のRGBA差分を、透明度を含む4チャンネルで数える。 */
export function countOutsideMaskDifferences(
  before: RgbaRaster,
  after: RgbaRaster,
  mask: RgbaRaster,
): number {
  assertSameRasterDimensions(before, after, mask);
  let differences = 0;
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    if (mask.rgba[offset] > 0) continue;
    if (
      before.rgba[offset] !== after.rgba[offset] ||
      before.rgba[offset + 1] !== after.rgba[offset + 1] ||
      before.rgba[offset + 2] !== after.rgba[offset + 2] ||
      before.rgba[offset + 3] !== after.rgba[offset + 3]
    ) {
      differences += 1;
    }
  }
  return differences;
}

/** AI画像から採用するのは、白いマスクの内側だけ。 */
export function compositePanelRgba(
  original: RgbaRaster,
  generated: RgbaRaster,
  mask: RgbaRaster,
): RgbaRaster {
  assertSameRasterDimensions(original, generated, mask);
  const rgba = new Uint8ClampedArray(original.rgba);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (mask.rgba[offset] === 0) continue;
    rgba[offset] = generated.rgba[offset];
    rgba[offset + 1] = generated.rgba[offset + 1];
    rgba[offset + 2] = generated.rgba[offset + 2];
    rgba[offset + 3] = generated.rgba[offset + 3];
  }
  const composite = { width: original.width, height: original.height, rgba };
  const outsideDifferences = countOutsideMaskDifferences(original, composite, mask);
  if (outsideDifferences !== 0) {
    throw new Error(`マスク外の画素差分が ${outsideDifferences} 件あるため採用しませんでした。`);
  }
  return composite;
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`画像を読み込めません: ${path}`));
    image.src = convertFileSrc(path);
  });
}

function imageRaster(image: HTMLImageElement, width?: number, height?: number): RgbaRaster {
  const canvas = document.createElement("canvas");
  canvas.width = width ?? image.naturalWidth;
  canvas.height = height ?? image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("画像の確認に必要な canvas を取得できません。");
  // 引数寸法を渡した場合だけ拡縮する。既定は naturalWidth/Height の等倍。
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    rgba: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

/** ブラウザ画像の読込を検出計算から分離するためのUI境界。 */
export async function readPanelImageData(imagePath: string): Promise<PanelImageData> {
  const raster = imageRaster(await loadImage(imagePath));
  return { width: raster.width, height: raster.height, data: raster.rgba };
}

async function pngBlob(raster: RgbaRaster): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像の保存に必要な canvas を取得できません。");
  context.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("画像のPNG化に失敗しました。");
  return blob;
}

/** 確定頂点から、元画像と完全同寸の白黒PNGを作る。 */
export async function createPanelMaskPng(
  imagePath: string,
  points: PanelReeditPoint[],
  borderPaddingPx = 6,
  constraints?: PanelPolygonConstraints,
): Promise<PanelMaskArtifact> {
  const original = imageRaster(await loadImage(imagePath));
  const mask: RgbaRaster = {
    width: original.width,
    height: original.height,
    rgba: createPanelMaskRgba(original.width, original.height, points, borderPaddingPx, constraints),
  };
  const blob = await pngBlob(mask);
  return {
    pngBytes: new Uint8Array(await blob.arrayBuffer()),
    width: mask.width,
    height: mask.height,
    raster: mask,
  };
}

/**
 * 元・AI返却だけを読み、呼出し中に保持した同一マスクRGBAで合成する。
 * 隠し`.masks/`のファイルパスをWebViewから再読込しない。
 * 呼び出し元は返却bytesを新しい画像ファイルとして保存して初めて正本を更新する。
 */
export async function compositePanelImages(
  originalPath: string,
  generatedPath: string,
  maskRaster: RgbaRaster,
): Promise<{ bytes: Uint8Array; width: number; height: number; outsideDifferences: number }> {
  const [originalImage, generatedImage] = await Promise.all([
    loadImage(originalPath),
    loadImage(generatedPath),
  ]);
  const original = imageRaster(originalImage);
  // 元画像とマスクの不一致はこちらのロジック異常なので、救済せず必ず落とす。
  assertSameRasterDimensions(original, maskRaster);
  // AIの量子化寸法（比率同一・画素数違い）だけを、合成前に元画像寸法へ揃えて救済する。
  const generated = isPanelReeditResizable(original, {
    width: generatedImage.naturalWidth,
    height: generatedImage.naturalHeight,
  })
    ? imageRaster(generatedImage, original.width, original.height)
    : imageRaster(generatedImage);
  assertSameRasterDimensions(original, generated, maskRaster);
  const composite = compositePanelRgba(original, generated, maskRaster);
  const outsideDifferences = countOutsideMaskDifferences(original, composite, maskRaster);
  if (outsideDifferences !== 0) {
    throw new Error(`マスク外の画素差分が ${outsideDifferences} 件あるため採用しませんでした。`);
  }
  const blob = await pngBlob(composite);
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: composite.width,
    height: composite.height,
    outsideDifferences,
  };
}

/**
 * ブラシ由来のマスクPNG（白 on 透明）を、合成層が要求する白黒不透明RGBAへ正規化する。
 *
 * ## なぜ変換が要るか（実装差の実測）
 *
 * - `MaskCanvas.toBlob()`（`src/components/MaskCanvas.tsx:186`）は**塗った所だけ白・他は透明**を返す。
 *   `globalCompositeOperation = "destination-out"` の消しゴムを成立させるための当然の実装。
 * - 一方 `compositePanelRgba` / `countOutsideMaskDifferences` は **RGB の R チャンネルだけ**を見て
 *   白黒を判定する（`mask.rgba[offset] > 0`）。透明画素の R は 0 なので黒扱いになり、そこは偶然合う。
 *   だが**アンチエイリアスの縁**（ブラシは `lineCap: round` で必ず発生する）は R が 1〜254 になり、
 *   「0 でない＝白」と判定されて**半端な縁まで AI 出力を採用してしまう**。
 *
 * したがって R を**しきい値で二値化**して黒白を確定させ、アルファは全画素 255 に固定する。
 * しきい値 128 は中間調の境目。ブラシの縁はここで内外どちらかに倒れる。
 *
 * ブラシは領域を直接塗るので、多角形経路のような枠線保護余白（`borderPaddingPx`）は無い。
 * その代わり**二値化で縁を確定させる**ことが、マスク外差分ゼロ検証を成立させる前提になる。
 */
export function normalizeBrushMaskRgba(raster: RgbaRaster): RgbaRaster {
  const rgba = new Uint8ClampedArray(raster.rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    // 透明画素は「塗っていない」＝黒。アルファも見ることで、
    // 白を塗った後に消しゴムで抜いた領域を確実に黒へ倒す。
    const painted = raster.rgba[offset + 3] >= 128 && raster.rgba[offset] >= 128;
    const value = painted ? MASK_WHITE : MASK_BLACK;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = MASK_WHITE;
  }
  return { width: raster.width, height: raster.height, rgba };
}

/** 白画素が1つも無いマスクは「範囲未指定」。生成へ投げる前に弾く。 */
export function countMaskWhitePixels(raster: RgbaRaster): number {
  let count = 0;
  for (let offset = 0; offset < raster.rgba.length; offset += 4) {
    if (raster.rgba[offset] > 0) count += 1;
  }
  return count;
}

/** Blob（ブラシ由来のマスクPNG）を読み、二値化済みの白黒RGBAとPNGバイト列にする。 */
export async function buildBrushMaskArtifact(maskBlob: Blob): Promise<PanelMaskArtifact> {
  const bitmapUrl = URL.createObjectURL(maskBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("マスク画像を読み込めません。"));
      element.src = bitmapUrl;
    });
    const normalized = normalizeBrushMaskRgba(imageRaster(image));
    const blob = await pngBlob(normalized);
    return {
      pngBytes: new Uint8Array(await blob.arrayBuffer()),
      width: normalized.width,
      height: normalized.height,
      raster: normalized,
    };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
