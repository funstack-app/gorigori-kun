/**
 * R5: クロマキーが抜けなかったことを画面に出す（救済 + 可視化）。
 *
 * ## この検査が守っているもの
 *
 * `cutOut` は抜きに失敗しても・1画素も抜けなくても元画像を返して先へ進める。
 * 救済としては正しいが、**画面に何も出ていなかった**。
 * 設計原則 第5条は「失敗させるより、救済して可視化する」であり、
 * 可視化が無いと半分しか満たさない（ユーザーは緑のままの1枚に気づけない）。
 *
 * ## なぜソースを読む方式か
 *
 * ここは React の描画分岐なので、部品を単体で呼んでも「一等地にボタンを増やして
 * いないか」「既存のバッジ表現に揃っているか」は確かめられない。
 * `spec_ts_sync` / A1 の順序検査と同じく、実ソースを読んで固定する。
 */
import { describe, expect, it } from "vitest";

async function readSrc(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return readFile(resolve(process.cwd(), relative), "utf8");
}

describe("R5: 抜けなかったことが採否一覧に出る", () => {
  it("Workspace が「抜けなかった」画像を状態として持っている", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    expect(src, "抜けなかった画像を記録していない（R5 の再発）").toContain(
      "notClearedPaths",
    );
    expect(src, "採否一覧へ渡していない").toContain("notClearedPaths={notClearedPaths}");
  });

  it("cutOut が cleared === 0 と失敗の両方で記録している", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const cutAt = src.indexOf("const cutOut = useCallback");
    const body = src.slice(cutAt, src.indexOf("// ── イベント購読", cutAt));
    // 抜けなかった場合と、抜き自体が失敗した場合の2経路。どちらも救済して可視化する。
    const marks = body.split("setNotClearedPaths(").length - 1;
    expect(
      marks,
      "抜けなかった経路のどれかが黙って進んでいる（R5 の再発）",
    ).toBeGreaterThanOrEqual(2);
  });

  it("採否一覧がバッジを出す（新しいボタンは足さない）", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerPickPanel.tsx");
    expect(src, "バッジの表示が無い（R5 の再発）").toContain("背景が抜けていません");

    // 一等地にボタンを増やさない（配置文法）。この画面の button は
    // 既存の「全部使う / 作り直す / 使う / 直す」の4種類のまま。
    const buttons = src.split("<button").length - 1;
    expect(buttons, `button が増えている（${buttons} 個）`).toBe(4);
  });

  it("バッジは既存の番号バッジと同じ表現に揃っている", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerPickPanel.tsx");
    const at = src.indexOf("背景が抜けていません");
    const around = src.slice(Math.max(0, at - 400), at);
    // 既存の番号バッジ（absolute + bg-black/70 + text-[10px]）と同じ形。
    expect(around).toContain("absolute right-1 top-1");
    expect(around).toContain("bg-black/70");
    // 注意表示は他と同じ amber 系（赤にしない = ブロッカーではないため）。
    expect(around).toContain("text-amber-300");
  });
});
