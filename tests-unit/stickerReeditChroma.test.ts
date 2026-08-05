/**
 * A1: 個別再生成の結果が**合成の前にクロマキーを通る**ことの検査。
 *
 * ## この検査が守っているもの
 *
 * `buildStickerReeditPrompt` はAIに**緑背景を要求している**。一方、共有層の
 * マスク合成が守るのは「マスクの外が1画素も変わっていないか」だけで、
 * **マスクの内側は生成物をそのまま採る**。抜きを挟まないと塗った範囲に緑が残る。
 *
 * これは層Aの `no-alpha` では拾えない（画像の他の部分は既に透過済みなので
 * 「透明画素が1つでもあるか」は真になる）。抜き直す以外に閉じ方が無い。
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildStickerReeditPrompt,
  chromaKeyBeforeComposite,
} from "../src/lib/sticker/reedit";

describe("A1: 前提 — 個別再生成はAIに緑背景を要求している", () => {
  it("プロンプトにクロマキー背景の指示が入っている", () => {
    // この前提が崩れたら（緑を要求しなくなったら）この検査全体の意味が変わる。
    // 前提の変化に気づけるよう、ここで固定しておく。
    const prompt = buildStickerReeditPrompt("指を5本にする");
    expect(prompt.toLowerCase()).toContain("green");
  });
});

/** `sticker_chroma_key` の戻りの形（テスト用の最小構成）。 */
function chromaResult(overrides: Record<string, unknown> = {}) {
  return {
    output: "/tmp/gen-cut.png",
    cleared: 4000,
    semiTransparent: 40,
    opaque: 100,
    despilled: 12,
    fringeWarn: false,
    ...overrides,
  };
}

describe("A1: 合成の前にクロマキーを通す", () => {
  it("クロマキーを実際に呼ぶ（呼ばない実装なら落ちる）", async () => {
    const chromaKey = vi.fn().mockResolvedValue(chromaResult());

    const out = await chromaKeyBeforeComposite("/tmp/gen.png", chromaKey);

    expect(chromaKey).toHaveBeenCalledTimes(1);
    expect(chromaKey).toHaveBeenCalledWith("/tmp/gen.png");
    // 合成へ渡るのは**抜いた後**のパス。ここが元パスのままなら緑が合成される。
    expect(out.path).toBe("/tmp/gen-cut.png");
    expect(out.path).not.toBe("/tmp/gen.png");
  });

  it("1画素も抜けなければ元のパスで先へ進める（止めない）", async () => {
    // `cleared === 0` は「緑背景が無かった」という事実であって失敗ではない。
    // ここで throw すると、AIが既に透過された絵を返したときに採用できなくなる。
    const chromaKey = vi.fn().mockResolvedValue(chromaResult({ cleared: 0 }));

    const out = await chromaKeyBeforeComposite("/tmp/gen.png", chromaKey);

    expect(out.path).toBe("/tmp/gen.png");
  });

  it("抜きが失敗したら例外を伝える（黙って緑のまま合成しない）", async () => {
    const chromaKey = vi.fn().mockRejectedValue(new Error("画像を読み込めません"));
    await expect(chromaKeyBeforeComposite("/tmp/gen.png", chromaKey)).rejects.toThrow(
      /読み込めません/,
    );
  });
});

describe("A1: 呼び出し側（StickerReeditModal）の順序", () => {
  it("モーダルが chromaKeyBeforeComposite を合成より前で呼んでいる", async () => {
    // 実コードの**順序**を守る検査。関数を用意しても、呼ぶ場所が合成の後なら意味がない。
    // 実ソースを読んで前後関係を確かめる（`spec_ts_sync` と同じ、自己言及を避ける方式）。
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    // vitest では import.meta.url が file: とは限らないため、cwd（リポジトリ root）から解決する。
    const src = await readFile(
      resolve(process.cwd(), "src/components/skills/sticker/StickerReeditModal.tsx"),
      "utf8",
    );

    // 2026-08-05 I2: 呼び出し側の抜きは `cutOutBeforeComposite`（既定=AI / 保険=クロマキー）
    // へ変わった。**守る不変条件は変わらない** — 抜きが合成より前にあること。
    const chromaAt = src.indexOf("cutOutBeforeComposite(");
    const compositeAt = src.indexOf("compositePanelImages(");

    expect(chromaAt, "cutOutBeforeComposite が呼ばれていない（A1 の再発）").toBeGreaterThan(
      -1,
    );
    expect(compositeAt, "compositePanelImages が呼ばれていない").toBeGreaterThan(-1);
    expect(
      chromaAt,
      "抜きが合成より後に呼ばれている。マスク内の緑が合成されてしまう（A1 の再発）",
    ).toBeLessThan(compositeAt);

    // 合成に渡すのが「抜いた後のパス」であること。抜いてから生成物パスを渡すと
    // 呼び順だけ正しくて中身が素通りになる（順序チェックだけでは拾えない穴）。
    expect(
      src,
      "合成に生成物パスを直接渡している（抜いた結果が使われていない）",
    ).toContain("compositePanelImages(item.imagePath, cutPath, mask.raster)");
  });
});

/**
 * R2: 抜きの統計を捨てない。
 *
 * 旧実装は戻りが `string` だけで、統計がここで消えていた。その結果
 * `adoptReedit` は統計を登録できず（`delete` するだけ）、個別再生成で
 * 差し替えた1枚だけが層Aの縁の検査・`chroma-not-cleared` 判定から外れていた。
 */
