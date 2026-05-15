import type { TextLayerSpec } from "./types";

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function renderTextLayer(
  baseImageBlob: Blob,
  layers: TextLayerSpec[],
): Promise<Blob> {
  const img = await blobToImage(baseImageBlob);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0);

  for (const layer of layers) {
    if (layer.visible === false) continue;
    const family = layer.fontFamily ?? layer.font ?? "system-ui";
    const size = layer.fontSize ?? layer.size ?? 24;
    const weight = layer.fontWeight ?? "normal";
    const color = layer.color ?? "#000000";
    const align = layer.align ?? "left";
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.font = `${weight} ${size}px "${family}"`;
    ctx.textAlign = align;
    ctx.textBaseline = "top";

    const bbox = layer.bbox;
    let x = layer.x ?? 0;
    const y = bbox ? bbox[1] : (layer.y ?? 0);
    if (bbox) {
      const [bx, , bw] = bbox;
      x = align === "left" ? bx : align === "right" ? bx + bw : bx + bw / 2;
    }
    if (layer.rotation) {
      ctx.translate(x, y);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.fillText(layer.text, 0, 0);
    } else {
      ctx.fillText(layer.text, x, y);
    }
    ctx.restore();
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
