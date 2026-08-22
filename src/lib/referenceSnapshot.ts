import { invoke } from "@tauri-apps/api/core";

import { humanizeError } from "./humanizeError";

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

/** 外部パスが消えても参照できるよう、Rust 側で app data 配下へ複製する。 */
export function snapshotReference(sourcePath: string): Promise<string> {
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

export const referenceSnapshotInternals = {
  errorText,
  missingReferenceGuidance,
  withDetail,
};
