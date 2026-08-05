/**
 * 主経路（ページ丸ごと1枚生成）のページ保存。
 *
 * 生成済みページ画像（ファイルパス）を形式選択つきで保存する。
 * **変換は canvas 再エンコード1本**（PNG でも再エンコード）。読み取り権限の
 * 新規追加が要らず、LayerComposer exportRaster で実証済みの
 * toBlob → writeFile 経路だけで完結するため。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { buildExportFileName } from "../exportNaming";
import { COMIC_EXPORT_TARGET, containRect } from "./exportSize";
import type { ComicSaveFormat } from "./types";

/** JPEG の書き出し品質（pageExport と同値）。 */
const JPEG_QUALITY = 0.92;

/** 画像を1枚読む（pageExport / LayerComposer と同じ実装）。 */
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // asset:// は cross-origin。crossOrigin を付けた CORS ロードでないと canvas が
    // 汚染され toBlob が "The operation is insecure." で死ぬ（Tauri asset protocol は
    // CORS ヘッダを返すため anonymous で成立。registerCharacter.ts の toDataURL 実績と同方式）。
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}

/**
 * 画像パスを canvas 経由で png/jpeg の Blob にする（crossOrigin 必須）。
 *
 * **出力は必ず SNS 規格 1080×1350（4:5）**。生成側は 3:4 を指定しているのに
 * モデル出力が 2:3 と 3:4 に混在し、同一作品内でページの形が揃わないため、
 * 保存の瞬間にここで固定する（規格と理由の正本は exportSize.ts）。
 * contain なので入力は切らず、余った左右（または上下）が白帯になる。
 * 元画像のファイル実体・表示・再編集は元寸のまま（触るのは書き出し canvas だけ）。
 */
export async function encodePageBlob(
  imagePath: string,
  format: ComicSaveFormat,
): Promise<Blob> {
  const img = await loadImage(convertFileSrc(imagePath));
  const canvas = document.createElement("canvas");
  canvas.width = COMIC_EXPORT_TARGET.width;
  canvas.height = COMIC_EXPORT_TARGET.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像の変換に失敗しました。");
  // 白地で塗ってから描く。透過 PNG → JPEG の黒化防止と contain の帯を1回の塗りで兼ねる。
  ctx.fillStyle = COMIC_EXPORT_TARGET.pad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rect = containRect(
    img.naturalWidth,
    img.naturalHeight,
    canvas.width,
    canvas.height,
  );
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      format === "jpeg" ? "image/jpeg" : "image/png",
      format === "jpeg" ? JPEG_QUALITY : undefined,
    ),
  );
  if (!blob) throw new Error("画像の変換に失敗しました。");
  return blob;
}

/** 保存形式に対応する拡張子。 */
function extOf(format: ComicSaveFormat): string {
  return format === "jpeg" ? "jpg" : "png";
}

/**
 * 1ページ保存。save ダイアログ → 拡張子で最終形式決定 → encodePageBlob → writeFile。
 *
 * 返却パスの拡張子が最終決定（ダイアログで変更できる）。キャンセルは false。
 */
export async function savePageAs(
  imagePath: string,
  pageNo: number,
  format: ComicSaveFormat,
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const pngFilter = { name: "PNG", extensions: ["png"] };
  const jpegFilter = { name: "JPEG", extensions: ["jpg", "jpeg"] };
  const dest = await save({
    defaultPath: buildExportFileName({
      style: "sequence",
      prefix: "manga",
      index: pageNo,
      ext: extOf(format),
    }),
    filters: format === "jpeg" ? [jpegFilter, pngFilter] : [pngFilter, jpegFilter],
  });
  // キャンセルは失敗ではない（トーストを出さない）。
  if (!dest) return false;
  // 拡張子が最終決定（ダイアログ側で変更されうる）。
  const finalFormat: ComicSaveFormat = /\.(jpe?g)$/i.test(dest) ? "jpeg" : "png";
  const blob = await encodePageBlob(imagePath, finalFormat);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

/**
 * 全ページ一括保存。open({ directory: true }) でフォルダ選択 → 完成ページのみ順に書き出し。
 *
 * ファイル名は既存 sequence 命名（manga_C001.png / manga_C002.png ...）。
 * ゼロ埋めで一覧順が保たれる。同名ファイルは上書き（writeFile 既定）。
 * 戻り値 null = フォルダ選択キャンセル。
 *
 * **1ページの失敗で全体を止めない**（2026-07-28 修正）。以前は途中で throw すると
 * 残りページが保存されず、呼び出し側にも saved/skipped が届かないため
 * 「何枚保存できたのか分からない」状態になっていた。失敗ページはスキップして
 * 続行し、failed に数えて呼び出し側のトーストで可視化する
 * （黙って落とさない = no-silent-gap-filling）。
 */
export async function savePagesBulk(
  pages: Array<{ page: number; imagePath?: string }>,
  format: ComicSaveFormat,
): Promise<{ saved: number; skipped: number; failed: number } | null> {
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
  const dir = await openDialog({
    directory: true,
    multiple: false,
    title: "保存先フォルダを選択",
  });
  if (typeof dir !== "string") return null;

  const { writeFile } = await import("@tauri-apps/plugin-fs");
  // パス結合は "/" 固定にしない。Windows のダイアログは `C:\...` を返すため
  // 区切りが混在する。join はプラットフォームの区切りで繋いでくれる。
  const { join } = await import("@tauri-apps/api/path");
  const ext = extOf(format);
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  for (const page of pages) {
    if (!page.imagePath) {
      skipped += 1;
      continue;
    }
    const name = buildExportFileName({
      style: "sequence",
      prefix: "manga",
      index: page.page,
      ext,
    });
    try {
      const blob = await encodePageBlob(page.imagePath, format);
      await writeFile(await join(dir, name), new Uint8Array(await blob.arrayBuffer()));
      saved += 1;
    } catch {
      // このページだけ諦めて次へ。件数は呼び出し側がまとめて出す。
      failed += 1;
    }
  }
  return { saved, skipped, failed };
}
