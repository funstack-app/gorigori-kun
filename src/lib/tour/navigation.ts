import type { TourStep } from "./types";

export type TourTargetResolver = (selector: string) => unknown | null;

/**
 * 指定位置から、実際に画面上に存在する次のステップを探す。
 * 対象が消えた画面でもツアー全体を止めないため、DOM には依存させず単体テスト可能にする。
 */
export function findAvailableStepIndex(
  steps: TourStep[],
  startIndex: number,
  direction: 1 | -1,
  resolveTarget: TourTargetResolver,
): number | null {
  for (
    let index = startIndex;
    index >= 0 && index < steps.length;
    index += direction
  ) {
    if (resolveTarget(steps[index].target)) return index;
  }
  return null;
}
