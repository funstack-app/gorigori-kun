import { convertFileSrc } from "@tauri-apps/api/core";

import { images as imagesIpc } from "../ipc";

/**
 * レイヤーの透過 PNG（前景のみ不透明）から、
 * 「白い領域だけ編集する」という inpainting 用 2 値マスクを生成し、
 * `images_write_upload` 経由で永続化してファイルパスを返す。
 *
 * 元画像の解像度・アスペクト比は維持する必要があるため、
 * レイヤー画像のサイズをそのまま採用する。
 *
 * Why: Rust 側 batch_gen の has_mask 分岐は「白い領域だけ編集対象」と
 *      指示するテンプレを使う。透過レイヤーの alpha=255 を白、それ以外を黒に
 *      落とせば「そのレイヤーが占めていた領域だけ AI 編集」が成立する。
 */
export async function buildMaskFromLayer(
  layerImagePath: string,
  sourceImageName: string,
): Promise<string> {
  const url = convertFileSrc(layerImagePath);
  const img = await loadImage(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("マスク生成に必要な canvas コンテキストを取得できません。");
  }
  ctx.drawImage(img, 0, 0);

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = data.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    const visible = alpha > 16; // ほぼ透明は黒、それ以外は白
    const value = visible ? 255 : 0;
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
      } else {
        reject(new Error("マスク画像の Blob 化に失敗しました。"));
      }
    }, "image/png");
  });
  const buffer = new Uint8Array(await blob.arrayBuffer());

  const stem = stripExtension(sourceImageName) || "layer";
  const fileName = `mask-${stem}-${Date.now()}.png`;
  return imagesIpc.writeUpload(fileName, buffer);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}
