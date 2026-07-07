/**
 * レイヤーメタ変換 (layerHelpers) とジャンルツリーの統合回帰テスト。
 *
 * fabric 実体は使わず、fabric 互換の get/set を持つ疑似オブジェクトで
 * layerMetasFromCanvas → groupLayersByGenre の変換全体を検査する
 * (編集タブがレイヤー一覧を作るのと同じ経路)。
 */
import { expect, test } from "@playwright/test";

import { GENRE_LABELS, groupLayersByGenre } from "../src/lib/edit/genre";
import {
  layerMetasFromCanvas,
  objectGenre,
} from "../src/components/edit/editor/layerHelpers";
import { HISTORY_PROPERTIES } from "../src/components/edit/editor/history";

/** fabric 互換の疑似レイヤーオブジェクト。 */
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

test("objectGenre: 明示 genre > 構造フォールバックの優先順", () => {
  // 1. 明示 genre が最優先。
  expect(objectGenre(fakeObject({ id: "x", genre: "person" }))).toBe("person");
  // 2. textbox は text (旧レイヤーに genre が無くても)。
  expect(objectGenre(fakeObject({ id: "t" }, "textbox"))).toBe("text");
  // 3. 元画素そのままのテキスト素材 (textSpec 持ちの画像レイヤー) も text。
  expect(objectGenre(fakeObject({ id: "ti", textSpec: { text: "SALE" } }))).toBe("text");
  // 4. id "bg" は background。
  expect(objectGenre(fakeObject({ id: "bg" }))).toBe("background");
  // 5. 残りは prop (必ずどこかの見出しに入る = 迷子レイヤーを作らない)。
  expect(objectGenre(fakeObject({ id: "obj-1" }))).toBe("prop");
});

test("layerMetasFromCanvas → groupLayersByGenre で4ジャンルのツリーができる", () => {
  const canvas = fakeCanvas([
    fakeObject({ id: "bg", name: "背景", layerKind: "image", genre: "background" }),
    fakeObject({ id: "p1", name: "人物", layerKind: "image", genre: "person" }),
    fakeObject({ id: "o1", name: "バスケットボール", layerKind: "image", genre: "prop" }),
    fakeObject({ id: "t1", name: "テキスト 1", layerKind: "text", genre: "text" }, "textbox"),
  ]);

  const metas = layerMetasFromCanvas(canvas);
  // 一覧は前面 → 背面 (reverse) の順。
  expect(metas.map((meta) => meta.id)).toEqual(["t1", "o1", "p1", "bg"]);
  expect(metas.map((meta) => meta.genre)).toEqual(["text", "prop", "person", "background"]);

  const groups = groupLayersByGenre(metas);
  expect(groups.map((group) => group.genre)).toEqual(["person", "text", "prop", "background"]);
  expect(groups.map((group) => group.label)).toEqual([
    GENRE_LABELS.person,
    GENRE_LABELS.text,
    GENRE_LABELS.prop,
    GENRE_LABELS.background,
  ]);
  // ツリー化してもレイヤーは1件も消えない。
  const total = groups.reduce((sum, group) => sum + group.layers.length, 0);
  expect(total).toBe(metas.length);
});

test("genre 無しの旧レイヤー混在でも全レイヤーがどこかの見出しに入る", () => {
  const canvas = fakeCanvas([
    fakeObject({ id: "bg", name: "背景", layerKind: "image" }), // 旧: genre 無し
    fakeObject({ id: "legacy-1", name: "物体 1", layerKind: "image" }),
    fakeObject({ id: "legacy-t", name: "テキスト", layerKind: "text" }, "textbox"),
  ]);
  const metas = layerMetasFromCanvas(canvas);
  const groups = groupLayersByGenre(metas);
  const total = groups.reduce((sum, group) => sum + group.layers.length, 0);
  expect(total).toBe(3);
  expect(groups.map((group) => group.genre)).toEqual(["text", "prop", "background"]);
});

test("undo/redo 履歴がジャンルとテキスト編集メタデータを保存する (HISTORY_PROPERTIES)", () => {
  // genre: ツリー見出しが undo で崩れない / textSpec: ダブルクリック打ち替えが undo 後も可能 /
  // sourcePath+sourceBbox: AI差し替えが undo 後も可能。
  // 2026-07-07 修理の回帰ガード: これらが列挙から落ちると undo 1回で編集能力が静かに消える。
  for (const required of ["id", "name", "layerKind", "genre", "textSpec", "sourcePath", "sourceBbox", "locked"]) {
    expect(HISTORY_PROPERTIES, `HISTORY_PROPERTIES に ${required}`).toContain(required);
  }
});