describe("R2: 抜きの統計を呼び出し側へ返す", () => {
  it("抜けたときは統計をそのまま返す", async () => {
    const chromaKey = vi.fn().mockResolvedValue(
      chromaResult({
        cleared: 4000,
        semiTransparent: 55,
        opaque: 900,
        despilled: 7,
        fringeWarn: true,
      }),
    );

    const out = await chromaKeyBeforeComposite("/tmp/gen.png", chromaKey);

    expect(out).toEqual({
      path: "/tmp/gen-cut.png",
      cleared: 4000,
      semiTransparent: 55,
      opaque: 900,
      despilled: 7,
      fringeWarn: true,
    });
  });

  it("**1画素も抜けなくても統計を返す**（救済しつつ事実は残す）", async () => {
    // ここが R2 の本体。`cleared === 0` で統計まで捨てると、
    // 「緑が抜けなかった」という事実が層Aへ届かず、緑のままの1枚が
    // 提出用の書き出しを通過する。
    const chromaKey = vi
      .fn()
      .mockResolvedValue(chromaResult({ cleared: 0, semiTransparent: 3, opaque: 1200 }));

    const out = await chromaKeyBeforeComposite("/tmp/gen.png", chromaKey);

    expect(out.path).toBe("/tmp/gen.png");
    expect(out.cleared).toBe(0);
    expect(out.opaque).toBe(1200);
  });
});

describe("R2: 呼び出し側（StickerReeditModal / StickerWorkspace）が統計を運ぶ", () => {
  /** 実ソースを読む（`spec_ts_sync` と同じ、自己言及を避ける方式）。 */
  async function readSrc(relative: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    return readFile(resolve(process.cwd(), relative), "utf8");
  }

  it("モーダルが統計を onAdopted へ渡している", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerReeditModal.tsx");
    // 抜いた結果を丸ごと受けていること（パスだけ取り出すと統計が消える）。
    expect(src, "抜きの戻りを変数で受けていない").toContain(
      "const cutout = await cutOutBeforeComposite(",
    );
    expect(
      src,
      "onAdopted に抜きの結果を渡していない（R2 の再発。層Aが材料を受け取れない）",
    ).toContain("onAdopted(item.index, compositePath, cutout)");
  });

  it("Workspace が個別再生成の統計を**登録**している（delete で終わらせない）", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const adoptAt = src.indexOf("const adoptReedit");
    expect(adoptAt, "adoptReedit が見つからない").toBeGreaterThan(-1);
    // adoptReedit の本体だけを見る（cutOut 側の set と取り違えないよう範囲を切る）。
    const body = src.slice(adoptAt, src.indexOf("const chromaSamplesFor", adoptAt));

    expect(body, "adoptReedit が統計を登録していない（R2 の再発）").toContain(
      "chromaStatsRef.current.set(newImagePath",
    );

    // 2026-08-05 I2: `delete` の意味が変わったので、単純な禁止では固定できない。
    //
    // 旧構造ではクロマキーが唯一の経路だったため、`delete` は「測った統計を捨てる」
    // ことしか意味しなかった（＝R2 の退行）。AI抜き既定化で `chroma === null`
    // （＝クロマキーを通していない）という経路が増え、そこでは
    // **前の絵の統計を消すのが正しい**（測っていない画像の縁の品質を語らない）。
    //
    // よって固定するのは「delete が無いこと」ではなく、
    // **統計があるときは登録し、無いときだけ消す**という条件分岐そのもの。
    const setAt = body.indexOf("chromaStatsRef.current.set(newImagePath");
    const deleteAt = body.indexOf("chromaStatsRef.current.delete(newImagePath");
    const guardAt = body.indexOf("if (cutout.chroma)");

    expect(guardAt, "統計の有無で分岐していない（R2 の再発）").toBeGreaterThan(-1);
    expect(
      setAt > guardAt,
      "登録が `if (cutout.chroma)` の内側にない（測っていない統計を作りうる）",
    ).toBe(true);
    if (deleteAt > -1) {
      expect(
        deleteAt > setAt,
        "登録より前に delete している（登録した統計をその場で消している・R2 の再発）",
      ).toBe(true);
    }
  });

  it("通常経路の cutOut も cleared === 0 の統計を登録している（R2 の整合）", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const cutAt = src.indexOf("const cutOut = useCallback");
    expect(cutAt, "cutOut が見つからない").toBeGreaterThan(-1);
    const body = src.slice(cutAt, src.indexOf("// ── イベント購読", cutAt));

    const setAt = body.indexOf("chromaStatsRef.current.set(");
    expect(setAt, "cutOut が統計を登録していない").toBeGreaterThan(-1);

    // 登録が `cleared > 0` の内側にあると、抜けなかった画像の事実が層Aへ届かない
    // （通常経路の「緑のまま」がすり抜ける）。I2 以後、この条件は `cutout.ts` 側で
    // 閉じている（`cleared === 0` でも統計を組み立てて返す）ので、
    // 呼び出し側に `cleared > 0` のガードが**復活していないこと**を固定する。
    expect(
      body,
      "統計の登録が cleared > 0 の内側にある（緑のままの画像が層Aの材料を持たない・R2 の再発）",
    ).not.toContain("if (res.cleared > 0)");
    // 登録は「統計があるかどうか」だけで分岐する。
    expect(body, "統計の有無で分岐していない").toContain("if (outcome.chroma)");
  });
});
