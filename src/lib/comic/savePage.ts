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
import {
  buildComicPageFileName,
  COMIC_EXPORT_TARGET,
  containRect,
  toThemeSegment,
} from "./exportSize";
import type { ComicSaveFormat } from "./types";

/**
 * 保存ファイル名を決める。テーマがあれば「テーマ＋ページ数」、無ければ従来の連番。
 *
 * 実装契約O (2026-08-05): STΛCK 実機FB「保存ファイル名をテーマ＋ページ数に」。
 * 従来は `manga_C001.png` で、フォルダに複数作品を保存すると**どれがどの話か
 * 分からず、さらに同名で上書き衝突する**。テーマを載せると作品の識別が付く。
 *
 * フォールバックが要るのは、テーマ（あらすじ）が未入力・記号だけのことがあるため。
 * その場合に推測でそれらしい名前を作らず、既知の安全な連番へ落とす
 * （no-silent-gap-filling: 無いものを埋めない）。
 */
function resolvePageFileName(opts: {
  theme: string | undefined;
  page: number;
  total: number;
  ext: string;
}): string {
  const theme = opts.theme ? toThemeSegment(opts.theme) : null;
  if (theme) {
    return buildComicPageFileName({
      theme,
      page: opts.page,
      total: opts.total,
      ext: opts.ext,
    });
  }
  return buildExportFileName({
    style: "sequence",
    prefix: "manga",
    index: opts.page,
    ext: opts.ext,
  });
}

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
 * **出力は必ず高解像度2160×2880（3:4）**。作業寸法1080×1440と同じ比率なので、
 * 標準の作業ページは白帯なしで縦横2倍へ拡大する（規格の正本は exportSize.ts）。
 * 別比率の入力も contain で切らず、余った左右（または上下）だけ白帯にする。
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
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

/** blob → base64（data: プレフィックスなし）。大きな画像でもスタックを使わない。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("画像の書き出し準備に失敗しました。"));
    reader.readAsDataURL(blob);
  });
}

/**
 * ページ画像を高解像度3:4に正規化した**新しいファイル**を作り、そのパスを返す。
 *
 * ## 実装契約O (2026-08-05): なぜ「保存の瞬間」だけでは足りなかったか
 *
 * STΛCK 実機FB「出力サイズが統一されていない」。壊れていたのは**関所の位置**だった。
 * 正規化は `encodePageBlob`（＝保存ボタン経路）に
 * しか無く、生成直後のページは**生のまま**（モデル出力が 2:3 / 3:4 に揺れる）。
 * その生のページが「プロジェクトに保存」(`addItem`) でギャラリーへ登録されると、
 * 以降のギャラリー側の書き出し・共有はすべて未正規化の実体を掴む。
 * ＝ページの形が揃わない実感の正体はこの経路。
 *
 * ## 受領時正規化との役割分担（design-comic-feedback-r1.md §1 A-a・修正1）
 *
 * S9 以降は、生成・再生成・分割/統合で受け取った作業用ページを先に
 * 1080×1440（3:4）へ contain 正規化し、白帯がある場合は `contentRect` を記録する。
 * これにより編集対象・マスク・AI返却画像の比率を3:4へ揃え、コマ座標は
 * `contentRect` を通して実コンテンツ領域へ合わせる。
 *
 * 本ファイルの関所は廃止せず、外へ出す画像を2160×2880（3:4）へ揃える
 * **出口側の役割**を引き続き担う。出口は次の3つ:
 *
 *   1. `savePageAs`            … 1ページ保存（`encodePageBlob` 経由）
 *   2. `savePagesBulk`         … 一括保存（同上）
 *   3. `materializeExportPage` … ギャラリー/プロジェクト登録
 *
 * 作業用1080×1440と書き出し用2160×2880を別ファイルにし、元ファイルを上書きしない。
 * 同じ3:4なので標準経路は白帯なしで2倍拡大し、画像を切り落とさない。
 */
export async function materializeExportPage(
  imagePath: string,
  pageNo: number,
  format: ComicSaveFormat = "png",
): Promise<string> {
  const blob = await encodePageBlob(imagePath, format);
  const { editExport } = await import("../ipc");
  const { join, dirname, basename, extname } = await import("@tauri-apps/api/path");
  const dir = await dirname(imagePath);
  const base = await basename(imagePath, await extname(imagePath).catch(() => ""));
  // 元ファイルの隣に `_3x4` を付けた別名で置く。元を上書きしないのが要点
  // （上書きすると panelReedit の寸法一致・枠線検出が壊れる）。
  const stem = base.replace(/\.$/, "") || `manga_p${pageNo}`;
  const dest = await join(dir, `${stem}_3x4.${extOf(format)}`);
  // 元画像がfs:scope外でも書けるRustコマンドを使う。JPEGもバイト列のまま保存される。
  await editExport.png(dest, await blobToBase64(blob));
  return dest;
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
  naming?: { theme?: string; totalPages?: number },
): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const pngFilter = { name: "PNG", extensions: ["png"] };
  const jpegFilter = { name: "JPEG", extensions: ["jpg", "jpeg"] };
  const dest = await save({
    defaultPath: resolvePageFileName({
      theme: naming?.theme,
      page: pageNo,
      // 総数が未指定なら「このページまで」を総数と見る（1ページ保存の既定）。
      total: naming?.totalPages ?? pageNo,
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
  naming?: { theme?: string },
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
  // 総数は「実際に保存対象になるページ数」＝渡された一覧の長さ。
  // 実行時点の固定値を書かない（規律3）。
  const total = pages.length;
  // この一括保存の中で既に使った名前。同名衝突を上書きでなく連番退避で避ける。
  const usedNames = new Set<string>();
  for (const page of pages) {
    if (!page.imagePath) {
      skipped += 1;
      continue;
    }
    const base = resolvePageFileName({
      theme: naming?.theme,
      page: page.page,
      total,
      ext,
    });
    // 既存の流儀に合わせて上書きせず連番退避する（`名前_2.png`）。
    // テーマ名は 20 文字で切るため、別テーマでも先頭が同じだと衝突しうる。
    let name = base;
    if (usedNames.has(name)) {
      const stem = base.slice(0, base.length - (ext.length + 1));
      let n = 2;
      while (usedNames.has(`${stem}_${n}.${ext}`)) n += 1;
      name = `${stem}_${n}.${ext}`;
    }
    usedNames.add(name);
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
