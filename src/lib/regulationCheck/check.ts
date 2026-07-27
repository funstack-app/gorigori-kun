/**
 * レギュレーション検査の実行ロジック（Codex 画像入力ベース・MVP）
 *
 * 検査経路（画像を2つの角度から読み、両方を判定材料にする）:
 *   1a. codex_describe_image (codexVision.describeImage) — 画像の「見た目」。被写体/構図/
 *       色/背景を英語プロンプト1行で得る。**文字列は含まれない**（AI画像生成用の記述のため）。
 *   1b. codex_extract_text_blocks (regulationCheck/textBlocks: extractTextInfo) — 画像内の
 *       「文字」。文字内容・座標・サイズ・色を構造化して得る。文字面積比もここで算出する。
 *   2.  codex_text_query (agents/codexQuery: codexTextQuery, expectJson) — 1a と 1b の
 *       両方をルールセットと共に渡し、issue の JSON を構造化させる。
 *
 * なぜ 1b を足したか（2026-07-27）:
 *   以前は 1a だけを判定材料にしていた。あれは「絵として何が写っているか」であり、
 *   画像内の文字を1文字も含まない。そのため文字面積 / NG表現（必ず・100%・日本一）/
 *   打消し表記の入れ忘れ / ロゴサイズ といった *文字を読まないと判定できないルール* が
 *   構造的に空振りしていた（「業界No.1」と大書きされていても検出されない）。
 *   ルール定義（rules.ts）はこれらを数値基準で要求しているのに、材料が入力に無かった。
 *
 * 失敗時の扱い: 1a/1b/2 のいずれかが失敗したら checkImage が error に落とし、
 * 画面が「検査エラー」と赤字で出す。空の issues（＝問題なし）で握りつぶさない。
 */

import { codexVision } from "../ipc";
import { codexTextQuery } from "../agents/codexQuery";
import { extractTextInfo, formatTextInfoForPrompt } from "./textBlocks";
import {
  type RegulationRule,
  type RegulationSeverity,
} from "./rules";

/** 検査で検出された指摘1件。 */
export type RegulationIssue = {
  /** 対応する画像パス。 */
  imagePath: string;
  /** 抵触したルール id（rules.ts の RegulationRule.id）。 */
  ruleId: string;
  /** 重大度。 */
  severity: RegulationSeverity;
  /** 指摘の要旨（何が問題か）。 */
  message: string;
  /** 根拠（画像内のどこ・どの文言から判断したか）。 */
  evidence: string;
};

/** 画像1枚ぶんの検査結果。 */
export type RegulationImageResult = {
  imagePath: string;
  /** 検出された指摘。空配列 = 問題なし。 */
  issues: RegulationIssue[];
  /** Codex が返した生の description（デバッグ・根拠確認用）。 */
  description: string;
  /** この画像の検査が失敗した場合のエラー文言（成功時は null）。 */
  error: string | null;
};

const VALID_SEVERITIES: readonly RegulationSeverity[] = ["high", "mid", "low"];

/** Codex 応答の未検証 issue を検査し、正規の RegulationIssue に整える（未信頼入力の検証）。 */
function normalizeIssues(
  raw: unknown,
  imagePath: string,
  validRuleIds: ReadonlySet<string>,
): RegulationIssue[] {
  if (!Array.isArray(raw)) {
    throw new Error("検査結果の内容が不正です。もう一度お試しください。");
  }
  const out: RegulationIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("検査結果の内容が不正です。もう一度お試しください。");
    }
    const e = entry as Record<string, unknown>;
    const ruleId = typeof e.ruleId === "string" ? e.ruleId : "";
    const severity = e.severity;
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const evidence = typeof e.evidence === "string" ? e.evidence.trim() : "";
    if (
      !validRuleIds.has(ruleId) ||
      typeof severity !== "string" ||
      !VALID_SEVERITIES.includes(severity as RegulationSeverity) ||
      !message ||
      !evidence
    ) {
      throw new Error("検査結果の内容が不正です。もう一度お試しください。");
    }
    out.push({
      imagePath,
      ruleId,
      severity: severity as RegulationSeverity,
      message,
      evidence,
    });
  }
  return out;
}

/** ルールセットを Codex への判定基準テキストへ整形する。 */
function formatRulesForPrompt(rules: readonly RegulationRule[]): string {
  return rules
    .map(
      (r) =>
        `- ruleId="${r.id}" 【${r.name}】: ${r.criteria}`,
    )
    .join("\n");
}

/**
 * 画像 description + ルールから issue JSON を Codex に作らせる。
 * expectJson で JSON 抽出済みの parsedJson を優先し、無ければ text からのフォールバックはしない
 * （壊れ出力を推測で埋めない）。
 */
