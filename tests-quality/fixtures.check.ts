/**
 * fixture 整合性の回帰テスト (品質回帰ハーネスの土台)。
 *
 * 目的: 固定画像6枚 + 分解契約が「揃っていて・壊れていない・自己矛盾していない」
 * ことを機械検査する。ここが緑でないと、ジャンル分類・ツリー構造の回帰テストは
 * 駆動源を失う (silent skip を許さない)。
 *
 * 命名 (*.check.ts): *.spec.ts は評価基準保護のため AI から編集不可 (vault deny)。
 * このハーネスは AI が育てる回帰資産なので check 接尾辞で分離した。
 */
import { expect, test } from "@playwright/test";

import {
  EXPECTED_FIXTURE_COUNT,
  listFixtureNames,
  loadFixture,
  PNG_SIGNATURE,
  readFixtureImage,
  type LayerGenreName,
} from "./helpers/fixtures";

const GENRES: LayerGenreName[] = ["person", "text", "background", "prop"];

test("fixture セットは7枚固定 (gap-audit §4 + g の契約)", () => {
  const names = listFixtureNames();
  expect(names).toHaveLength(EXPECTED_FIXTURE_COUNT);
  // 名前は a- 〜 g- の DoD ケース接頭辞を持つ (増減・入れ替えは契約変更として顕在化させる)。
  for (const prefix of ["a-", "b-", "c-", "d-", "e-", "f-", "g-"]) {
    expect(names.some((name) => name.startsWith(prefix)), `${prefix}* fixture が存在する`).toBe(
      true,
    );
  }
});

for (const name of listFixtureNames()) {
  test.describe(`fixture: ${name}`, () => {
    test("固定画像が存在し PNG として壊れていない", () => {
      const fixture = loadFixture(name);
      const image = readFixtureImage(name, fixture.image.file);
      expect(image.length).toBeGreaterThan(0);
      expect(image.subarray(0, 8).equals(PNG_SIGNATURE), "PNG シグネチャ一致").toBe(true);
    });

    test("分解契約 (decomposition.json) がスキーマを満たす", () => {
      const fixture = loadFixture(name);
      expect(fixture.fixture).toBe(name);
      expect(fixture.kind).toBe("recorded-contract");
      expect(typeof fixture.dodCase).toBe("string");
      expect(typeof fixture.source).toBe("string");
      expect(Array.isArray(fixture.objects)).toBe(true);
      expect(Number.isInteger(fixture.textLayerCount)).toBe(true);
      expect(fixture.textLayerCount).toBeGreaterThanOrEqual(0);
      expect(typeof fixture.hasBackground).toBe("boolean");
      for (const object of fixture.objects) {
        expect(object.en.trim().length, `${object.en}: en が空でない`).toBeGreaterThan(0);
        expect(object.ja.trim().length, `${object.ja}: ja が空でない`).toBeGreaterThan(0);
        expect(GENRES, `${object.en}: expectedGenre が4ジャンルのいずれか`).toContain(
          object.expectedGenre,
        );
        if (object.category !== undefined) {
          expect(GENRES, `${object.en}: category が4ジャンルのいずれか`).toContain(
            object.category,
          );
        }
      }
      for (const genre of GENRES) {
        expect(
          Number.isInteger(fixture.expectedGenreCounts[genre]),
          `expectedGenreCounts.${genre} が整数`,
        ).toBe(true);
      }
    });

    test("契約が自己矛盾していない (件数の整合条件)", () => {
      const fixture = loadFixture(name);
      // レイヤー総数 = 物体 + テキスト + 背景(0/1)。実行時点の値ではなく契約内の整合条件で検査する。
      const totalLayers =
        fixture.objects.length + fixture.textLayerCount + (fixture.hasBackground ? 1 : 0);
      const countSum = GENRES.reduce(
        (sum, genre) => sum + fixture.expectedGenreCounts[genre],
        0,
      );
      expect(countSum, "ジャンル別件数の合計 = レイヤー総数 (取りこぼしゼロ)").toBe(totalLayers);
      // 背景件数は hasBackground と一致する。
      expect(fixture.expectedGenreCounts.background).toBe(fixture.hasBackground ? 1 : 0);
      // テキスト件数は textLayerCount 以上 (text カテゴリの物体 (ロゴ等) が加算されうる)。
      expect(fixture.expectedGenreCounts.text).toBeGreaterThanOrEqual(fixture.textLayerCount);
    });
  });
}
