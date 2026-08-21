/**
 * ページ番号を「見開き（最大2ページ）」の列に組み立てる。読み方向には依存しない
 * （左右の並べ替えは表示側が flex-row-reverse で行う）。
 *
 * 右綴じ・左綴じ共通の本の規則:
 *  - 1ページ目は常に単独（表紙側の片面）
 *  - 以降 2-3 / 4-5 … のペア
 *  - 端数（偶数ページで終わる本）の最終ページも単独
 *
 * 例:
 *   1 → [[1]]
 *   4 → [[1], [2,3], [4]]
 *   5 → [[1], [2,3], [4,5]]
 *   6 → [[1], [2,3], [4,5], [6]]
 */
export function buildSpreads(pageCount: number): number[][] {
  if (pageCount <= 0) return [];
  const spreads: number[][] = [[1]];
  for (let page = 2; page <= pageCount; page += 2) {
    spreads.push(page + 1 <= pageCount ? [page, page + 1] : [page]);
  }
  return spreads;
}
