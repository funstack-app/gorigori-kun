/**
 * C1/C2: 属性テキストの「二重注入」と「不可視」の検査。
 *
 * ## この検査が守っているもの
 *
 * 登録キャラの属性文字列（「銀髪ロング、赤い瞳、黒いセーラー服」等）は、
 * スタンプ生成において次の1経路**だけ**を通る:
 *
 *   StickerWorkspace の `attributes` state
 *     → `CharacterSheetParams.attributes`
 *     → Rust `build_sheet_prompt` の「不変の見た目 (全カット共通で厳守)」行
 *
 * 旧実装はこれに加えて `buildStickerPrompt({ attributes })` でも注入しており、
 * **同じ文字列が1回の生成プロンプトに2箇所現れていた**（C1）。
 * さらにその属性は**画面のどこにも表示されていなかった**（C2）ため、
 * 利用者からは「キャラの画像を選んだ」だけに見えていた。
 *
 * ## なぜ「経路が1本」を型と文字列の両方で見るか
 *
 * 型（`StickerPromptInput` に `attributes` が無い）だけだと、
 * 呼び出し側が別名のフィールドで再注入する余地が残る。
 * 逆に文字列検査だけだと、型を戻して静かに復活させられる。
 * **両方**を見て、どちらの戻し方でも落ちるようにする。
 */
import { describe, expect, it } from "vitest";

import {
  buildStickerPrompt,
  STICKER_PROMPT_STYLES,
} from "../src/lib/sticker/promptStyles";

async function readSrc(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  return readFile(resolve(process.cwd(), relative), "utf8");
}

/**
 * 実運用と同じ形の属性文字列。**日本語**であることに意味がある:
 * 旧実装はこれを英語の書き味プロンプトの真ん中へ差し込んでいた。
 */
const ATTRIBUTES = "銀髪ロング、赤い瞳、黒いセーラー服";

describe("C1: 属性は書き味プロンプトに入らない（二重注入の禁止）", () => {
  it("全スタイルの出力に属性文字列が現れない", () => {
    for (const style of STICKER_PROMPT_STYLES) {
      // 旧実装の呼び出し形をそのまま再現する。型に無いフィールドを渡しても
      // 実装が読まなければ出力には出ない ＝ 経路が塞がっている。
      const prompt = buildStickerPrompt(style.id, {
        promptFragment: "laughing with eyes closed",
        ...({ attributes: ATTRIBUTES } as Record<string, string>),
      });
      expect(
        prompt,
        `${style.id}: 属性が書き味プロンプトに混ざっている（C1 の再発）`,
      ).not.toContain(ATTRIBUTES);
      // 本来の中身は残っていること（消しすぎの検出）。
      expect(prompt).toContain("laughing with eyes closed");
    }
  });

  it("StickerPromptInput が attributes を受け取らない（型でも塞ぐ）", async () => {
    const src = await readSrc("src/lib/sticker/promptStyles.ts");
    const typeAt = src.indexOf("export type StickerPromptInput");
    expect(typeAt, "StickerPromptInput が見つからない").toBeGreaterThan(-1);
    const typeBody = src.slice(typeAt, src.indexOf("};", typeAt));
    expect(
      typeBody,
      "StickerPromptInput に attributes が復活している（C1 の再発）",
    ).not.toContain("attributes");
  });

  it("スタイル実装が input.attributes を読まない", async () => {
    const src = await readSrc("src/lib/sticker/promptStyles.ts");
    // コメントでの言及は許す（なぜ入れないかの説明が本文に要る）。
    // 見るのは**コードとしての参照**だけ。
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code, "スタイルが属性を読んでいる（C1 の再発）").not.toContain(
      "input.attributes",
    );
  });

  it("Workspace は属性を buildStickerPrompt へ渡さず params.attributes だけで渡す", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");

    // buildStickerPrompt の実引数オブジェクトに attributes を入れていないこと。
    const callAt = src.indexOf("buildStickerPrompt(DEFAULT_PROMPT_STYLE, {");
    expect(callAt, "buildStickerPrompt の呼び出しが見つからない").toBeGreaterThan(-1);
    const callArgs = src.slice(callAt, src.indexOf("})", callAt));
    expect(callArgs, "属性を書き味プロンプトへ渡している（C1 の再発）").not.toContain(
      "attributes",
    );

    // Rust 側へ渡す経路は**残っている**こと（消しすぎると属性が丸ごと効かなくなる）。
    expect(
      src,
      "params.attributes の経路まで消えている（属性が生成に効かなくなる）",
    ).toContain("attributes,");
  });
});

describe("C2: 属性が画面に表示される", () => {
  it("SetupPanel が属性を読み取り専用で描画する", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");

    // 表情差分（ExpressionSetWorkspace）と同じ「属性: <値>」の流儀。
    expect(src, "属性が画面に出ていない（C2 の再発）").toContain("属性: {attributes}");
    // SetupPanel まで prop が届いていること（state だけ持って渡し忘れを防ぐ）。
    expect(src, "SetupPanel へ属性を渡していない").toContain("attributes={attributes}");
  });

  it("編集可能にしていない（キャラ登録が属性の正本のまま）", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const at = src.indexOf("属性: {attributes}");
    expect(at).toBeGreaterThan(-1);
    // 表示は <p> の1行。input/textarea を置くとこの画面で属性を上書きでき、
    // 同じキャラなのにスキルごとに見た目が変わる原因になる。
    const around = src.slice(Math.max(0, at - 300), at + 200);
    expect(around, "属性を編集可能にしている").not.toContain("<input");
    expect(around, "属性を編集可能にしている").not.toContain("<textarea");
    expect(around, "属性表示が <p> でない").toContain("<p ");
  });

  it("一等地にボタンを増やしていない（配置文法）", async () => {
    const src = await readSrc("src/components/skills/sticker/StickerWorkspace.tsx");
    const setupAt = src.indexOf("function SetupPanel(");
    const setupEnd = src.indexOf("function GeneratePanel(");
    expect(setupAt).toBeGreaterThan(-1);
    expect(setupEnd).toBeGreaterThan(setupAt);
    const setupBody = src.slice(setupAt, setupEnd);
    // 素材選択画面の button は既存の5箇所:
    //   キャラタイル / 手持ちの画像から選ぶ / 枚数 / 中身の方向 / 生成
    // （タイル・枚数・方向は map 内の1つずつ）。
    const buttons = setupBody.split("<button").length - 1;
    expect(
      buttons,
      `素材選択画面の button が増えている（${buttons} 個）。属性表示はボタンでなく文字で出す`,
    ).toBe(5);
  });
});
