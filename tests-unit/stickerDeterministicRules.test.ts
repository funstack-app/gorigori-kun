/**
 * A6: 一意に決まるルール照合が**決定論側**で行われることの検査。
 *
 * ## 何を守っているか
 *
 * `check.ts` は元から「判定はルール側（決定論）で行い、AIに合否を言わせない」と
 * 説明していたが、実装は `criteria`（自然文）をプロンプトへ流して**当てはめまで
 * AIにやらせていた**。説明と実装が一致していなかった。
 *
 * ここでは「事実が構造化されていれば、AIを1度も呼ばずに issue が出る」ことを見る。
 * 併せて **uncertain を指摘しない**（推測で断定しない）ことも固定する。
 */
import { describe, expect, it } from "vitest";

import {
  AI_JUDGED_RULE_IDS,
  DETERMINISTIC_RULE_IDS,
  evaluateDeterministicRules,
  looksLikeUrl,
  TEXT_ONLY_AREA_RATIO,
} from "../src/lib/sticker/deterministicRules";
import { parseReviewFacts } from "../src/lib/sticker/reviewFacts";
import { unassignedRuleIds } from "../src/lib/sticker/check";
import { LINE_STICKER_REVIEW } from "../src/lib/sticker/reviewRules";

const IMG = "/tmp/01.png";

function facts(overrides: Record<string, unknown> = {}) {
  return parseReviewFacts(
    JSON.stringify({
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
    }),
  );
}

function run(overrides: Record<string, unknown> = {}, textAreaRatio: number | null = 0.1) {
  return evaluateDeterministicRules(
    { facts: facts(overrides), textAreaRatio },
    LINE_STICKER_REVIEW,
    IMG,
  );
}

const ids = (issues: { ruleId: string }[]) => issues.map((i) => i.ruleId);

describe("A6: ルールの担当が決まっている（取りこぼしゼロ）", () => {
  it("12ルールすべてが決定論かAIのどちらかに割り当てられている", () => {
    expect(unassignedRuleIds(LINE_STICKER_REVIEW)).toEqual([]);
  });

  it("決定論とAIの担当が重複していない", () => {
    const overlap = (DETERMINISTIC_RULE_IDS as readonly string[]).filter((id) =>
      (AI_JUDGED_RULE_IDS as readonly string[]).includes(id),
    );
    expect(overlap).toEqual([]);
  });

  it("担当表の ruleId が実在する（綴り間違いで静かに空振りしない）", () => {
    const real = new Set(LINE_STICKER_REVIEW.map((r) => r.id));
    for (const id of [...DETERMINISTIC_RULE_IDS, ...AI_JUDGED_RULE_IDS]) {
      expect(real.has(id), `${id} は reviewRules.ts に存在しない`).toBe(true);
    }
  });
});

describe("A6: 決定論で判定されるルール（AIを1度も呼ばない）", () => {
  it("何も無ければ issue はゼロ", () => {
    expect(run()).toEqual([]);
  });

  it("brandMarks が空でなければ brand-mark を出す", () => {
    const issues = run({ brandMarks: ["Nike"] });
    expect(ids(issues)).toContain("brand-mark");
    expect(issues.find((i) => i.ruleId === "brand-mark")?.severity).toBe("high");
    expect(issues.find((i) => i.ruleId === "brand-mark")?.evidence).toContain("Nike");
  });

  it("knownCharacters が空でなければ derivative-work を出す", () => {
    expect(ids(run({ knownCharacters: ["某キャラ"] }))).toContain("derivative-work");
  });

  it("present: true の flag ルールを出す", () => {
    const cases: [string, string][] = [
      ["realPersons", "real-person"],
      ["skinExposure", "skin-exposure"],
      ["violence", "violence-crime"],
      ["politicalReligious", "politics-religion"],
      ["discrimination", "discrimination"],
      ["gambling", "gambling"],
    ];
    for (const [factKey, ruleId] of cases) {
      const issues = run({ [factKey]: { present: true, reason: "理由" } });
      expect(ids(issues), `${ruleId} が出ていない`).toContain(ruleId);
    }
  });

  it("uncertain は指摘しない（推測で断定しない）", () => {
    const cases: [string, string][] = [
      ["realPersons", "real-person"],
      ["skinExposure", "skin-exposure"],
      ["violence", "violence-crime"],
      ["politicalReligious", "politics-religion"],
      ["discrimination", "discrimination"],
      ["gambling", "gambling"],
    ];
    for (const [factKey, ruleId] of cases) {
      const issues = run({ [factKey]: { present: "uncertain", reason: "判別不能" } });
      expect(ids(issues), `${ruleId} を uncertain で指摘している`).not.toContain(ruleId);
    }
  });

  it("gambling の severity はルール表の mid に従う（high へ上がらない）", () => {
    const issue = run({ gambling: { present: true, reason: "スロット" } }).find(
      (i) => i.ruleId === "gambling",
    );
    expect(issue?.severity).toBe("mid");
  });

  it("url-in-image は正規表現で決まる", () => {
    expect(ids(run({ textStrings: ["https://example.com へ"] }))).toContain("url-in-image");
    expect(ids(run({ textStrings: ["www.example.jp"] }))).toContain("url-in-image");
    expect(ids(run({ textStrings: ["example.com"] }))).toContain("url-in-image");
    // 版数・小数を URL と誤認しない（誤検知は信頼を落とす）。
    expect(ids(run({ textStrings: ["v2.0", "1.5", "おはよう"] }))).not.toContain(
      "url-in-image",
    );
  });

  it("text-only-image は「面積比しきい値以上」かつ「絵の要素なし」の論理積", () => {
    // 両方満たす → 出る
    expect(
      ids(run({ hasPictorialContent: false }, TEXT_ONLY_AREA_RATIO)),
    ).toContain("text-only-image");
    // 絵がある → 出ない（文字が主役のスタンプは正当）
    expect(ids(run({ hasPictorialContent: true }, 0.9))).not.toContain("text-only-image");
    // 面積比が足りない → 出ない
    expect(
      ids(run({ hasPictorialContent: false }, TEXT_ONLY_AREA_RATIO - 0.01)),
    ).not.toContain("text-only-image");
  });

  it("面積比が測れていなければ text-only-image を判定しない（測っていない値で判定しない）", () => {
    expect(ids(run({ hasPictorialContent: false }, null))).not.toContain("text-only-image");
  });

  it("hasPictorialContent が uncertain なら text-only-image を判定しない", () => {
    expect(ids(run({ hasPictorialContent: "uncertain" }, 0.9))).not.toContain(
      "text-only-image",
    );
  });

  it("AI 担当のルールは決定論側から出さない（二重指摘を作らない）", () => {
    const issues = run({
      brandMarks: ["A"],
      knownCharacters: ["B"],
      realPersons: { present: true, reason: "" },
      textStrings: ["https://x.com"],
    });
    for (const aiId of AI_JUDGED_RULE_IDS) {
      expect(ids(issues)).not.toContain(aiId);
    }
  });
});

describe("looksLikeUrl", () => {
  it("URL 形だけを拾う", () => {
    expect(looksLikeUrl("http://a.co/b")).toBe(true);
    expect(looksLikeUrl("https://example.com")).toBe(true);
    expect(looksLikeUrl("www.example.net")).toBe(true);
    expect(looksLikeUrl("shop.jp")).toBe(true);
    expect(looksLikeUrl("こんにちは")).toBe(false);
    expect(looksLikeUrl("3.14")).toBe(false);
    expect(looksLikeUrl("ver1.2")).toBe(false);
  });
});
