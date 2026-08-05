/**
 * A2: 審査観点の事実列挙（`codex_review_facts`）の**関所**の検査。
 *
 * ## この検査が守っているもの
 *
 * `reviewFacts` の返り値は「未検証の生 JSON 文字列」という契約で、パースと検証は
 * 呼び出し側の責務。ところがその検証はどこにも実装されておらず、壊れたJSONや
 * 前置きだけの文章が**そのまま次のAIのプロンプトへ載っていた**。
 *
 * ここで見るのは「壊れた入力で throw するか」だけでなく、
 * **「空の結果（＝問題なし）で握り潰していないか」**。後者が本命。
 * 検査が失敗したのに「気になる点は見つかりませんでした」と表示されるのが最悪の失敗。
 */
import { describe, expect, it } from "vitest";

import {
  formatReviewFactsForPrompt,
  parseReviewFacts,
  REVIEW_FACT_FLAG_KEYS,
  REVIEW_FACT_LIST_KEYS,
  undeterminedFactLabels,
} from "../src/lib/sticker/reviewFacts";

/** Rust 側プロンプトが要求する形をすべて満たす、正常な応答。 */
function validRaw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    brandMarks: [],
    realPersons: { present: false, reason: "" },
    knownCharacters: [],
    textStrings: [],
    hasPictorialContent: true,
    skinExposure: { present: false, reason: "" },
    violence: { present: false, reason: "" },
    politicalReligious: { present: false, reason: "" },
    discrimination: { present: false, reason: "" },
    gambling: { present: false, reason: "" },
    ...overrides,
  });
}

describe("parseReviewFacts: 壊れた入力を握り潰さない", () => {
  it("JSON が1文字も含まれない応答を throw する", () => {
    expect(() => parseReviewFacts("解析できませんでした。")).toThrow(/JSON が含まれ/);
  });

  it("閉じていない JSON を throw する", () => {
    expect(() => parseReviewFacts('{"brandMarks": ["A"')).toThrow(/JSON が含まれ/);
  });

  it("JSON として読めない中身を throw する", () => {
    expect(() => parseReviewFacts("{ これは JSON ではない }")).toThrow(/JSON として読めま/);
  });

  it("空文字を throw する（「該当なし」と取り違えない）", () => {
    expect(() => parseReviewFacts("")).toThrow();
  });

  it("配列を返された場合を throw する（オブジェクトを要求している）", () => {
    expect(() => parseReviewFacts("[1,2,3]")).toThrow();
  });

  it("必須キーが1つでも欠けたら throw する（材料不足を空配列で補わない）", () => {
    for (const key of [...REVIEW_FACT_LIST_KEYS, ...REVIEW_FACT_FLAG_KEYS]) {
      const obj = JSON.parse(validRaw()) as Record<string, unknown>;
      delete obj[key];
      expect(
        () => parseReviewFacts(JSON.stringify(obj)),
        `${key} が欠けているのに通っている`,
      ).toThrow(new RegExp(key));
    }
    const noPictorial = JSON.parse(validRaw()) as Record<string, unknown>;
    delete noPictorial.hasPictorialContent;
    expect(() => parseReviewFacts(JSON.stringify(noPictorial))).toThrow(
      /hasPictorialContent/,
    );
  });

  it("配列であるべきキーが配列でなければ throw する", () => {
    expect(() => parseReviewFacts(validRaw({ brandMarks: "Nike" }))).toThrow(
      /brandMarks/,
    );
  });

  it("present-flag であるべきキーがオブジェクトでなければ throw する", () => {
    expect(() => parseReviewFacts(validRaw({ violence: true }))).toThrow(/violence/);
  });
});

describe("parseReviewFacts: 正常系と揺れの吸収", () => {
  it("素の JSON を読める", () => {
    const facts = parseReviewFacts(validRaw({ brandMarks: ["Nike", " Adidas "] }));
    expect(facts.brandMarks).toEqual(["Nike", "Adidas"]);
    expect(facts.realPersons.present).toBe(false);
    expect(facts.hasPictorialContent).toBe(true);
  });

  it("前置き・後置きが付いていても読める（parseTextBlocks と同じ規則）", () => {
    const raw = `以下が解析結果です。\n${validRaw()}\n以上です。`;
    expect(() => parseReviewFacts(raw)).not.toThrow();
  });

  it("コードフェンスで包まれていても読める", () => {
    const raw = "```json\n" + validRaw() + "\n```";
    expect(() => parseReviewFacts(raw)).not.toThrow();
  });

  it('"uncertain" を false へ潰さない（分からないものを安全だと言わない）', () => {
    const facts = parseReviewFacts(
      validRaw({ skinExposure: { present: "uncertain", reason: "判別できない" } }),
    );
    expect(facts.skinExposure.present).toBe("uncertain");
    expect(facts.skinExposure.present).not.toBe(false);
  });

  it("想定外の present 値は uncertain へ倒す（false へ倒さない）", () => {
    const facts = parseReviewFacts(validRaw({ violence: { present: "maybe", reason: "" } }));
    expect(facts.violence.present).toBe("uncertain");
  });

  it("配列の中の非文字列要素だけを捨てる（配列全体は落とさない）", () => {
    const facts = parseReviewFacts(validRaw({ textStrings: ["OK", 42, null, "  "] }));
    expect(facts.textStrings).toEqual(["OK"]);
    // **捨てたことを記録する**（R3）。黙って捨てると「該当なし」に化ける。
    expect(facts.unparsed).toEqual(["textStrings[1]", "textStrings[2]"]);
  });
});

