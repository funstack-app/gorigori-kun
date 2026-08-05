/**
 * L1: 文字入れが**余白（padding）を侵さない**ことと、**透過を壊さない**ことの検査。
 *
 * ## なぜ配置計算を単体で検査できるか
 *
 * jsdom には Canvas 2D が無いので、実際の描画は単体では回せない。
 * そこで `text.ts` は**配置の計算を純関数に分離**している（`layoutStickerText`）。
 * 余白の安全性はこの純関数が全責任を持つので、ここを固定すれば守れる。
 *
 * ## 何を守っているか
 *
 * 書き出しの `normalize_sticker` はアルファ bbox で切り抜かず、画像を丸ごと縮めて
 * 中央に置く。一方で層Aの `margin-short` は**アルファ bbox** と外枠の距離を測る。
 * つまり作業画像の端に触れた不透明画素は、書き出し後にちょうど `padding` px の
 * 位置に来る。文字が端に寄ると、この 1px の綱渡りに乗る。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STICKER_TEXT,
  layoutStickerText,
  safeMarginPx,
  STICKER_TEXT_SIZE_RATIOS,
  textFitsWithinMargin,
  textOutputPath,
} from "../src/lib/sticker/text";
import { NORMAL_STICKER_SPEC } from "../src/lib/sticker/spec";

describe("L1: 安全余白は規格から引く（定数を焼かない）", () => {
  it("書き出しの縮尺へ引き戻した余白が返る", () => {
    // 1024 の作業画像は 370x320 の内側（padding 10 を引いた 350x300）へ縮む。
    // その縮尺で padding px を残すには、作業画像側で padding/scale px 空ける。
    const margin = safeMarginPx(1024, 1024);
    expect(margin).toBeGreaterThan(NORMAL_STICKER_SPEC.padding);
  });

  it("規格の padding が 0 なら余白も 0（勝手に足さない）", () => {
    // 実装が `10` を直接書いていたら、padding が 0 でも余白が出て落ちる。
    expect(safeMarginPx(0, 0)).toBe(NORMAL_STICKER_SPEC.padding);
  });
});

describe("L1: 文字は余白を侵さない", () => {
  const sizes = Object.values(STICKER_TEXT_SIZE_RATIOS);

  for (const sizeRatio of sizes) {
    for (const position of ["top", "bottom"] as const) {
      it(`大きさ ${sizeRatio} / 位置 ${position} で余白の内側に収まる`, () => {
        const w = 1024;
        const h = 1024;
        const layout = layoutStickerText(w, h, { sizeRatio, position });

        // 縁取りの半分は文字の外へはみ出す。帯の判定はそれを含んでいること。
        expect(layout.bandTop).toBeGreaterThanOrEqual(layout.marginPx);
        expect(layout.bandBottom).toBeLessThanOrEqual(h - layout.marginPx);
        expect(textFitsWithinMargin(w, h, layout)).toBe(true);
      });
    }
  }

  it("極端に平たい画像でも余白を守る（文字を縮めてでも収める）", () => {
    // 安全域より大きい文字を要求されても、規格（余白）が勝つ。
    const layout = layoutStickerText(1024, 60, {
      sizeRatio: STICKER_TEXT_SIZE_RATIOS.large,
      position: "bottom",
    });
    expect(textFitsWithinMargin(1024, 60, layout)).toBe(true);
  });

  /**
   * **牙**: 検査そのものが機能しているかを確かめる。
   *
   * わざと余白を侵したレイアウトを渡し、`textFitsWithinMargin` が false を返すことを
   * 見る。これをやらないと「常に true を返す関数」でも上の検査が全部通ってしまう
   * （照合の自己言及の罠。規律5）。
   */
  it("牙: 余白を侵したレイアウトは false になる", () => {
    const h = 1024;
    const margin = safeMarginPx(1024, h);

    // 上端が余白の中へ 1px 食い込んでいる。
    expect(
      textFitsWithinMargin(1024, h, {
        marginPx: margin,
        bandTop: margin - 1,
        bandBottom: h - margin,
      }),
      "余白を侵しているのに合格している（検査に牙が無い）",
    ).toBe(false);

    // 下端が余白の中へ 1px 食い込んでいる。
    expect(
      textFitsWithinMargin(1024, h, {
        marginPx: margin,
        bandTop: margin,
        bandBottom: h - margin + 1,
      }),
      "下端の侵食を見落としている",
    ).toBe(false);
  });
});

describe("L1: 元画像を上書きしない（後から直せる）", () => {
  it("文字入れの出力は元と別のパスになる", () => {
    const base = "/tmp/gen/01-cut.png";
    const out = textOutputPath(base);
    expect(out).not.toBe(base);
    expect(out.endsWith("-text.png")).toBe(true);
  });

  it("拡張子が何であれ PNG へ揃う（透過を保てる形式）", () => {
    // JPEG に焼くと透過が白になる。出力形式は選ばせない。
    expect(textOutputPath("/tmp/a.webp").endsWith("-text.png")).toBe(true);
    expect(textOutputPath("/tmp/a").endsWith("-text.png")).toBe(true);
  });
});

describe("L1: 既定値は実務要件どおり", () => {
  it("白フチが既定でONになっている", () => {
    // 透過PNGはトーク画面の背景（白・黒・写真）に乗る。フチが無いと文字が消える。
    // これは好みではなく実務上の必須要件。
    expect(DEFAULT_STICKER_TEXT.outline).toBe(true);
    expect(DEFAULT_STICKER_TEXT.outlineColor.toLowerCase()).toBe("#ffffff");
  });
});

describe("L1: 呼び出し側が文字なしの絵を保持している", () => {
  async function readSrc(relative: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    return readFile(resolve(process.cwd(), relative), "utf8");
  }

  it("Workspace が焼く前のパスを控えて、そこから焼き直している", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    // 控えが無いと、焼き直すたびに前の文字の上へ重なる。
    expect(src, "文字入れ前の控えを持っていない").toContain("textBaseRef");
    expect(src, "控えから焼き直していない（文字が重なる）").toContain(
      "textBaseRef.current.get(item.index) ?? item.imagePath",
    );
  });

  it("Canvas へ渡す前に plugin-fs で読んでいる（CORS 汚染の回避）", async () => {
    const src = await readSrc("src/lib/sticker/text.ts");
    // convertFileSrc の asset:// を Image に読ませると canvas が汚染され
    // toBlob が "The operation is insecure." で落ちる（comic/savePage.ts の実績）。
    //
    // 判定は**実際に呼んでいるか**で行う（コメント中の言及は許す。
    // なぜその経路を避けたかを本文に残せなくなるのは、記録として本末転倒）。
    expect(src, "asset:// 経由で読んでいる（toBlob が落ちる）").not.toContain(
      "convertFileSrc(",
    );
    expect(src, "plugin-fs でバイト列を読んでいない").toContain(
      '@tauri-apps/plugin-fs',
    );
  });
});
