/**
 * B1: i2v 元画像がセット済みのとき、キャラ参照画像が捨てられていたバグの検査。
 *
 * ## この検査が守っているもの
 *
 * STΛCK の原則:
 *   参照画像 = 「これ」（同一性の指定。何を描くか）
 *   プロンプト = 「これをどうするか」（動作・構図の指定）
 *
 * 旧実装 (useVideoSceneGeneration.ts) は i2v 元画像があると参照ラックを丸ごと捨てた:
 *
 *   if (sourceImagePath) return [sourceImagePath];
 *   return composerReferences.map((r) => r.path);
 *
 * 実害は「捨てられたこと自体がユーザーに見えない」点にある。参照ラックのチップには
 * 画像が出ているのに、生成へ渡るのは元画像1枚だけで、キャラの同一性は属性テキスト
 * (`キャラクター設定: 黒髪ロング …`) でしか効かない。**参照は付けたのに文字だけが
 * 効いている**状態で、原則が完全に逆転する。
 *
 * ここで見るのは「元画像が先頭に来るか」だけでなく、
 * **「参照ラックが1枚でも消えていないか」**。後者が本命。
 */
import { describe, expect, it } from "vitest";

import { resolveVideoRefPaths } from "../src/lib/scene/resolveVideoRefPaths";

const SOURCE = "/tmp/gori/i2v-source.png";
const CHARA_A = "/tmp/gori/chara-front.png";
const CHARA_B = "/tmp/gori/chara-side.png";

describe("resolveVideoRefPaths", () => {
  it("i2v 元画像があってもキャラ参照画像を捨てない（本命の退行検査）", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: SOURCE,
      referencePaths: [CHARA_A, CHARA_B],
    });

    // 旧実装ではここが [SOURCE] だけになり、キャラ参照が消えていた。
    expect(result.paths).toEqual([SOURCE, CHARA_A, CHARA_B]);
    // 参照ラックの画像が1枚も落ちていないことを個別にも押さえる
    // (要素数だけの検査だと、別物に置き換わっても通ってしまう)。
    expect(result.paths).toContain(CHARA_A);
    expect(result.paths).toContain(CHARA_B);
  });

  it("黙って捨てた画像がないことを dropped で表明する", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: SOURCE,
      referencePaths: [CHARA_A, CHARA_B],
    });
    // 現在の Higgsfield MCP は枚数無制限 (higgsfield_mcp.rs:661-683 が全件ループ)。
    // 将来上限が入っても「黙って捨てない」ことを型と検査で固定しておく。
    expect(result.dropped).toEqual([]);
  });

  it("i2v 元画像を先頭に固定する（順序が唯一の手掛かりのため）", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: SOURCE,
      referencePaths: [CHARA_A],
    });
    expect(result.paths[0]).toBe(SOURCE);
  });

  it("元画像が参照ラックにも入っている場合は重複させない", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: SOURCE,
      referencePaths: [CHARA_A, SOURCE],
    });
    expect(result.paths).toEqual([SOURCE, CHARA_A]);
  });

  it("i2v 元画像が無ければ参照ラックだけを登録順で渡す", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: null,
      referencePaths: [CHARA_A, CHARA_B],
    });
    expect(result.paths).toEqual([CHARA_A, CHARA_B]);
  });

  it("空文字・空白のみのパスは無視する", () => {
    const result = resolveVideoRefPaths({
      sourceImagePath: "   ",
      referencePaths: ["", CHARA_A, "  "],
    });
    expect(result.paths).toEqual([CHARA_A]);
  });

  it("参照も元画像も無ければ空配列", () => {
    expect(
      resolveVideoRefPaths({ sourceImagePath: undefined, referencePaths: [] }).paths,
    ).toEqual([]);
  });
});