describe("formatReviewFactsForPrompt: 検証済みの形しか下流へ渡さない", () => {
  it("uncertain をそのまま明示する（該当なしと書かない）", () => {
    const facts = parseReviewFacts(
      validRaw({ realPersons: { present: "uncertain", reason: "横顔で断定できない" } }),
    );
    const text = formatReviewFactsForPrompt(facts);
    expect(text).toContain("uncertain");
    expect(text).toContain("横顔で断定できない");
  });

  it("該当ありの名称を落とさない", () => {
    const facts = parseReviewFacts(validRaw({ knownCharacters: ["某作品のキャラ"] }));
    expect(formatReviewFactsForPrompt(facts)).toContain("某作品のキャラ");
  });
});

/**
 * R3: 壊れた内部値が「問題なし」に化けない。
 *
 * ## 何が起きていたか
 *
 * トップ階層のキー検証は throw で守られていたが、**内部の値**は静かに落ちていた:
 *
 * - `toStringList` が配列内の非文字列を捨てる（`[{"name":"Nike"}]` → `[]`）
 * - `toTriState` が不正・欠落の `present` を `"uncertain"` へ倒す
 *
 * そして決定論ルールの `isPresent` は `present === true` しか見ないので
 * `"uncertain"` を指摘しない。結果、下の壊れたJSONが指摘0件で通り、
 * UIが「気になる点は見つかりませんでした」と表示できていた。
 */
describe("R3: 壊れた内部値を未判定として可視化する", () => {
  /** 契約本文にある実物の壊れたJSON。**この入力そのもの**で検査する。 */
  const BROKEN = JSON.stringify({
    brandMarks: [{ name: "Nike" }],
    realPersons: { reason: "人物が見える" },
    knownCharacters: [],
    textStrings: [],
    hasPictorialContent: true,
    skinExposure: { present: false, reason: "" },
    violence: { present: false, reason: "" },
    politicalReligious: { present: false, reason: "" },
    discrimination: { present: false, reason: "" },
    gambling: { present: false, reason: "" },
  });

  it("前提の確認: この入力は指摘0件で通る（だから未判定の可視化が要る）", () => {
    // 「捨てる／倒す」という挙動自体は維持する判断（画像1枚を丸ごと落とさない）。
    // その前提が変わったらこのテスト群の意味が変わるので、ここで固定する。
    const facts = parseReviewFacts(BROKEN);
    expect(facts.brandMarks).toEqual([]);
    expect(facts.realPersons.present).toBe("uncertain");
  });

  it("捨てた要素・倒した値を unparsed に記録する（黙って捨てない）", () => {
    const facts = parseReviewFacts(BROKEN);
    expect(facts.unparsed).toContain("brandMarks[0]");
    expect(facts.unparsed).toContain("realPersons.present");
  });

  it("**未判定があるので「問題なし」と言えない**（R3 の本体）", () => {
    const labels = undeterminedFactLabels(parseReviewFacts(BROKEN));
    // ここが空だと UI は「気になる点は見つかりませんでした」を出してしまう。
    expect(
      labels.length,
      "未判定が0件と判定された。壊れたJSONが「問題なし」に化ける（R3 の再発）",
    ).toBeGreaterThan(0);
    expect(labels.join(" / ")).toContain("実在人物の肖像");
    expect(labels.join(" / ")).toContain("brandMarks[0]");
  });

  it("正常な入力では未判定が0件（牙が過剰に効いていない）", () => {
    expect(undeterminedFactLabels(parseReviewFacts(validRaw()))).toEqual([]);
  });

  it("uncertain と明示された項目も未判定に含める", () => {
    // 決定論ルールは uncertain を指摘しない（推測で断定しない）ので、
    // 指摘0件でも「見えていない」だけの可能性がある。その差を埋める。
    const labels = undeterminedFactLabels(
      parseReviewFacts(
        validRaw({ skinExposure: { present: "uncertain", reason: "判別できない" } }),
      ),
    );
    expect(labels).toEqual(["肌の露出・性的表現"]);
  });

  it("同じ項目を uncertain と unparsed で二重に数えない", () => {
    // present が壊れて uncertain へ倒れた場合、両方に載る。同じ事実で2回言わない。
    const labels = undeterminedFactLabels(
      parseReviewFacts(validRaw({ violence: { present: "maybe", reason: "" } })),
    );
    expect(labels.length).toBe(new Set(labels).size);
  });

  it("プロンプトに壊れた項目を明示する（該当なしと読ませない）", () => {
    const text = formatReviewFactsForPrompt(parseReviewFacts(BROKEN));
    expect(text).toContain("brandMarks[0]");
    expect(text).toContain("該当なしという意味ではありません");
  });
});
