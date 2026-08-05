/**
 * 層Bのうち、**機械照合できる規則**（A6 / 設計原則 第1条「答えが一意に決まるものは決定論に置く」）。
 *
 * ## 何が問題だったか
 *
 * `check.ts` 冒頭は「判定はルール側（決定論）で行い、AIに合否を言わせない」と説明して
 * いた。しかし実装では `reviewRules.ts` の `criteria`（自然文）をプロンプトへ流し、
 * **どのルールに抵触したかの判定そのものをAIにやらせていた**。説明と実装が一致していない。
 *
 * `parseReviewFacts`（A2）で事実が構造化されたので、**その構造を見れば一意に決まる規則**は
 * ここで条件式として判定する。AIは同じ材料を2度読まなくてよくなり、揺れも消える。
 *
 * ## 何をここへ移し、何をAIに残すか
 *
 * | ruleId | 側 | 理由 |
 * |---|---|---|
 * | `brand-mark` | **決定論** | `brandMarks` が空でないか。真偽値1つで決まる |
 * | `derivative-work` | **決定論** | `knownCharacters` が空でないか |
 * | `real-person` | **決定論** | `realPersons.present === true` か（uncertain は不指摘） |
 * | `skin-exposure` | **決定論** | 同上。**程度の評価はAIが事実側で済ませている** |
 * | `violence-crime` | **決定論** | 同上 |
 * | `politics-religion` | **決定論** | 同上 |
 * | `discrimination` | **決定論** | 同上 |
 * | `gambling` | **決定論** | 同上 |
 * | `url-in-image` | **決定論** | 文字列に URL 形が含まれるか＝正規表現で決まる |
 * | `text-only-image` | **決定論** | 「文字面積比 >= 0.4」かつ「絵の要素なし」の論理積。数値と真偽値 |
 * | `commercial-ad` | AI | 「広告に見えるか」は構成の解釈。事実の列挙からは決まらない |
 * | `low-visibility` | AI | 「小さい表示で判別できるか」は見た目の judgment |
 *
 * 境界の引き方: **`present: true` という事実に対して「重大度いくつの issue を出すか」は
 * ルール表を引くだけで一意**。一方「その事実があるかどうか」（露出が多いか、暴力的か）は
 * 意味の解釈なので `codex_review_facts` に残す。**AIには事実の認定だけをさせ、
 * ルールへの当てはめは機械がやる** — これが `check.ts` が元から宣言していた設計。
 *
 * ## severity の出どころ
 *
 * `rule.maxSeverity` をそのまま使う。決定論の判定に「AIが申告した severity を
 * 切り下げる」（`clampSeverity`）は不要 — 申告自体が無いため。上限をそのまま採るのは、
 * 各ルールの `maxSeverity` が「このルールが出しうる最大」＝**該当時の値**として
 * 設計されているから（`reviewRules.ts` の型コメント）。
 */

import type { RegulationIssue } from "../regulationCheck/check";
import type { ReviewFacts, ReviewFlag } from "./reviewFacts";
import type { StickerReviewRule } from "./reviewRules";

/** 決定論で判定する ruleId。ここに無いものはAI側へ残る。 */
export const DETERMINISTIC_RULE_IDS = [
  "brand-mark",
  "derivative-work",
  "real-person",
  "skin-exposure",
  "violence-crime",
  "politics-religion",
  "discrimination",
  "gambling",
  "url-in-image",
  "text-only-image",
] as const;

/** AI（意味の解釈）に残す ruleId。 */
export const AI_JUDGED_RULE_IDS = ["commercial-ad", "low-visibility"] as const;

/**
 * 文字列に URL とみなせる形が含まれるか。
 *
 * `http(s)://` / `www.` / 裸のドメイン（`example.com` 形）を拾う。
 * TLD を2文字以上の英字に限るのは、「1.5」「v2.0」のような数値・版数を
 * URL と誤認しないため（誤検知は「気になる点」を水増しして信頼を落とす）。
 */
const URL_PATTERN =
  /(https?:\/\/\S+|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|net|org|jp|co\.jp|io|me|shop|app|dev|info|biz|xyz)\b)/i;

export function looksLikeUrl(text: string): boolean {
  return URL_PATTERN.test(text);
}

/** `present: true` のときだけ真。`"uncertain"` は**指摘しない**（推測で断定しない）。 */
function isPresent(flag: ReviewFlag): boolean {
  return flag.present === true;
}