async function judgeAgainstRules(
  description: string,
  textInfo: string,
  imagePath: string,
  rules: readonly RegulationRule[],
  signal?: AbortSignal,
): Promise<RegulationIssue[]> {
  const validRuleIds = new Set(rules.map((r) => r.id));
  const systemPrompt =
    "あなたは広告・クリエイティブのレギュレーション審査官です。与えられた画像の説明文と、画像から抽出された文字情報を、指定された検査基準に照らして厳密に審査します。基準に照らして問題があるものだけを issue として挙げ、確信が持てないものは挙げません。前置き・説明は書かず、JSON だけを出力します。";
  const prompt = [
    "# 検査対象の画像説明（この画像を Codex が解析した description）",
    description,
    "",
    "# 画像から抽出した文字情報（文字に関する基準はこちらを根拠に判定すること）",
    textInfo,
    "",
    "# 検査基準（各行の ruleId をそのまま issue.ruleId に使うこと）",
    formatRulesForPrompt(rules),
    "",
    "# 指示",
    "上の説明文と文字情報から読み取れる範囲で、各検査基準に抵触する点だけを issue として列挙してください。",
    "- 文字面積・禁止表現・必須表記の有無・ロゴサイズなど文字に関する基準は、必ず「文字情報」セクションを根拠にする（画像説明文には文字が含まれないため）。",
    "- 抵触が無ければ issues を空配列にする。",
    "- ruleId は上記の基準に存在するものだけを使う（新しい id を作らない）。",
    "- severity は high / mid / low のいずれか。",
    "- message は何が問題かの要旨（日本語・1文）。",
    "- evidence は説明文中のどの記述から判断したかの根拠（日本語）。",
    "",
    "# 出力形式（この JSON のみ・コードフェンス不要）",
    '{"issues":[{"ruleId":"...","severity":"high|mid|low","message":"...","evidence":"..."}]}',
  ].join("\n");

  const res = await codexTextQuery({
    prompt,
    systemPrompt,
    expectJson: true,
    timeoutSecs: 180,
    signal,
  });

  const parsed = res.parsedJson;
  // 期待する形は {"issues": [...]}。issues キーが配列として存在するときだけ「検査成功」。
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const issues = (parsed as Record<string, unknown>).issues;
    if (Array.isArray(issues)) {
      return normalizeIssues(issues, imagePath, validRuleIds);
    }
  }
  // parsedJson が配列そのもの（issues を包まず返す）ケースも合格扱いで拾う。
  if (Array.isArray(parsed)) {
    return normalizeIssues(parsed, imagePath, validRuleIds);
  }
  // ここに来る = JSON として妥当だが形が違う（{} / {"issues":"wrong"} / null 等）。
  // 空配列(=問題なし)と取り違えないよう、検査失敗として投げて error に落とす
  // （no-silent-gap-filling: 壊れ出力を「問題なし」で埋めない）。
  throw new Error(
    "検査結果の形式が不正です（issues 配列が見つかりません）。もう一度お試しください。",
  );
}

/**
 * 画像1枚を検査する。description 取得（実画像入力）→ ルール照合の2段。
 * どちらかが失敗したら error を埋めて返す（例外は投げない＝1枚の失敗で全体を止めない）。
 */
export async function checkImage(
  imagePath: string,
  rules: readonly RegulationRule[],
  signal?: AbortSignal,
): Promise<RegulationImageResult> {
  try {
    // 画像の見た目 (description) と 画像内の文字 (textInfo) は別経路で取る。
    // description は AI 画像生成用の英語プロンプトで文字を一切含まないため、
    // 文字前提のルール (面積 / NG表現 / 必須表記 / ロゴ) はこれだけでは判定できない
    // (2026-07-27 監査で空振りを検出し textInfo を追加)。
    const [description, textExtraction] = await Promise.all([
      codexVision.describeImage(imagePath),
      extractTextInfo(imagePath),
    ]);
    const issues = await judgeAgainstRules(
      description,
      formatTextInfoForPrompt(textExtraction),
      imagePath,
      rules,
      signal,
    );
    return { imagePath, issues, description, error: null };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return {
      imagePath,
      issues: [],
      description: "",
      error: message,
    };
  }
}

/** 検査結果をクリップボード用のプレーンテキストへ整形する。 */
export function formatResultsAsText(
  results: readonly RegulationImageResult[],
  rules: readonly RegulationRule[],
): string {
  const ruleName = (id: string) =>
    rules.find((r) => r.id === id)?.name ?? id;
  const sevLabel: Record<RegulationSeverity, string> = {
    high: "重大",
    mid: "要修正",
    low: "軽微",
  };
  const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

  const lines: string[] = ["レギュレーション検査結果", ""];
  for (const r of results) {
    lines.push(`■ ${basename(r.imagePath)}`);
    if (r.error) {
      lines.push(`  検査エラー: ${r.error}`);
    } else if (r.issues.length === 0) {
      lines.push("  問題なし");
    } else {
      for (const issue of r.issues) {
        lines.push(
          `  [${sevLabel[issue.severity]}] ${ruleName(issue.ruleId)}: ${issue.message}`,
        );
        if (issue.evidence) lines.push(`    根拠: ${issue.evidence}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
