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

  /**
   * ## 2026-08-05 I2 で構造が変わった（この検査を張り直した理由）
   *
   * 旧構造では `cutOut` の中に「1画素も抜けなかった」「抜き自体が失敗した」の
   * 2つの分岐があり、その**両方**に `setNotClearedPaths` があることを数で固定していた。
   *
   * AI抜き既定化（J4）で分岐は `cutout.ts` の `cutOutBackground` へ移り、
   * `cutOut` が受け取るのは判定済みの `notCleared`（真偽1つ）になった。
   * よって `setNotClearedPaths` の呼び出しは**1箇所で正しい**。
   *
   * 数を数える検査をそのまま残すと、正しい実装で落ち続ける。守るべきものは
   * 「呼び出しが2つあること」ではなく「**抜けなかった事実が黙って捨てられないこと**」
   * なので、そちらを固定し直す。
   */
  it("cutOut が「抜けなかった」を漏れなく可視化している", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const cutAt = src.indexOf("const cutOut = useCallback");
    expect(cutAt, "cutOut が見つからない").toBeGreaterThan(-1);
    const body = src.slice(cutAt, src.indexOf("// ── イベント購読", cutAt));

    // 判定済みの `notCleared` を見て可視化していること。
    expect(body, "抜けなかった事実を画面へ出していない（R5 の再発）").toContain(
      "setNotClearedPaths(",
    );
    expect(
      body,
      "notCleared を見ずに可視化している（判定を2箇所に持つと食い違う）",
    ).toContain("outcome.notCleared");
  });

  /**
   * 分岐の網羅は、移った先（`cutout.ts`）で固定する。
   * ここを空けたままにすると「どこにも検査が無い」状態になる（R5 の穴が開く）。
   */
  it("cutOutBackground が3経路すべてで抜けなかったことを判定している", async () => {
    const src = await readSrc("src/lib/sticker/cutout.ts");
    // (1) AI成功 = false / (2) クロマキー cleared===0 / (3) 全滅
    expect(src, "AI成功で notCleared を立てている（抜けているのに警告が出る）").toContain(
      'method: "ai", chroma: null, notCleared: false',
    );
    expect(src, "クロマキーの cleared===0 を判定していない").toContain(
      "notCleared: res.cleared === 0",
    );
    expect(src, "全経路失敗のとき黙って進んでいる（R5 の再発）").toContain(
      'method: "none", chroma: null, notCleared: true',
    );
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
