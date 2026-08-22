import { invoke } from "@tauri-apps/api/core";

import { humanizeError } from "../humanizeError";

const CURRENT_MISSING_REFERENCE =
  /参照画像が見つかりません[（(]([^）)]+)[）)]。?画像を選び直してください。?/;
const LEGACY_MISSING_REFERENCE = /参照画像が見つかりません:\s*([^\r\n]+)/;

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "").replace(/\s+/g, " ").trim();
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "選択した画像";
}

function missingReferenceGuidance(raw: string): string | null {
  const current = raw.match(CURRENT_MISSING_REFERENCE);
  if (current) {
    return `参照画像が見つかりません（${current[1]}）。画像を選び直してください`;
  }
  const legacy = raw.match(LEGACY_MISSING_REFERENCE);
  if (legacy) {
    return `参照画像が見つかりません（${fileName(legacy[1].trim())}）。画像を選び直してください`;
  }
  return null;
}

export function isMissingReferenceError(error: unknown): boolean {
  return missingReferenceGuidance(errorText(error)) !== null;
}

function withDetail(message: string, raw: string): string {
  const detail = humanizeError(raw).replace(/。+$/, "");
  if (!detail || message.includes(detail)) return message;
  return `${message}（詳しい内容: ${detail}）`;
}

/** Rust 側で app data 配下へ複製し、生成に使う管理パスを受け取る。 */
export function snapshotStickerReference(sourcePath: string): Promise<string> {
  return invoke<string>("character_sheet_snapshot_reference", { sourcePath });
}

/** 選択時／生成直前の参照画像エラーを、次の行動が分かる形にする。 */
export function formatReferenceSnapshotError(error: unknown): string {
  const raw = errorText(error);
  const missing = missingReferenceGuidance(raw);
  if (missing) return withDetail(missing, raw);

  return withDetail(
    "参照画像をアプリ内に保存できませんでした。空き容量やアクセス権を確認し、画像を選び直してください。",
    raw,
  );
}

/** 1波の失敗理由を、一般文言で隠さずトースト／エラーログ用に整える。 */
export function formatStickerGenerationFailure(
  failedCount: number,
  reasons: readonly string[],
): string {
  const uniqueReasons = Array.from(new Set(reasons.map(errorText).filter(Boolean)));
  const missing = uniqueReasons.map(missingReferenceGuidance).find(Boolean);
  if (missing) {
    const raw = uniqueReasons.find((reason) => missingReferenceGuidance(reason) === missing) ?? "";
    return withDetail(missing, raw);
  }

  if (uniqueReasons.length === 0) {
    return `${failedCount}枚の生成結果を受け取れませんでした。エラーログを確認してください。`;
  }

  const primary = humanizeError(uniqueReasons[0]).replace(/。+$/, "");
  const more = uniqueReasons.length > 1 ? `ほか${uniqueReasons.length - 1}件の理由があります。` : "";
  return withDetail(
    `${failedCount}枚の生成に失敗しました。理由: ${primary}。${more}`,
    uniqueReasons.join(" / "),
  );
}
