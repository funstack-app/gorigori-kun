/**
 * 「人 = 1レイヤー」まとめ操作の回帰テスト (gap-audit G2)。
 *
 * SCHP で人物が複数パーツに割れても、編集タブでは「人」を1つのまとまりとして
 * 選択・表示切替できる。この集約ロジック (personGroupSummary) が、fixture の
 * 分解契約から再構成したレイヤーメタに対して正しい「まとめ対象 id 列 / まとめ表示状態 /
 * 畳みサマリ名」を返すことを毎回検査する。ここが壊れると「人ぜんぶ選択」が静かに
 * 一部だけ掴む・畳みサマリが件数を偽る、という体験退行が起きる。
 */
import { expect, test } from "@playwright/test";

import { GENRE_LABELS, normalizeGenre } from "../src/lib/edit/genre";
import {
  layerMetasFromCanvas,
  personGroupSummary,
} from "../src/components/edit/editor/layerHelpers";
import type { EditorLayerMeta } from "../src/components/edit/editor/editorStore";
import { listFixtureNames, loadFixture } from "./helpers/fixtures";

/** fabric 互換の疑似レイヤーオブジェクト (genre.check.ts と同形)。 */
function fakeObject(props: Record<string, unknown>, type = "image") {
  const store: Record<string, unknown> = { ...props };
  return {
    type,
    visible: store.visible !== false,
    get: (key: string) => store[key],
    set: (values: Record<string, unknown>) => Object.assign(store, values),
  };
}

function fakeCanvas(objects: ReturnType<typeof fakeObject>[]) {
  return { getObjects: () => objects };
}

/** fixture の分解契約 → キャンバス反映後のレイヤーメタ列 (背景 → 物体 → テキストの層順)。 */
function metasFromFixture(name: string): EditorLayerMeta[] {
  const fixture = loadFixture(name);
  const objects: ReturnType<typeof fakeObject>[] = [];
  if (fixture.hasBackground) {
    objects.push(fakeObject({ id: "bg", name: "背景", layerKind: "image", genre: "background" }));
  }
  fixture.objects.forEach((object, index) => {
    const genre = normalizeGenre(object.category, object.en, object.ja);
    objects.push(
      fakeObject({ id: `obj-${index}`, name: object.ja, layerKind: "image", genre }),
    );
  });
  for (let i = 0; i < fixture.textLayerCount; i += 1) {
    objects.push(
      fakeObject({ id: `text-${i}`, name: `テキスト ${i + 1}`, layerKind: "text", genre: "text" }, "textbox"),
    );
  }
  return layerMetasFromCanvas(fakeCanvas(objects));
}

// ── fixture 契約駆動: 人グループの集約 ─────────────────────────

for (const name of listFixtureNames()) {
  test(`fixture ${name}: personGroupSummary が人ジャンル件数と一致する`, () => {
    const fixture = loadFixture(name);
    const metas = metasFromFixture(name);
    const summary = personGroupSummary(metas);
    const expectedPersons = fixture.expectedGenreCounts.person;
    if (expectedPersons === 0) {
      // 人が0件の画像では null (まとめ操作 UI 自体を出さない)。
      expect(summary, `${name}: 人0件は summary=null`).toBeNull();
      return;
    }
    expect(summary, `${name}: 人ありは summary あり`).not.toBeNull();
    // まとめ対象 id 列の件数 = 契約の人件数 (取りこぼし・水増しゼロ)。
    expect(summary?.count).toBe(expectedPersons);
    expect(summary?.ids.length).toBe(expectedPersons);
  });
}

// ── まとめ操作ロジックの単体検査 ─────────────────────────────

test("複数パーツの人は1つのまとまりとして id 列に集約される", () => {
  // SCHP 3パーツの人物を模した構成。
  const canvas = fakeCanvas([
    fakeObject({ id: "bg", name: "元画像", layerKind: "image", genre: "background" }),
    fakeObject({ id: "hair", name: "髪", layerKind: "image", genre: "person" }),
    fakeObject({ id: "top", name: "上衣", layerKind: "image", genre: "person" }),
    fakeObject({ id: "pants", name: "パンツ", layerKind: "image", genre: "person" }),
    fakeObject({ id: "ball", name: "ボール", layerKind: "image", genre: "prop" }),
  ]);
  const summary = personGroupSummary(layerMetasFromCanvas(canvas));
  expect(summary).not.toBeNull();
  expect(summary?.count).toBe(3);
  // id 列に人パーツだけが入る (背景・小物は混ざらない)。
  expect([...(summary?.ids ?? [])].sort()).toEqual(["hair", "pants", "top"]);
  // 全パーツ表示なので visibleState=all、畳みサマリは件数付き。
  expect(summary?.visibleState).toBe("all");
  expect(summary?.collapsedLabel).toBe(`${GENRE_LABELS.person} (3パーツ)`);
});

test("単一パーツの人は括弧なしのサマリ名になる", () => {
  const canvas = fakeCanvas([
    fakeObject({ id: "bg", name: "背景", layerKind: "image", genre: "background" }),
    fakeObject({ id: "fg", name: "人物", layerKind: "image", genre: "person" }),
  ]);
  const summary = personGroupSummary(layerMetasFromCanvas(canvas));
  expect(summary?.count).toBe(1);
  expect(summary?.collapsedLabel).toBe(GENRE_LABELS.person);
});

test("まとめ表示状態は表示件数で all / none / mixed を判定する", () => {
  const base = (visibles: boolean[]) =>
    fakeCanvas(
      visibles.map((visible, i) =>
        fakeObject({ id: `p${i}`, name: `パーツ${i}`, layerKind: "image", genre: "person", visible }),
      ),
    );
  expect(personGroupSummary(layerMetasFromCanvas(base([true, true])))?.visibleState).toBe("all");
  expect(personGroupSummary(layerMetasFromCanvas(base([false, false])))?.visibleState).toBe("none");
  expect(personGroupSummary(layerMetasFromCanvas(base([true, false])))?.visibleState).toBe("mixed");
});

test("人が0件なら summary は null (まとめ操作 UI を出さない)", () => {
  const canvas = fakeCanvas([
    fakeObject({ id: "bg", name: "背景", layerKind: "image", genre: "background" }),
    fakeObject({ id: "t", name: "テキスト", layerKind: "text", genre: "text" }, "textbox"),
    fakeObject({ id: "o", name: "小物", layerKind: "image", genre: "prop" }),
  ]);
  expect(personGroupSummary(layerMetasFromCanvas(canvas))).toBeNull();
});

test("allLocked は全パーツロック時のみ true", () => {
  const canvas = fakeCanvas([
    fakeObject({ id: "a", name: "髪", layerKind: "image", genre: "person", locked: true }),
    fakeObject({ id: "b", name: "服", layerKind: "image", genre: "person", locked: true }),
  ]);
  expect(personGroupSummary(layerMetasFromCanvas(canvas))?.allLocked).toBe(true);
  const mixed = fakeCanvas([
    fakeObject({ id: "a", name: "髪", layerKind: "image", genre: "person", locked: true }),
    fakeObject({ id: "b", name: "服", layerKind: "image", genre: "person", locked: false }),
  ]);
  expect(personGroupSummary(layerMetasFromCanvas(mixed))?.allLocked).toBe(false);
});
