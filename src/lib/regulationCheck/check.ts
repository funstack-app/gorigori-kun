/**
 * レギュレーション検査の実行ロジック（Codex 画像入力ベース・MVP）
 *
 * 検査経路（既存 Codex 経路を再利用。新規 Rust コマンドは追加しない）:
 *   1. codex_describe_image (ipc: codexVision.describeImage) — 画像を Codex(-i 添付)に
 *      実入力し、被写体/構図/色/背景/読み取れる文字などの詳細な description を得る。
 *      → ここで「画像が実際に Codex に渡る」。
 *   2. codex_text_query (agents/codexQuery: codexTextQuery, expectJson) — 上記 description と
 *      ルールセットを渡し、issue の JSON を構造化させる。
 *
 * MVP の既知ギャップ（報告済み）:
 * - Codex はルール文と画像を「同時」には見ない。画像は step1 の description 経由でしか
 *   参照されないため、微細な文字/ロゴのピクセル判定はリファレンスが description の精度に依存する。
 *   画像+任意プロンプトを一度に渡す汎用 Rust コマンドが無いことによる制約（src-tauri 編集は本タスク対象外）。
 */

import { codexVision } from "../ipc";
import { codexTextQuery } from "../agents/codexQuery";
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
  if (!Array.isArray(raw)) return [];
  const out: RegulationIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const ruleId = typeof e.ruleId === "string" ? e.ruleId : "";
    const severity =
      typeof e.severity === "string" &&
      VALID_SEVERITIES.includes(e.severity as RegulationSeverity)
        ? (e.severity as RegulationSeverity)
        : "mid";
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const evidence = typeof e.evidence === "string" ? e.evidence.trim() : "";
    // ruleId が既知セットに無い / message が空 の壊れ issue は捨てる（推測で補完しない）。
    if (!validRuleIds.has(ruleId) || !message) continue;
    out.push({ imagePath, ruleId, severity, message, evidence });
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
  imagePath: string,
  rules: readonly RegulationRule[],
  signal?: AbortSignal,
): Promise<RegulationIssue[]> {
  const validRuleIds = new Set(rules.map((r) => r.id));
  const systemPrompt =
    "あなたは広告・クリエイティブのレギュレーション審査官です。与えられた画像の説明文を、指定された検査基準に照らして厳密に審査します。基準に照らして問題があるものだけを issue として挙げ、確信が持てないものは挙げません。前置き・説明は書かず、JSON だけを出力します。";
  const prompt = [
    "# 検査対象の画像説明（この画像を Codex が解析した description）",
    description,
    "",
    "# 検査基準（各行の ruleId をそのまま issue.ruleId に使うこと）",
    formatRulesForPrompt(rules),
    "",
    "# 指示",
    "上の説明文から読み取れる範囲で、各検査基準に抵触する点だけを issue として列挙してください。",
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
    const description = await codexVision.describeImage(imagePath);
    const issues = await judgeAgainstRules(description, imagePath, rules, signal);
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
