/**
 * 漫画ページ書き出し規格（exportSize.ts）の回帰。ブラウザ不要の純ロジック検査。
 *
 * 検査の芯は3つ:
 *  1) 規格が 4:5 1080×1350・contain・白帯であること（定数の固定）
 *  2) 実生成ページの2大パターン（2:3 / 3:4）が切られずに規格へ収まること
 *  3) 縮小のみ（小さい入力を引き伸ばさない）・中央配置であること
 */
import { expect, test } from "@playwright/test";

import { COMIC_EXPORT_TARGET, containRect } from "../src/lib/comic/exportSize";

const { width: DST_W, height: DST_H } = COMIC_EXPORT_TARGET;

test("規格は 4:5 1080×1350・contain・白帯", () => {
  expect(COMIC_EXPORT_TARGET).toEqual({
    width: 1080,
    height: 1350,
    mode: "contain",
    pad: "#ffffff",
  });
  // 4:5 であること自体を比率でも押さえる（寸法の書き換え事故検知）。
  expect(DST_W / DST_H).toBeCloseTo(4 / 5, 10);
});

test("(a) 2:3 ネイティブ 1024×1536 → 900×1350・左右帯 各90px", () => {
  const rect = containRect(1024, 1536, DST_W, DST_H);
  expect(rect).toEqual({ x: 90, y: 0, w: 900, h: 1350 });
  // 高さいっぱい＝縦は1画素も切っていない。左右帯の合計が余白の全量。
  expect(rect.x * 2 + rect.w).toBe(DST_W);
});

test("(b) 3:4 ネイティブ 1086×1448 → 1013×1350・左右帯 各約34px", () => {
  const rect = containRect(1086, 1448, DST_W, DST_H);
  expect(rect.h).toBe(DST_H);
  expect(rect.w).toBe(1013);
  expect(rect.x).toBe(34);
  expect(rect.y).toBe(0);
  // round の端数が左右で割れても、描画が枠外へはみ出さない（＝切れない）。
  expect(rect.x + rect.w).toBeLessThanOrEqual(DST_W);
});

test("(c) 横長入力は上下帯になる（幅いっぱい・縦センタリング）", () => {
  const rect = containRect(1920, 1080, DST_W, DST_H);
  expect(rect.w).toBe(DST_W);
  expect(rect.x).toBe(0);
  expect(rect.h).toBe(608); // 1080 * (1080/1920) = 607.5 → round
  expect(rect.y).toBe(Math.round((DST_H - 608) / 2));
});

test("(d) 目標同寸は恒等・規格より小さい入力は拡大しない（縮小のみ）", () => {
  expect(containRect(DST_W, DST_H, DST_W, DST_H)).toEqual({
    x: 0,
    y: 0,
    w: DST_W,
    h: DST_H,
  });
  // 540×675（規格の半分・同比率）は原寸のまま中央に置かれる。
  // 縦の余り 675 は奇数なので上下に割り切れず、round で下側が1px厚い（337.5 → 338）。
  const small = containRect(540, 675, DST_W, DST_H);
  expect(small).toEqual({ x: 270, y: 338, w: 540, h: 675 });
});