/**
 * 決定論で判定できる材料。
 *
 * `textAreaRatio` は `extractTextInfo` 由来の数値（0〜1）。取得できなければ `null`
 * を渡す — その場合 `text-only-image` は判定しない（**測っていない値で判定しない**）。
 */
export type DeterministicInput = {
  facts: ReviewFacts;
  /** 文字が画像面積に占める割合（0〜1）。不明なら null。 */
  textAreaRatio: number | null;
};

/** `text-only-image` を high にする文字面積比の下限（`reviewRules.ts` の criteria と同値）。 */
export const TEXT_ONLY_AREA_RATIO = 0.4;

/**
 * 決定論で判定できるルールを一括で照合する。
 *
 * 戻りは `RegulationIssue` の配列（AI側の結果と同じ型）。呼び出し側が
 * AI由来の issue と結合してから `normalizeIssues` を通す。
 */
export function evaluateDeterministicRules(
  input: DeterministicInput,
  rules: readonly StickerReviewRule[],
  imagePath: string,
): RegulationIssue[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const issues: RegulationIssue[] = [];

  /** ルールが有効なときだけ issue を積む（呼び出し側がルールを絞っている場合に備える）。 */
  const push = (ruleId: string, message: string, evidence: string) => {
    const rule = byId.get(ruleId);
    if (!rule) return;
    issues.push({
      ruleId,
      severity: rule.maxSeverity,
      message,
      evidence,
      imagePath,
    });
  };

  const { facts, textAreaRatio } = input;

  // ── 名称が挙がっていれば該当（配列が空でないか、だけで決まる） ──
  if (facts.brandMarks.length > 0) {
    push(
      "brand-mark",
      "実在企業のロゴ・商標・製品意匠と思われるものが写っています。権利の確認が必要です。",
      `審査観点の事実列挙: ${facts.brandMarks.join(" / ")}`,
    );
  }
  if (facts.knownCharacters.length > 0) {
    push(
      "derivative-work",
      "既存の商用キャラクター・作品由来と思われるものが含まれています。権利の所在を確認してください。",
      `審査観点の事実列挙: ${facts.knownCharacters.join(" / ")}`,
    );
  }

  // ── present-flag をそのまま引く（uncertain は不指摘） ──
  const flagRules: { ruleId: string; flag: ReviewFlag; message: string }[] = [
    {
      ruleId: "real-person",
      flag: facts.realPersons,
      message: "実在の人物と識別できる顔が含まれています。肖像の許諾を確認してください。",
    },
    {
      ruleId: "skin-exposure",
      flag: facts.skinExposure,
      message: "肌の露出、または性的と受け取られうる表現が含まれています。",
    },
    {
      ruleId: "violence-crime",
      flag: facts.violence,
      message: "暴力的な表現、または犯罪を助長すると受け取られうる表現が含まれています。",
    },
    {
      ruleId: "politics-religion",
      flag: facts.politicalReligious,
      message: "政治的・宗教的と受け取られうる表現が含まれています。",
    },
    {
      ruleId: "discrimination",
      flag: facts.discrimination,
      message: "差別・誹謗中傷にあたると受け取られうる表現が含まれています。",
    },
    {
      ruleId: "gambling",
      flag: facts.gambling,
      message: "賭博・ギャンブルを想起させる表現が含まれています。",
    },
  ];
  for (const { ruleId, flag, message } of flagRules) {
    if (!isPresent(flag)) continue;
    push(ruleId, message, `審査観点の事実列挙: ${flag.reason || "該当ありと記録されています"}`);
  }

  // ── URL は正規表現で決まる ──
  const urlHits = facts.textStrings.filter(looksLikeUrl);
  if (urlHits.length > 0) {
    push(
      "url-in-image",
      "画像内にURLと思われる文字列が含まれています。",
      `画像内の文字: ${urlHits.join(" / ")}`,
    );
  }

  // ── 文字だけの画像は「面積比 >= 0.4」かつ「絵の要素なし」の論理積 ──
  //
  // `textAreaRatio` が測れていない場合は**判定しない**。片方の材料が欠けたまま
  // 論理積を評価すると、測っていない条件を真だと仮定することになる。
  // `hasPictorialContent` が uncertain のときも同じ理由で判定しない。
  if (
    textAreaRatio !== null &&
    textAreaRatio >= TEXT_ONLY_AREA_RATIO &&
    facts.hasPictorialContent === false
  ) {
    push(
      "text-only-image",
      "絵の要素が無く、文字だけで構成されているように見えます。",
      `文字の面積比 ${(textAreaRatio * 100).toFixed(0)}%、絵の要素は検出されていません`,
    );
  }

  return issues;
}
