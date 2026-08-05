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
 * ページ画像を 4:5 に正規化した**新しいファイル**を作り、そのパスを返す。
 *
 * ## 実装契約O (2026-08-05): なぜ「保存の瞬間」だけでは足りなかったか
 *
 * STΛCK 実機FB「出力サイズが統一されていない」。比率は 4:5 のままでよく、
 * 壊れていたのは**関所の位置**だった。正規化は `encodePageBlob`（＝保存ボタン経路）に
 * しか無く、生成直後のページは**生のまま**（モデル出力が 2:3 / 3:4 に揺れる）。
 * その生のページが「プロジェクトに保存」(`addItem`) でギャラリーへ登録されると、
 * 以降のギャラリー側の書き出し・共有はすべて未正規化の実体を掴む。
 * ＝ページの形が揃わない実感の正体はこの経路。
 *
 * ## 関所を「受領時」に置かなかった理由（確認結果・原則4「矛盾に名前を付ける」）
 *
 * 契約Oは「受領時に1回正規化し、以後の全経路がそれを使う」を第1案としていた。
 * **これは採れない**。コマ再編集(panelReedit)がページ画像の画素に依存するため:
 *
 * | 依存 | 実体 | 白帯を焼くと何が壊れるか |
 * |---|---|---|
 * | `detectPanelInterior` | ページ画像から枠線を**勾配検出**してコマ内側を決める | 白帯が偽の枠線・偽の余白として混じり、コマ境界の検出がずれる |
 * | `assertSameRasterDimensions` | 元ページ・生成画像・マスクの寸法一致を要求（maskReedit.ts:312） | 正規化後ページ(1080×1350)と AI 返却画像の寸法が噛み合わず不採用が増える |
 *
 * さらに既存プロジェクトの未正規化ページとの互換も切れる（過去ページだけ座標系が違う）。
 * よって**編集の実体は元寸のまま**にし、正規化は「外に出る出口」に置く。
 * 出口は3つで、すべてこの関所を通る:
 *
 *   1. `savePageAs`          … 1ページ保存（`encodePageBlob` 経由）
 *   2. `savePagesBulk`       … 一括保存（同上）
 *   3. `materializeExportPage` … ギャラリー/プロジェクト登録（本関数。ここが今回の穴）
 *
 * 元ファイルは消さず別ファイルを作る。編集・再編集は元寸の実体を使い続けるため
 * （上の表の依存を壊さない）。情報は1画素も捨てない（contain・縮小のみ）。
 */
export async function materializeExportPage(
  imagePath: string,
  pageNo: number,
  format: ComicSaveFormat = "png",
): Promise<string> {
  const blob = await encodePageBlob(imagePath, format);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const { join, dirname, basename, extname } = await import("@tauri-apps/api/path");
  const dir = await dirname(imagePath);
  const base = await basename(imagePath, await extname(imagePath).catch(() => ""));
  // 元ファイルの隣に `_4x5` を付けた別名で置く。元を上書きしないのが要点
  // （上書きすると panelReedit の寸法一致・枠線検出が壊れる）。
  const stem = base.replace(/\.$/, "") || `manga_p${pageNo}`;
  const dest = await join(dir, `${stem}_4x5.${extOf(format)}`);
  await writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
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
