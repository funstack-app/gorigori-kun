/**
 * 構成AIが返した行構造を、ページpercentの決定論スロットへ変換する。
 *
 * AIは「どのコマを同じ行に置くか」だけを決め、座標はこの純関数が固定する。
 * これにより、おまかせレイアウトでも読み方向に合った位置語と編集ガイドを使える。
 */

import type { ComicPanelSlot } from "./layoutTemplates";
import type { ComicReadingDirection } from "./types";

export const COMIC_SYNTHESIS_OUTER_MARGIN = 4;
export const COMIC_SYNTHESIS_GUTTER = 3;

function validRows(rows: number[][], panelCount: number): boolean {
  if (!Number.isInteger(panelCount) || panelCount <= 0 || rows.length === 0) {
    return false;
  }
  if (rows.some((row) => !Array.isArray(row) || row.length === 0)) {
    return false;
  }

  const panelNumbers = rows.flat();
  if (panelNumbers.length !== panelCount) return false;
  if (
    panelNumbers.some(
      (panelNo) =>
        !Number.isInteger(panelNo) || panelNo < 1 || panelNo > panelCount,
    )
  ) {
    return false;
  }
  return new Set(panelNumbers).size === panelCount;
}

/**
 * rowsをaxis-aligned長方形スロットへ変換する。
 *
 * 契約:
 * - rows内の数値は1..panelCountを重複・欠番なく一度ずつ含む
 * - 外周4%、ガター3%
 * - 行内はrtl=右から、ltr=左から
 * - 1コマ行を少し高くするため、行高weightは `1 + 1 / 行内コマ数`
 */
export function synthesizeSlotsFromRows(
  rows: number[][],
  panelCount: number,
  direction: ComicReadingDirection,
): ComicPanelSlot[] | null {
  if (!validRows(rows, panelCount)) return null;
  if (direction !== "rtl" && direction !== "ltr") return null;

  const margin = COMIC_SYNTHESIS_OUTER_MARGIN;
  const gutter = COMIC_SYNTHESIS_GUTTER;
  const usableHeight = 100 - margin * 2 - gutter * (rows.length - 1);
  if (usableHeight <= 0) return null;

  // 逆数をそのまま行高にすると差が強すぎるため、基礎weight 1へ軽く足す。
  const rowWeights = rows.map((row) => 1 + 1 / row.length);
  const totalWeight = rowWeights.reduce((sum, weight) => sum + weight, 0);
  const slots: Array<ComicPanelSlot | undefined> = Array(panelCount);
  let y = margin;

  rows.forEach((row, rowIndex) => {
    const h = (usableHeight * rowWeights[rowIndex]) / totalWeight;
    const usableWidth = 100 - margin * 2 - gutter * (row.length - 1);
    const w = usableWidth / row.length;

    row.forEach((panelNo, positionInRow) => {
      const x =
        direction === "ltr"
          ? margin + positionInRow * (w + gutter)
          : 100 - margin - w - positionInRow * (w + gutter);
      // 配列indexは既存ComicPanelSlot契約どおり、読み順のコマ番号-1。
      slots[panelNo - 1] = { x, y, w, h };
    });
    y += h + gutter;
  });

  if (slots.some((slot) => !slot)) return null;
  return slots as ComicPanelSlot[];
}
