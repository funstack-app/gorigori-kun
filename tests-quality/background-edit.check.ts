/**
 * 背景ジャンル編集 (gap-audit G4) の回帰テスト。
 *
 * 背景レイヤーだけに「ぼかし/明るさ/AI再生成」を出す判定 (isBackgroundLayer / backgroundActions)
 * が決定論であることを検査する。ここが壊れると、背景でないレイヤーに背景操作が出る・
 * sourcePath が無いのに「AI再生成」ボタンが出て押しても何も起きない（張りぼて）、が起きる。
 */
import { expect, test } from "@playwright/test";

import { backgroundActions, isBackgroundLayer } from "../src/lib/edit/backgroundEdit";
import type { FabricLikeObject } from "../src/components/edit/editor/layerHelpers";

/** genre と任意プロパティを持つ疑似 fabric オブジェクト。 */
function fakeObject(props: Record<string, unknown>): FabricLikeObject {
  return {
    get: (key: string) => props[key],
  } as unknown as FabricLikeObject;
}

test("isBackgroundLayer: genre==='background' のみ true", () => {
  expect(isBackgroundLayer(fakeObject({ genre: "background" }))).toBe(true);
  expect(isBackgroundLayer(fakeObject({ genre: "person" }))).toBe(false);
  expect(isBackgroundLayer(fakeObject({ genre: "text" }))).toBe(false);
  expect(isBackgroundLayer(fakeObject({ genre: "prop" }))).toBe(false);
});

test("isBackgroundLayer: 構造フォールバック — id='bg' は背景扱い", () => {
  // genre 未付与でも id="bg" なら objectGenre が background を返す（layerHelpers の仕様）
  expect(isBackgroundLayer(fakeObject({ id: "bg" }))).toBe(true);
  expect(isBackgroundLayer(fakeObject({ id: "layer-1" }))).toBe(false);
});

test("backgroundActions: 常に ぼかし+明るさ を含む", () => {
  const actions = backgroundActions(fakeObject({ genre: "background" }));
  const kinds = actions.map((a) => a.kind);
  expect(kinds).toContain("blur");
  expect(kinds).toContain("brightness");
});

test("backgroundActions: sourcePath があるときだけ AI再生成 を含める（張りぼて防止）", () => {
  const withSource = backgroundActions(fakeObject({ genre: "background", sourcePath: "/tmp/bg.png" }));
  expect(withSource.some((a) => a.kind === "ai-regenerate")).toBe(true);

  const withoutSource = backgroundActions(fakeObject({ genre: "background" }));
  expect(withoutSource.some((a) => a.kind === "ai-regenerate")).toBe(false);
});

test("backgroundActions: AI再生成は inpaint 経路を要求する（既存経路流用の明示）", () => {
  const actions = backgroundActions(fakeObject({ genre: "background", sourcePath: "/tmp/bg.png" }));
  const ai = actions.find((a) => a.kind === "ai-regenerate");
  expect(ai).toBeDefined();
  expect(ai && "requires" in ai ? ai.requires : null).toBe("inpaint");
});
