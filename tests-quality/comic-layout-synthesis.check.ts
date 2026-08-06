/**
 * おまかせ漫画の行グリッド合成回帰。ブラウザ不要の純関数検査。
 */
import { expect, test } from "@playwright/test";

import {
  COMIC_SYNTHESIS_GUTTER,
  COMIC_SYNTHESIS_OUTER_MARGIN,
  synthesizeSlotsFromRows,
} from "../src/lib/comic/layoutSynthesis";
import type { ComicPanelSlot } from "../src/lib/comic/layoutTemplates";

function overlaps(a: ComicPanelSlot, b: ComicPanelSlot): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function expectValidGrid(slots: ComicPanelSlot[], panelCount: number): void {
  expect(slots).toHaveLength(panelCount);
  for (const slot of slots) {
    // 小数計算の丸め（例: 3.999999999999993）だけを許し、4%境界は維持する。
    expect(slot.x).toBeGreaterThanOrEqual(COMIC_SYNTHESIS_OUTER_MARGIN - 1e-9);
    expect(slot.y).toBeGreaterThanOrEqual(COMIC_SYNTHESIS_OUTER_MARGIN - 1e-9);
    expect(slot.x + slot.w).toBeLessThanOrEqual(
      100 - COMIC_SYNTHESIS_OUTER_MARGIN + 1e-9,
    );
    expect(slot.y + slot.h).toBeLessThanOrEqual(
      100 - COMIC_SYNTHESIS_OUTER_MARGIN + 1e-9,
    );
    expect(slot.w).toBeGreaterThan(0);
    expect(slot.h).toBeGreaterThan(0);
  }
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      expect(overlaps(slots[i], slots[j]), `slot ${i + 1} vs ${j + 1}`).toBe(
        false,
      );
    }
  }
}

test("rowsからpanelCount個の非重複スロットを外周4%・ガター3%で作る", () => {
  const slots = synthesizeSlotsFromRows([[1, 2], [3], [4, 5, 6]], 6, "rtl");
  expect(slots).not.toBeNull();
  expectValidGrid(slots!, 6);

  // 1コマだけの中央行は、複数コマ行より見せ場として少し高い。
  expect(slots![2].h).toBeGreaterThan(slots![0].h);
  // 同じ行の隣同士には正確に3%のガターがある。
  expect(slots![0].x - (slots![1].x + slots![1].w)).toBeCloseTo(
    COMIC_SYNTHESIS_GUTTER,
    10,
  );
});

test("rtlでは行内の先頭コマを右に置く", () => {
  const slots = synthesizeSlotsFromRows([[1, 2, 3]], 3, "rtl");
  expect(slots).not.toBeNull();
  expect(slots![0].x).toBeGreaterThan(slots![1].x);
  expect(slots![1].x).toBeGreaterThan(slots![2].x);
  expect(slots![0].x + slots![0].w).toBeCloseTo(96, 10);
});

test("ltrでは行内の先頭コマを左に置く", () => {
  const slots = synthesizeSlotsFromRows([[1, 2, 3]], 3, "ltr");
  expect(slots).not.toBeNull();
  expect(slots![0].x).toBeLessThan(slots![1].x);
  expect(slots![1].x).toBeLessThan(slots![2].x);
  expect(slots![0].x).toBe(COMIC_SYNTHESIS_OUTER_MARGIN);
});

test("コマ番号が行をまたいでも返却配列はコマ番号順", () => {
  const slots = synthesizeSlotsFromRows([[2, 1], [4, 3]], 4, "ltr");
  expect(slots).not.toBeNull();
  // 行内先頭の2番が左、次の1番が右。配列自体はslot[0]=1番のまま。
  expect(slots![1].x).toBeLessThan(slots![0].x);
  expect(slots![3].x).toBeLessThan(slots![2].x);
  expect(slots![0].y).toBeLessThan(slots![2].y);
});

test("牙: 重複rowsは不正入力としてnullに落とす", () => {
  expect(synthesizeSlotsFromRows([[1, 2], [2, 3]], 4, "rtl")).toBeNull();
});

test("欠番・範囲外・空行・panelCount不一致もnull", () => {
  expect(synthesizeSlotsFromRows([[1, 2], [4]], 4, "rtl")).toBeNull();
  expect(synthesizeSlotsFromRows([[1, 2], [3, 5]], 4, "rtl")).toBeNull();
  expect(synthesizeSlotsFromRows([[1, 2], []], 2, "ltr")).toBeNull();
  expect(synthesizeSlotsFromRows([[1, 2, 3]], 2, "ltr")).toBeNull();
});
