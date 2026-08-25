import type { NormalizedBbox } from "./RegionSelectOverlay";

export const MAGNIFIC_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
] as const;

export type MagnificAspectRatio = (typeof MAGNIFIC_ASPECT_RATIOS)[number];

export const CROP_ASPECT_RATIOS = [
  "custom",
  "1:1",
  "21:9",
  "16:9",
  "9:16",
  "2:3",
  "3:4",
  "3:2",
  "4:3",
  "1:2",
  "2:1",
  "5:4",
  "4:5",
] as const;

export type CropAspectRatio = (typeof CROP_ASPECT_RATIOS)[number];

export function parseAspectRatio(value: string): number | null {
  const [width, height] = value.split(":").map(Number);
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return width / height;
}

/** 元画像に最も近い、Magnific が受け取れる8種類の縦横比を返す。 */
export function closestMagnificAspect(width: number, height: number): MagnificAspectRatio {
  if (!(width > 0) || !(height > 0)) return "1:1";
  const sourceRatio = width / height;
  return MAGNIFIC_ASPECT_RATIOS.reduce((best, candidate) => {
    const bestRatio = parseAspectRatio(best) ?? 1;
    const candidateRatio = parseAspectRatio(candidate) ?? 1;
    // 横長と縦長を同じ重みで比べるため、単純な差ではなく対数距離を使う。
    return Math.abs(Math.log(sourceRatio / candidateRatio)) <
      Math.abs(Math.log(sourceRatio / bestRatio))
      ? candidate
      : best;
  }, MAGNIFIC_ASPECT_RATIOS[0]);
}

export function buildRestylePrompt(style: string): string {
  return `Restyle this exact image in ${style.trim()}. Keep the composition, subjects and framing identical.`;
}

export const LIGHT_AZIMUTHS = [-135, -90, -45, 0, 45, 90, 135, 180] as const;
export const LIGHT_ELEVATIONS = [-90, -45, 0, 45, 90] as const;

export type LightAzimuth = (typeof LIGHT_AZIMUTHS)[number];
export type LightElevation = (typeof LIGHT_ELEVATIONS)[number];

function circularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return Math.min(delta, 360 - delta);
}

/** 任意の角度を Magnific の8方位へ吸着する。-180°はAPI表現の180°へ揃える。 */
export function snapLightAzimuth(angle: number): LightAzimuth {
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  const canonical = normalized === -180 ? 180 : normalized;
  return LIGHT_AZIMUTHS.reduce((best, candidate) =>
    circularDistance(canonical, candidate) < circularDistance(canonical, best)
      ? candidate
      : best,
  LIGHT_AZIMUTHS[0]);
}

export function snapLightElevation(angle: number): LightElevation {
  const clamped = Math.max(-90, Math.min(90, angle));
  return LIGHT_ELEVATIONS.reduce((best, candidate) =>
    Math.abs(clamped - candidate) < Math.abs(clamped - best) ? candidate : best,
  LIGHT_ELEVATIONS[0]);
}

export function normalizeCameraRotate(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const normalized = ((Math.round(angle) % 360) + 360) % 360;
  return normalized === 0 && angle > 0 ? 360 : normalized;
}

export function clampCameraVertical(value: number): number {
  return Math.max(-30, Math.min(90, Math.round(value)));
}

/** 指定比率が元画像へ最大で収まるピクセル寸法。 */
export function cropPixelSizeForAspect(
  imageWidth: number,
  imageHeight: number,
  aspect: number,
): { width: number; height: number } {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !(aspect > 0)) {
    return { width: 1, height: 1 };
  }
  if (imageWidth / imageHeight > aspect) {
    return { width: Math.max(1, Math.round(imageHeight * aspect)), height: Math.round(imageHeight) };
  }
  return { width: Math.round(imageWidth), height: Math.max(1, Math.round(imageWidth / aspect)) };
}

/** ピクセル寸法の切り抜き枠を、画像中央の正規化座標へ変換する。 */
export function centeredCropRegion(
  imageWidth: number,
  imageHeight: number,
  requestedWidth: number,
  requestedHeight: number,
): NormalizedBbox | null {
  if (
    !(imageWidth > 0) ||
    !(imageHeight > 0) ||
    !(requestedWidth > 0) ||
    !(requestedHeight > 0)
  ) return null;
  const scale = Math.min(1, imageWidth / requestedWidth, imageHeight / requestedHeight);
  const width = Math.max(1, requestedWidth * scale) / imageWidth;
  const height = Math.max(1, requestedHeight * scale) / imageHeight;
  return [(1 - width) / 2, (1 - height) / 2, width, height];
}
