/**
 * 見開き組み立て（buildSpreads）の回帰。ブラウザ不要の純ロジック検査。
 *
 * 検査の芯は、本の綴じ規則が壊れないこと:
 *  1) 1ページ目は常に単独（表紙側の片面）
 *  2) 以降は 2-3 / 4-5 … の連続ペアで、番号が飛ばない・重複しない
 *  3) 偶数ページで終わる本は最終ページも単独（端数）
 *
 * 左右の並び（rtl で右=先）は表示側の flex-row-reverse が持つ責務なので、
 * ここでは検査しない（buildSpreads は読み方向に依存しない純関数）。
 */
import { expect, test } from "@playwright/test";

import { buildSpreads } from "../src/lib/comic/spreads";

test("1ページの本は単独見開き1つ", () => {
  expect(buildSpreads(1)).toEqual([[1]]);
});

test("偶数ページで終わる本は最終ページも単独", () => {
  expect(buildSpreads(4)).toEqual([[1], [2, 3], [4]]);
  expect(buildSpreads(6)).toEqual([[1], [2, 3], [4, 5], [6]]);
});

test("奇数ページで終わる本は最終見開きがペアで埋まる", () => {
  expect(buildSpreads(5)).toEqual([[1], [2, 3], [4, 5]]);
  expect(buildSpreads(3)).toEqual([[1], [2, 3]]);
});

test("ページ0以下は見開きなし（モーダルが空配列で落ちない前提）", () => {
  expect(buildSpreads(0)).toEqual([]);
  expect(buildSpreads(-1)).toEqual([]);
});

test("1..40ページのどれでも、全ページが順番どおり1回ずつ現れる", () => {
  for (let pageCount = 1; pageCount <= 40; pageCount += 1) {
    const spreads = buildSpreads(pageCount);
    // 平坦化すると 1..pageCount の昇順そのものになる（欠落・重複・順序入替なし）
    const flat = spreads.flat();
    expect(flat, `pageCount=${pageCount}`).toEqual(
      Array.from({ length: pageCount }, (_, i) => i + 1),
    );
    // 1ページ目は必ず単独、どの見開きも1..2ページ
    expect(spreads[0], `pageCount=${pageCount}`).toEqual([1]);
    for (const spread of spreads) {
      expect(spread.length, `pageCount=${pageCount}`).toBeGreaterThanOrEqual(1);
      expect(spread.length, `pageCount=${pageCount}`).toBeLessThanOrEqual(2);
    }
    // 単独になってよいのは先頭と（端数の）末尾だけ
    for (const spread of spreads.slice(1, -1)) {
      expect(spread.length, `pageCount=${pageCount}`).toBe(2);
    }
  }
});
