/**
 * 編集結果の書き出し (形式 + サイズ)。AI 不使用・数学的処理のみ。
 *
 * ## なぜ Rust を足さず canvas 再エンコードで作るか
 *
 * `src/lib/comic/savePage.ts` が既に「canvas.toBlob → plugin-fs の writeFile」で
 * 保存を実現しており、読み取り権限の追加も新しい Rust コマンドも要らない実績経路がある。
 * 同じ経路をそのまま使う (`fs:allow-write-file` は capabilities に登録済み)。
 * ブラウザエンジンの標準エンコーダなので、Intel Mac / Apple Silicon / Windows で
 * 同じ入力から同じ形式のファイルが出る。
 *
 * ## WebP の対応確認
 *
 * `canvas.toBlob(cb, "image/webp")` は非対応のエンジンだと**黙って PNG を返す**
 * (仕様上、未知の MIME はフォールバックする)。黙って別形式になるのは
 * 「WebP で書き出したのに PNG だった」という静かな嘘なので、
 * `supportsWebp()` で事前に判定し、非対応なら選択肢自体を出さない。
 */

import { buildExportFileName, exportTimestamp } from "../../../lib/exportNaming";

/** 書き出し形式。 */
export type ExportFormat = "png" | "jpeg" | "webp";

/** サイズ指定。元のまま / 長辺px / SNSプリセット。 */
export type ExportSize =
  | { kind: "original" }
  | { kind: "longEdge"; px: number }
  | { kind: "preset"; width: number; height: number };

/** SNS プリセット (設計確定値)。 */
export const EXPORT_SIZE_PRESETS = [
  { id: "square", label: "正方形 1080", width: 1080, height: 1080 },
  { id: "landscape", label: "横長 1920×1080", width: 1920, height: 1080 },
  { id: "portrait", label: "縦長 1080×1920", width: 1080, height: 1920 },
] as const;

const JPEG_QUALITY = 0.92;
const WEBP_QUALITY = 0.92;

/** 形式 → MIME。 */
function mimeOf(format: ExportFormat): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

/** 形式 → 拡張子。 */
export function extOf(format: ExportFormat): string {
  if (format === "jpeg") return "jpg";
  if (format === "webp") return "webp";
  return "png";
}

/**
 * このエンジンが WebP エンコードに対応しているか (同期判定)。
 *
 * `toDataURL("image/webp")` は非対応だと `data:image/png;...` を返すので、
 * 返ってきた MIME を見れば確実に分かる。1x1 の canvas なので実行コストは無視できる。
 */
export function supportsWebp(): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    return probe.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

/** dataURL を HTMLImageElement として読む。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めません。"));
    image.src = src;
  });
}

/**
 * 指定サイズから出力寸法を決める。
 *
 * - 元のまま: そのまま
 * - 長辺指定: 長い辺を指定 px に合わせ、短い辺は**縦横比を保って**決める
 * - プリセット: 指定寸法ちょうど。はみ出す分は中央で切る (cover)
 *
 * プリセットで cover を選ぶ理由: SNS の枠は寸法が決まっており、余白を足すと
 * 意図しない額縁が入る。中央基準なら主要被写体が中央にある一般的な構図で破綻しにくい。
 */
function resolveOutputSize(
  source: { width: number; height: number },
  size: ExportSize,
): { width: number; height: number; cover: boolean } {
  if (size.kind === "original") {
    return { width: source.width, height: source.height, cover: false };
  }
  if (size.kind === "longEdge") {
    const px = Math.max(1, Math.round(size.px));
    const long = Math.max(source.width, source.height);
    const scale = px / long;
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
      cover: false,
    };
  }
  return { width: size.width, height: size.height, cover: true };
}

/**
 * キャンバスの統合 PNG (base64) を、指定形式・指定サイズの Blob にする。
 *
 * JPEG は透過を持てないため、白地で塗ってから描く (透過部分が黒く潰れるのを防ぐ)。
 * PNG / WebP は透過をそのまま保つ。
 */
export async function encodeExportBlob(
  sourceBase64: string,
  format: ExportFormat,
  size: ExportSize,
): Promise<Blob> {
  const image = await loadImage(`data:image/png;base64,${sourceBase64}`);
  const source = { width: image.naturalWidth, height: image.naturalHeight };
  const out = resolveOutputSize(source, size);

  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像の変換に失敗しました。");

  if (format === "jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, out.width, out.height);
  }

  if (out.cover) {
    // 出力枠を埋める最小倍率で拡大し、はみ出した分を中央基準で切り落とす。
    const scale = Math.max(out.width / source.width, out.height / source.height);
    const drawWidth = source.width * scale;
    const drawHeight = source.height * scale;
    context.drawImage(
      image,
      (out.width - drawWidth) / 2,
      (out.height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  } else {
    context.drawImage(image, 0, 0, out.width, out.height);
  }

  const quality = format === "jpeg" ? JPEG_QUALITY : format === "webp" ? WEBP_QUALITY : undefined;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mimeOf(format), quality),
  );
  if (!blob) throw new Error("画像の変換に失敗しました。");
  return blob;
}

/**
 * 保存ダイアログを出して書き出す。保存したパスを返す (キャンセルは null)。
 *
 * 既存の書き出し (`useEditor.exportPng`) と同じく OS の保存ダイアログを通す。
 * 既定ファイル名は exportNaming の共通ルールで組む (実務の命名規則に合わせる下地)。
 */
export async function saveExportedImage(
  sourceBase64: string,
  format: ExportFormat,
  size: ExportSize,
): Promise<string | null> {
  const ext = extOf(format);
  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: buildExportFileName({
      style: "plain",
      prefix: `gori-export-${exportTimestamp()}`,
      ext,
    }),
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
  });
  if (typeof dest !== "string") return null;
  const blob = await encodeExportBlob(sourceBase64, format, size);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
  return dest;
}
