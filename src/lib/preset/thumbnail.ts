/**
 * プリセットサムネイルを Canvas でリサイズして base64 data URL に変換する。
 *
 * Why: localStorage には 5MB 程度の制限があるため、画像を素のまま
 * 突っ込むとすぐ容量オーバーする。一方で 256px は明らかに荒いので、
 * 長辺 1024 / JPEG q=0.92 程度に引き上げて視認できる解像度を確保する。
 * 1024 + q92 で 1 枚あたり 200-400KB 程度。10-20 枚なら localStorage に収まる。
 */

const MAX_DIMENSION = 1024;
const QUALITY = 0.92;

export async function fileToThumbnailDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("画像ファイルではありません");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_DIMENSION);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas コンテキストを取得できません");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w / h;
  if (w >= h) return { width: max, height: Math.round(max / ratio) };
  return { width: Math.round(max * ratio), height: max };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像読み込みに失敗"));
    img.src = src;
  });
}
