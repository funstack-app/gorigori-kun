import { humanizeError } from "../humanizeError";
import {
  formatReferenceSnapshotError,
  isMissingReferenceError,
  referenceSnapshotInternals,
  snapshotReference,
} from "../referenceSnapshot";

export { formatReferenceSnapshotError, isMissingReferenceError };

/** スタンプ側の既存名を保ったまま、共通の複製処理を使う。 */
export const snapshotStickerReference = snapshotReference;

/** 1波の失敗理由を、一般文言で隠さずトースト／エラーログ用に整える。 */
export function formatStickerGenerationFailure(
  failedCount: number,
  reasons: readonly string[],
): string {
  const { errorText, missingReferenceGuidance, withDetail } = referenceSnapshotInternals;
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
