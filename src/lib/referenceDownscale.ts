import { convertFileSrc } from "@tauri-apps/api/core";

import { images } from "./ipc";

export const REFERENCE_MAX_LONG_EDGE = 2048;

export type ContainedImageSize = {
  width: number;
  height: number;
  needsDownscale: boolean;
};

export type ReferenceOutputFormat = {
  extension: "png" | "jpg";
  mimeType: "image/png" | "image/jpeg";
  quality?: number;
};

/** 長辺だけを上限に収め、元の縦横比を保つ。 */
export function calculateContainedImageSize(
  width: number,
  height: number,
  maxLongEdge = REFERENCE_MAX_LONG_EDGE,
): ContainedImageSize {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width, height, needsDownscale: false };
  }

  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    needsDownscale: true,
  };
}

/** 透明部分がある PNG だけ透明度を保ち、それ以外は軽い JPEG にする。 */
export function chooseReferenceOutputFormat(
  sourceIsPng: boolean,
  hasAlpha: boolean,
): ReferenceOutputFormat {
  if (sourceIsPng && hasAlpha) {
    return { extension: "png", mimeType: "image/png" };
  }
  return { extension: "jpg", mimeType: "image/jpeg", quality: 0.9 };
}

const downscaledPathCache = new Map<string, Promise<string>>();

function isPngPath(path: string): boolean {
  return /\.png$/i.test(path.split(/[?#]/, 1)[0] ?? path);
}

function hasAlphaPixels(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let alphaIndex = 3; alphaIndex < pixels.length; alphaIndex += 4) {
    if (pixels[alphaIndex] < 255) return true;
  }
  return false;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ReferenceOutputFormat,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("参照画像の縮小データを作成できませんでした"));
      },
      format.mimeType,
      format.quality,
    );
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("参照画像を読み込めませんでした"));
    image.src = url;
  });
}

function outputFileName(path: string, extension: ReferenceOutputFormat["extension"]): string {
  const basename = path.split(/[\\/]/).pop() || "reference";
  const stem = basename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "reference";
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${stem}-send-2048-${suffix}.${extension}`;
}

async function createDownscaledCopy(path: string): Promise<string> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok && response.status !== 0) {
    throw new Error(`参照画像を読み込めませんでした (${response.status})`);
  }

  const sourceBlob = await response.blob();
  const objectUrl = URL.createObjectURL(sourceBlob);
  let image: HTMLImageElement | null = null;
  let canvas: HTMLCanvasElement | null = null;

  try {
    image = await loadImage(objectUrl);
    const size = calculateContainedImageSize(image.naturalWidth, image.naturalHeight);
    if (!size.needsDownscale) return path;

    canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: isPngPath(path) });
    if (!context) throw new Error("参照画像の縮小処理を開始できませんでした");

    context.drawImage(image, 0, 0, size.width, size.height);
    const format = chooseReferenceOutputFormat(
      isPngPath(path),
      isPngPath(path) && hasAlphaPixels(context, size.width, size.height),
    );
    const outputBlob = await canvasToBlob(canvas, format);
    const outputPath = await images.writeUpload(
      outputFileName(path, format.extension),
      new Uint8Array(await outputBlob.arrayBuffer()),
    );

    // GoalChat で作ったコピーが planChat の共通送信口へ渡った場合も再検査しない。
    downscaledPathCache.set(outputPath, Promise.resolve(outputPath));
    return outputPath;
  } finally {
    URL.revokeObjectURL(objectUrl);
    if (image) image.src = "";
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

/**
 * 送信用の軽量コピーを必要な時だけ作る。元ファイルは変更しない。
 * 同じパスの処理中 Promise も共有し、同時送信でも二重に縮小しない。
 */
export function ensureDownscaledCopy(path: string): Promise<string> {
  const cached = downscaledPathCache.get(path);
  if (cached) return cached;

  const pending = createDownscaledCopy(path).catch((error) => {
    downscaledPathCache.delete(path);
    throw error;
  });
  downscaledPathCache.set(path, pending);
  return pending;
}
