/**
 * フォント近似候補 (gap-audit G3) の回帰テスト。
 *
 * 打ち替え後のフォントを「元書体に近い順」で提案する scoreFont / rankFonts / suggestFonts は
 * 決定論の純ロジック。ここが壊れると「近いフォント」が実は無関係な順に並ぶ・
 * 何も一致しないフォントを「近い」と偽って提示する、という体験退行が起きる。
 * 完全一致は狙わない設計なので、検査するのは「近さの順序」と「無関係を候補にしない」こと。
 */
import { expect, test } from "@playwright/test";

import {
  guessSerif,
  rankFonts,
  scoreFont,
  suggestFonts,
  type FontMatchHint,
} from "../src/lib/edit/fontMatch";
import type { FontInfo } from "../src/lib/edit/types";

const FONTS: FontInfo[] = [
  { family: "system-ui", displayName: "System Default", style: "Regular", languageTags: ["ja", "en"] },
  { family: "Noto Sans JP", displayName: "Noto Sans JP", style: "Regular", languageTags: ["ja"] },
  { family: "Noto Sans JP Bold", displayName: "Noto Sans JP Bold", style: "Bold", languageTags: ["ja"] },
  { family: "Noto Serif JP", displayName: "Noto Serif JP", style: "Regular", languageTags: ["ja"] },
  { family: "Hiragino Mincho", displayName: "ヒラギノ明朝", style: "Regular", languageTags: ["ja"] },
  { family: "Arial", displayName: "Arial", style: "Regular", languageTags: ["en"] },
  { family: "Arial Bold", displayName: "Arial Bold", style: "Bold", languageTags: ["en"] },
  { family: "Times New Roman", displayName: "Times New Roman", style: "Regular", languageTags: ["en"] },
];

test("guessSerif: 明朝/serif/Times は serif、gothic/sans/Arial は sans、判別不能は null", () => {
  expect(guessSerif({ family: "Noto Serif JP", displayName: "Noto Serif JP" })).toBe(true);
  expect(guessSerif({ family: "Hiragino Mincho", displayName: "ヒラギノ明朝" })).toBe(true);
  expect(guessSerif({ family: "Times New Roman", displayName: "Times New Roman" })).toBe(true);
  expect(guessSerif({ family: "Noto Sans JP", displayName: "Noto Sans JP" })).toBe(false);
  expect(guessSerif({ family: "Arial", displayName: "Arial" })).toBe(false);
  expect(guessSerif({ family: "Foo", displayName: "Foo" })).toBeNull();
});

test("scoreFont: 言語+太さ+セリフが全一致すると最高点、無関係は0点", () => {
  const hint: FontMatchHint = { language: "ja", bold: true, serif: false };
  // ja + Bold + sans(=serif:false) の3軸一致
  const perfect = FONTS.find((f) => f.family === "Noto Sans JP Bold")!;
  expect(scoreFont(perfect, hint)).toBe(100);
  // 英語Regular serif — 何も一致しない
  const none = FONTS.find((f) => f.family === "Times New Roman")!;
  expect(scoreFont(none, hint)).toBe(0);
});

test("rankFonts: 日本語・太字・ゴシックのヒントで Noto Sans JP Bold が先頭、system-ui は除外", () => {
  const hint: FontMatchHint = { language: "ja", bold: true, serif: false };
  const ranked = rankFonts(FONTS, hint);
  expect(ranked.some((f) => f.family === "system-ui")).toBe(false);
  expect(ranked[0].family).toBe("Noto Sans JP Bold");
  // スコアは単調非増加（近い順に並んでいる）
  const scores = ranked.map((f) => scoreFont(f, hint));
  for (let i = 1; i < scores.length; i++) {
    expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
  }
});

test("suggestFonts: スコア0の無関係フォントは候補に含めない（近いと偽らない）", () => {
  // 日本語ヒント → 英語専用フォントは languageTags に ja を持たず、bold/serif も指定なしなら0点
  const hint: FontMatchHint = { language: "ja" };
  const suggestions = suggestFonts(FONTS, hint, 5);
  // 提案は全て ja を含む（スコア>0の条件）
  expect(suggestions.length).toBeGreaterThan(0);
  for (const f of suggestions) {
    expect(f.languageTags).toContain("ja");
    expect(scoreFont(f, hint)).toBeGreaterThan(0);
  }
  // 英語専用フォントは1つも入らない
  expect(suggestions.some((f) => f.family === "Arial")).toBe(false);
});

test("suggestFonts: limit を尊重する", () => {
  const hint: FontMatchHint = { language: "ja", bold: false, serif: true };
  expect(suggestFonts(FONTS, hint, 2).length).toBeLessThanOrEqual(2);
});

test("決定論: 同じ入力で同じ順序（純関数・入力非破壊）", () => {
  const hint: FontMatchHint = { language: "en", bold: true, serif: false };
  const original = [...FONTS];
  const a = rankFonts(FONTS, hint).map((f) => f.family);
  const b = rankFonts(FONTS, hint).map((f) => f.family);
  expect(a).toEqual(b);
  // 入力配列を壊していない
  expect(FONTS).toEqual(original);
});
