/**
 * ジャンル分類 (人/テキスト/背景/小物) の回帰テスト。
 *
 * 駆動源は fixture の分解契約 (decomposition.json)。契約に書かれた expectedGenre と
 * 分類ロジック (normalizeGenre / classifyWord / groupLayersByGenre) の出力が一致する
 * ことを毎回検査する。分類器のキーワード変更・グループ化の退行はここで止まる。
 */
import { expect, test } from "@playwright/test";

import {
  classifyWord,
  GENRE_ORDER,
  groupLayersByGenre,
  normalizeGenre,
  type LayerGenre,
} from "../src/lib/edit/genre";
import { listFixtureNames, loadFixture } from "./helpers/fixtures";

// ── fixture 契約駆動の回帰 ──────────────────────────────────────

for (const name of listFixtureNames()) {
  test.describe(`fixture: ${name}`, () => {
    test("各物体が契約どおりの大ジャンルへ分類される", () => {
      const fixture = loadFixture(name);
      for (const object of fixture.objects) {
        const genre = normalizeGenre(object.category, object.en, object.ja);
        expect(genre, `${object.en} (${object.ja})`).toBe(object.expectedGenre);
        if (object.category === undefined) {
          // category 欠落時は決定論分類器そのものが契約を満たすこと (フォールバック検査)。
          expect(classifyWord(object.en, object.ja), `${object.en}: 分類器単体`).toBe(
            object.expectedGenre,
          );
        }
      }
    });

    test("分解結果全体がジャンルツリーへ取りこぼしなく入る", () => {
      const fixture = loadFixture(name);
      // 契約からキャンバス反映後のレイヤー列を再構成する (背景 → 物体 → テキストの層順)。
      const layers: Array<{ genre: LayerGenre }> = [];
      if (fixture.hasBackground) layers.push({ genre: "background" });
      for (const object of fixture.objects) {
        layers.push({ genre: normalizeGenre(object.category, object.en, object.ja) });
      }
      for (let i = 0; i < fixture.textLayerCount; i += 1) {
        layers.push({ genre: "text" });
      }

      const groups = groupLayersByGenre(layers);

      // 1. 取りこぼしゼロ: グループ合計 = レイヤー総数。
      const grouped = groups.reduce((sum, group) => sum + group.layers.length, 0);
      expect(grouped).toBe(layers.length);

      // 2. ジャンル別件数が契約と一致。
      for (const genre of GENRE_ORDER) {
        const count = groups.find((group) => group.genre === genre)?.layers.length ?? 0;
        expect(count, `${genre} の件数`).toBe(fixture.expectedGenreCounts[genre]);
      }

      // 3. 見出し順は GENRE_ORDER の部分列 (空ジャンルは出さない)。
      const order = groups.map((group) => group.genre);
      const expectedOrder = GENRE_ORDER.filter((genre) =>
        order.includes(genre),
      );
      expect(order).toEqual(expectedOrder);
    });
  });
}

// ── 分類器の境界ケース (実害の型を固定) ─────────────────────────

test("複合語の person 判定: 'person in black coat' は人", () => {
  expect(classifyWord("person in black coat", "黒コートの人物")).toBe("person");
});

test("1文字キーワードは完全一致のみ: 「人形」は人ではなく小物", () => {
  expect(classifyWord("wooden mannequin", "人形")).toBe("prop");
  expect(classifyWord("", "人")).toBe("person");
});

test("人型ロボット/キャラクターの境界: category 無しは prop、category=person なら人", () => {
  expect(classifyWord("robot", "ロボット")).toBe("prop");
  expect(normalizeGenre("person", "robot", "ロボット")).toBe("person");
});

test("壊れた category は決定論分類器へフォールバックする (未信頼入力の検証)", () => {
  expect(normalizeGenre("PERSON", "person", "人物")).toBe("person"); // 大文字は無効値扱い→分類器
  expect(normalizeGenre("unknown", "logo", "ロゴ")).toBe("text");
  expect(normalizeGenre(123, "basketball", "バスケットボール")).toBe("prop");
  expect(normalizeGenre(null, "sky", "空")).toBe("background");
  expect(normalizeGenre(undefined, "sneakers", "スニーカー")).toBe("prop");
});

test("groupLayersByGenre: 空入力は空ツリー、グループ内は入力順 (z順) を保存", () => {
  expect(groupLayersByGenre([])).toEqual([]);
  const layers = [
    { id: "bg", genre: "background" as const },
    { id: "p1", genre: "person" as const },
    { id: "t1", genre: "text" as const },
    { id: "p2", genre: "person" as const },
  ];
  const groups = groupLayersByGenre(layers);
  expect(groups.map((group) => group.genre)).toEqual(["person", "text", "background"]);
  expect(groups[0].layers.map((layer) => layer.id)).toEqual(["p1", "p2"]);
});
