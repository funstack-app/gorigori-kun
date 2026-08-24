import type { RegulationImageResult } from "../regulationCheck/check";

export type RegulationRecheckRuleSelection = {
  ruleSetId: string;
  customRule: string;
};

export type PendingRegulationRecheckSnapshot = RegulationRecheckRuleSelection & {
  imagePath: string;
  sentAt: number;
};

export type RecheckResultStatus = Pick<
  RegulationImageResult,
  "imagePath" | "error" | "aiPending"
>;

/** 検査結果に保存されたルールを、レッドライン送り時の待ち情報として凍結する。 */
export function createPendingRegulationRecheck(
  imagePath: string,
  resultState: RegulationRecheckRuleSelection,
  sentAt = Date.now(),
): PendingRegulationRecheckSnapshot {
  return {
    imagePath,
    ruleSetId: resultState.ruleSetId,
    customRule: resultState.customRule,
    sentAt,
  };
}

/** 画面の現在値ではなく、待ち情報に凍結されたルールを再検品へ渡す。 */
export function selectFrozenRecheckRules(
  pending: RegulationRecheckRuleSelection,
): RegulationRecheckRuleSelection {
  return {
    ruleSetId: pending.ruleSetId,
    customRule: pending.customRule,
  };
}

/** 結果が存在し、エラーがなく、AI判定まで完了した場合だけ成功とする。 */
export function isSuccessfulRecheckResult(
  result: RecheckResultStatus | null | undefined,
  revisedPath: string,
): boolean {
  return Boolean(
    result &&
      result.imagePath === revisedPath &&
      result.error === null &&
      result.aiPending === false,
  );
}

/** 元画像の位置だけを修正版へ差し替え、ほかの検査対象と並び順は保つ。 */
export function replaceImageForRecheck(
  imagePaths: readonly string[],
  originalPath: string,
  revisedPath: string,
): string[] {
  return imagePaths.map((path) => (path === originalPath ? revisedPath : path));
}
