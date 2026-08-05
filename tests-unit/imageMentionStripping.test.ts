/**
 * B2: 画像生成で `@imgN` メンションが除去されず素通りしていたバグの検査。
 *
 * ## この検査が守っているもの
 *
 * `@imgN` は「参照ラックの N 枚目を指す」UI 記法であって、**モデルへ送る文字ではない**。
 * ところが除去は動画側 (useVideoSceneGeneration) にしか入っておらず、同じ記法が
 * 経路によって挙動が違っていた:
 *
 *   動画生成: 「@img1 の服装で」 → 「の服装で」   （正しい）
 *   画像生成: 「@img1 の服装で」 → 「@img1 の服装で」（そのままモデルへ）
 *
 * ここで見るのは2つ:
 *   1. 除去そのもの（`@imgN` が本文に残らない）
 *   2. **両経路が同じ関数・同じ引数で解決していること**。片側だけ直すと同じ
 *      「経路で挙動が違う」バグに戻るため、ソース上の結線を検査で固定する。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveImageMentions } from "../src/lib/scene/resolveImageMentions";

const REFS = [
  { path: "/tmp/gori/a.png", name: "a.png" },
  { path: "/tmp/gori/b.png", name: "b.png" },
];

/** vitest の root はリポジトリルート (vitest.config.ts と同階層)。 */
function readSrc(relative: string): string {
  return readFileSync(resolve(process.cwd(), "src", relative), "utf8");
}

describe("@imgN の除去（画像・動画で共通の契約）", () => {
  it("本文から @imgN を取り除く", () => {
    const r = resolveImageMentions("@img1 の服装で", REFS);
    expect(r.cleanedPrompt).toBe("の服装で");
    // 除去漏れの直接検査。ここが本命の退行ポイント。
    expect(r.cleanedPrompt).not.toContain("@img");
  });

  it("メンションされた参照画像を登場順で選ぶ", () => {
    const r = resolveImageMentions("@img2 の背景に @img1 を置く", REFS);
    expect(r.mentioned.map((m) => m.path)).toEqual([
      "/tmp/gori/b.png",
      "/tmp/gori/a.png",
    ]);
  });

  it("メンションが無ければ mentioned は空（呼び出し側は参照ラック全部にフォールバック）", () => {
    const r = resolveImageMentions("笑顔で走る", REFS);
    expect(r.mentioned).toEqual([]);
    expect(r.cleanedPrompt).toBe("笑顔で走る");
  });

  it("範囲外の番号は無視する（存在しない画像を渡さない）", () => {
    const r = resolveImageMentions("@img9 で", REFS);
    expect(r.mentioned).toEqual([]);
    expect(r.cleanedPrompt).not.toContain("@img9");
  });
});

describe("画像経路と動画経路が同じ解決を通ること（結線の検査）", () => {
  const imageSrc = readSrc("lib/scene/useSceneGeneration.ts");
  const videoSrc = readSrc("lib/scene/useVideoSceneGeneration.ts");

  it("画像側が resolveImageMentions を import して使っている", () => {
    expect(imageSrc).toContain('from "./resolveImageMentions"');
    expect(imageSrc).toContain("resolveImageMentions(");
  });

  it("動画側の既存挙動が維持されている（片側だけ直して分岐させない）", () => {
    expect(videoSrc).toContain('from "./resolveImageMentions"');
    expect(videoSrc).toContain("resolveImageMentions(");
  });

  it("画像側がモデルへ渡すのは cleanedPrompt であって生の effectivePrompt ではない", () => {
    // 旧実装は `const prompt = effectivePrompt.trim();` で @imgN ごと送っていた。
    expect(imageSrc).not.toMatch(/const prompt = effectivePrompt\.trim\(\)/);
    expect(imageSrc).toMatch(/const prompt = mentionResult\.cleanedPrompt\.trim\(\)/);
  });

  it("両経路とも「メンションがあればそれ、無ければ従来フォールバック」で参照を選ぶ", () => {
    for (const src of [imageSrc, videoSrc]) {
      expect(src).toMatch(/mentionResult\.mentioned\.length > 0/);
    }
  });
});
