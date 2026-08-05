/**
 * LINEスタンプ 審査セルフチェック（層B）の実行ロジック
 *
 * ## 3材料を束ねる（このファイルの存在理由）
 *
 * | # | 材料 | 取得元 | 主に効くルール |
 * |---|---|---|---|
 * | 1 | 画像内の文字 + 文字面積比 | `extractTextInfo`（既存） | text-only-image / url-in-image |
 * | 2 | 審査観点の事実列挙 | `codexVision.reviewFacts`（S5・新規） | brand-mark / real-person / derivative-work / 露出・暴力・政治宗教 |
 * | 3 | 見た目の概要 | `codexVision.describeImage`（既存） | 補助のみ |
 *
 * **なぜ材料2が要るか**: `describeImage` のプロンプトは「AI画像生成で再現するための英語
 * プロンプトを1行で」であり、**固有名詞を出さないよう最適化された出力**になる
 * （"a red sports car" であって "a Ferrari" ではない）。ブランド名・実在人物名・作品名は
 * 構造的に出てこないため、材料3だけでは権利・肖像のルールが空振りする。
 *
 * これは同じリポジトリで一度起きた事故と同型で、`regulationCheck/check.ts` 冒頭が
 * 「ルール定義は数値基準で要求しているのに、材料が入力に無かった」と記録している。
 * LINE審査で最も落ちやすいのがまさに権利・露出（実例14件）なので、材料2が無いと
 * 「審査セルフチェック」という名前が約束したことをやらない状態で出ることになる。
 *
 * ## 判定はルール側（決定論）で行い、AIに合否を言わせない
 *
 * 材料2は **事実の列挙**（何が見えるか）であって判断ではない。
 *
 * ### 2026-08-05 修正: 説明と実装のズレを埋めた（A6）
 *
 * この節は元から上のように宣言していたが、**実装はルールへの当てはめまでAIに
 * やらせていた**（`criteria` の自然文をプロンプトへ流していた）。事実が
 * `parseReviewFacts` で構造化された今、**当てはめは条件式へ移した**:
 *
 * - **決定論**（`deterministicRules.ts`）: brand-mark / derivative-work / real-person /
 *   skin-exposure / violence-crime / politics-religion / discrimination / gambling /
 *   url-in-image / text-only-image ——「事実が present か」「配列が空でないか」
 *   「文字列がURL形か」「数値がしきい値以上か」で**一意に決まる**もの
 * - **AI**（このファイルのプロンプト）: commercial-ad / low-visibility ——
 *   「広告に見えるか」「小さい表示で判別できるか」という**構成・見た目の解釈**
 *
 * AIには**事実の認定**（露出があるか・暴力的か）だけをさせ、そこから先の
 * ルールへの当てはめは機械がやる。`clampSeverity` は AI 側の issue にだけ残す
 * （決定論側は severity を自分で決めるので切り下げる相手がいない）。
 *
 * ## 「審査に通る」とは判定しない
 *
 * 出せるのは「検査が実行され、指摘が構造化されて出ること」まで（設計書 §0.2 / §4.4）。
 * 結果には `REVIEW_DISCLAIMER` を必ず添える。
 *
 * ## 失敗の扱い
 *
 * 材料1〜3 のいずれかが失敗したら、その画像を error に落とす。**空の issues
 * （＝問題なし）で握り潰さない**（`regulationCheck/check.ts` と同じ規律）。
 * 1枚の失敗で全体は止めない（部分成功・A4）。
 */

import { codexVision } from "../ipc";
import { codexTextQuery } from "../agents/codexQuery";
import {
  formatRulesForPrompt,
  normalizeIssues,
  type RegulationIssue,
} from "../regulationCheck/check";
import { extractTextInfo, formatTextInfoForPrompt } from "../regulationCheck/textBlocks";
import type { RegulationSeverity } from "../regulationCheck/rules";
import {
  AI_JUDGED_RULE_IDS,
  DETERMINISTIC_RULE_IDS,
  evaluateDeterministicRules,
} from "./deterministicRules";
import {
  formatReviewFactsForPrompt,
  parseReviewFacts,
  undeterminedFactLabels,
} from "./reviewFacts";
import {
  LINE_STICKER_REVIEW,
  LINE_STICKER_REVIEW_BY_ID,
  REVIEW_DISCLAIMER,
  type StickerReviewRule,
} from "./reviewRules";

/** 層Bの指摘1件。既存の RegulationIssue をそのまま使う（表示側を共通化するため）。 */
export type StickerReviewIssue = RegulationIssue;

/** 画像1枚ぶんの層B検査結果。 */
export type StickerReviewResult = {
  imagePath: string;
  /** 検出された指摘。空配列 = 気になる点が見つからなかった（「合格」ではない）。 */
  issues: StickerReviewIssue[];
  /** この画像の検査が失敗した場合のエラー文言（成功時は null）。 */
  error: string | null;
  /**
   * **判定できなかった項目**の一覧（R3 / 2026-08-05）。空なら全項目を判定できた。
   *
   * 中身は `"実在人物の肖像"` のような人が読めるラベル
   * （`undeterminedFactLabels` が作る）。入るのは2種類:
   *
   * - AIが `"uncertain"`（判別できない）と申告した項目
   * - 材料そのものが壊れていて読み取れなかった項目（`ReviewFacts.unparsed`）
   *
   * どちらも「該当なし」ではない。**これが空でない限り、UIは
   * 「気になる点は見つかりませんでした」と言い切ってはいけない** —
   * 決定論ルールは uncertain を指摘しない設計（推測で断定しない）なので、
   * issues が0件でも「見えていない」だけの可能性がある。その差をここで運ぶ。
   */
  undetermined: string[];
};

/** 層B全体の結果。UI はこの単位で表示する。 */
export type StickerReviewReport = {
  results: StickerReviewResult[];
  /** 常に添える但し書き。UI 側で省略しないこと。 */
  disclaimer: string;
  /**
   * 検査対象から明示的に外したファイルと、その理由。
   * **黙って外さない**（設計書 §1.9: tab.png は判定困難なため対象外だが、その旨をUIに書く）。
   */
  excluded: { imagePath: string; reason: string }[];
};

const SEVERITY_RANK: Record<RegulationSeverity, number> = { low: 0, mid: 1, high: 2 };

/**
 * 決定論とAIのどちらにも割り当てられていないルールを検出する（A6 の取りこぼし防止）。
 *
 * 判定を2つの側へ分けた結果、**どちらにも入らないルールは黙って検査されなくなる**。
 * ルールを1本足したときに担当を書き忘れる事故がこれ。`reviewRules.ts` を編集した人が
 * 気づけるよう、実行時に列挙して返す（テストがこれを空と assert する）。
 */
export function unassignedRuleIds(
  rules: readonly StickerReviewRule[] = LINE_STICKER_REVIEW,
): string[] {
  const assigned = new Set<string>([...DETERMINISTIC_RULE_IDS, ...AI_JUDGED_RULE_IDS]);
  return rules.map((r) => r.id).filter((id) => !assigned.has(id));
}

/**
 * 3材料の取得元と判定の呼び出し口。
 *
 * 既定は実 IPC（下の `DEFAULT_DEPS`）。テストが差し替えるための継ぎ目として切ってある
 * ——Codex を実際に呼ばずに「3材料が全部プロンプトへ載るか」「壊れ出力で握り潰さないか」を
 * 検査したいが、そこはこの層の芯なので検査できない構造にはしたくない。
 */
export type StickerReviewDeps = {
  describeImage: (imagePath: string) => Promise<string>;
  /**
   * 画像内の文字情報。**面積比を数値でも返す**（A6）。
   *
   * 整形済みの文面だけだと `text-only-image` の「面積比 >= 0.4」を機械で判定できず、
   * AIに文面から数値を読み取らせることになる（一意に決まる比較をAIにやらせない）。
   */
  extractText: (imagePath: string) => Promise<{ prompt: string; textAreaRatio: number | null }>;
  reviewFacts: (imagePath: string) => Promise<string>;
  query: (args: {
    prompt: string;
    systemPrompt: string;
    expectJson: boolean;
    timeoutSecs?: number;
    signal?: AbortSignal;
  }) => Promise<{ parsedJson: unknown }>;
};

const DEFAULT_DEPS: StickerReviewDeps = {
  describeImage: (p) => codexVision.describeImage(p),
  extractText: async (p) => {
    const info = await extractTextInfo(p);
    return { prompt: formatTextInfoForPrompt(info), textAreaRatio: info.textAreaRatio };
  },
  reviewFacts: (p) => codexVision.reviewFacts(p),
  query: (args) => codexTextQuery(args),
};

/**
 * 検査対象から外すファイル名（拡張子込み・小文字比較）。
 *
 * `tab.png`（96×74）は小さすぎて内容の判定が困難なため対象外。
 * `main.png` は **対象に含める** — LINE STORE とスタンプショップのサムネイルであり
 * 最も人目に触れる1枚なので、ここを外すと網に穴が空く（設計書 §1.9）。
 */
const EXCLUDED_BASENAMES: ReadonlyMap<string, string> = new Map([
  ["tab.png", "タブ画像（96×74）は小さく内容の判定が困難なため、自動チェックの対象外です。"],
]);

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * AI が申告した severity を、ルール定義の `maxSeverity` で頭打ちにする。
 *
 * なぜコードで縛るか: `url-in-image` は「画像内URLの明示禁止が一次情報で未確認」という
 * 理由で mid に留めた設計判断であり、AI が high と言ったからといって上がってよい値ではない。
 * 未確認事項が high として表示されると、ユーザーは確定した禁止事項だと受け取る。
 */
function clampSeverity(issue: StickerReviewIssue, rule: StickerReviewRule): StickerReviewIssue {
  if (SEVERITY_RANK[issue.severity] <= SEVERITY_RANK[rule.maxSeverity]) return issue;
  return { ...issue, severity: rule.maxSeverity };
}

/**
 * 3材料をプロンプトへ展開して issue JSON を作らせる。
 *
 * 材料は**3セクションとも必ず展開する**（A1）。片方が空でも見出しごと落とさない
 * ——「材料が無かった」のか「材料はあったが該当が無かった」のかを、後から読んで
 * 区別できるようにするため。
 */
function buildReviewPrompt(
  description: string,
  textInfo: string,
  reviewFacts: string,
  rules: readonly StickerReviewRule[],
): string {
  return [
    "# 材料1: 画像から抽出した文字情報（文字に関する基準はこれを根拠に判定すること）",
    textInfo,
    "",
    "# 材料2: 審査観点の事実列挙（権利・肖像・露出などはこれを根拠に判定すること）",
    reviewFacts,
    "",
    "# 材料3: 画像の見た目の概要（補助。※固有名詞は構造的に含まれないため権利判定の根拠にしない）",
    description,
    "",
    "# 検査基準（各行の ruleId をそのまま issue.ruleId に使うこと）",
    formatRulesForPrompt(rules),
    "",
    "# 指示",
    "上の3材料から読み取れる範囲で、各検査基準に抵触する点だけを issue として列挙してください。",
    "- **上の検査基準に挙がっているものだけ**を判定してください。ここに無い観点",
    "  （ブランド・実在人物・既存キャラ・露出・暴力・政治宗教・差別・ギャンブル・URL・文字だけの画像）は、",
    "  **別途プログラムが機械的に判定済み**です。重複して挙げないでください。",
    "- 写っているものの事実関係は、必ず「材料2」を根拠にする（材料3には固有名詞が含まれないため）。",
    "- 材料2で \"uncertain\" と書かれている項目は**指摘しない**（推測で断定しない）。",
    "- 抵触が無ければ issues を空配列にする。",
    "- ruleId は上記の基準に存在するものだけを使う（新しい id を作らない）。",
    "- severity は high / mid / low のいずれか。各基準に書かれた重大度に従うこと。",
    "- message は何が問題かの要旨（日本語・1文）。",
    "- evidence はどの材料のどの記述から判断したかの根拠（日本語）。",
    "- **この画像が審査に通るかどうかは書かないでください。** 合否はLINEの裁量です。",
    "",
    "# 出力形式（この JSON のみ・コードフェンス不要）",
    '{"issues":[{"ruleId":"...","severity":"high|mid|low","message":"...","evidence":"..."}]}',
  ].join("\n");
}

const SYSTEM_PROMPT =
  "あなたはLINEスタンプの審査ガイドラインに詳しい点検担当です。与えられた3つの材料（画像内の文字情報・審査観点の事実列挙・見た目の概要）を、指定された検査基準に照らして点検します。基準に照らして気になる点だけを issue として挙げ、確信が持てないものは挙げません。審査の合否は判定しません。前置き・説明は書かず、JSON だけを出力します。";

/**
 * 画像1枚を層Bで検査する。3材料の取得 → ルール照合の2段。
 * 失敗しても例外は投げず error に埋めて返す（1枚の失敗で全体を止めない・A4）。
 */
export async function reviewStickerImage(
  imagePath: string,
  rules: readonly StickerReviewRule[] = LINE_STICKER_REVIEW,
  signal?: AbortSignal,
  deps: StickerReviewDeps = DEFAULT_DEPS,
): Promise<StickerReviewResult> {
  try {
    // 3材料は互いに独立なので並列で取る。
    const [description, textInfo, rawFacts] = await Promise.all([
      deps.describeImage(imagePath),
      deps.extractText(imagePath),
      deps.reviewFacts(imagePath),
    ]);

    // ── 関所（A2）: AIの生出力を検証してから使う ──
    //
    // `reviewFacts` の契約は「未検証の生 JSON。パースは呼び出し側」。ここがその
    // 呼び出し側。**生文字列を次のAIへ渡す経路は残さない** — 整形は必ず
    // `formatReviewFactsForPrompt` を通し、検証を飛ばせない構造にする。
    // 壊れていれば throw し、下の catch がこの画像を error に落とす（部分失敗）。
    const facts = parseReviewFacts(rawFacts);

    // 判定できなかった項目（R3）。決定論ルールは uncertain を指摘しないので、
    // issues が0件でも「見えていない」だけの可能性がある。その差を持ち回る。
    const undetermined = undeterminedFactLabels(facts);

    // ── 決定論の判定（A6）: 一意に決まる規則はここで照合する ──
    const deterministicIssues = evaluateDeterministicRules(
      { facts, textAreaRatio: textInfo.textAreaRatio },
      rules,
      imagePath,
    );

    // ── AIの判定: 意味の解釈が要る規則だけを渡す ──
    //
    // 決定論側で判定済みの ruleId をプロンプトから外す。残したままだと、AIが
    // 同じ事実で二重に指摘し、決定論の結果と食い違ったときにどちらが正か決まらない。
    const aiRules = rules.filter((r) =>
      (AI_JUDGED_RULE_IDS as readonly string[]).includes(r.id),
    );

    // AI が担当するルールが1つも無ければ、AIを呼ばずに決定論の結果だけを返す
    // （呼び出し側がルールを絞り込んだ場合。無駄な Codex 実行とコストを避ける）。
    if (aiRules.length === 0) {
      return { imagePath, issues: deterministicIssues, error: null, undetermined };
    }

    const prompt = buildReviewPrompt(
      description,
      textInfo.prompt,
      formatReviewFactsForPrompt(facts),
      aiRules,
    );
    const res = await deps.query({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      expectJson: true,
      timeoutSecs: 180,
      signal,
    });

    const validRuleIds = new Set(aiRules.map((r) => r.id));
    const parsed = res.parsedJson;
    let raw: unknown = null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const issues = (parsed as Record<string, unknown>).issues;
      if (Array.isArray(issues)) raw = issues;
    } else if (Array.isArray(parsed)) {
      // issues キーで包まず配列そのものを返すケースも拾う（既存 check.ts と同じ許容）。
      raw = parsed;
    }
    if (raw === null) {
      // JSON としては妥当だが形が違う（{} / {"issues":"wrong"} / null 等）。
      // 空配列（＝問題なし）と取り違えないよう検査失敗として扱う（no-silent-gap-filling）。
      throw new Error(
        "検査結果の形式が不正です（issues 配列が見つかりません）。もう一度お試しください。",
      );
    }

    // 未信頼入力の検証は既存 normalizeIssues に委ねる（ruleId 実在・severity 妥当・壊れ出力の throw）。
    const normalized = normalizeIssues(raw, imagePath, validRuleIds);
    const byId = new Map(aiRules.map((r) => [r.id, r]));
    const aiIssues = normalized.map((issue) => {
      const rule = byId.get(issue.ruleId);
      // normalizeIssues が validRuleIds で弾いた後なので rule は必ず取れる。
      return rule ? clampSeverity(issue, rule) : issue;
    });

    // 決定論を先に並べる（事実の当てはめ → 解釈、の順で読める）。
    return {
      imagePath,
      issues: [...deterministicIssues, ...aiIssues],
      error: null,
      undetermined,
    };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // error のときは undetermined を語らない（材料を最後まで読めていないため、
    // 「何が判定できなかったか」自体が分からない）。UI は error を優先表示する。
    return { imagePath, issues: [], error: message, undetermined: [] };
  }
}

/**
 * 層Bを一式に対して実行する。
 *
 * **呼び出してよいのは「申請用に書き出す」経路だけ**（設計書 §1.1 / A6）。
 * 自分用に使う人にAI検査のコストを払わせない。この関数は自分では経路を判別できないため、
 * 呼び出し側が mode: "submission" のときにだけ呼ぶ責務を持つ。
 */
export async function reviewStickerSet(
  imagePaths: readonly string[],
  rules: readonly StickerReviewRule[] = LINE_STICKER_REVIEW,
  signal?: AbortSignal,
  deps: StickerReviewDeps = DEFAULT_DEPS,
): Promise<StickerReviewReport> {
  const targets: string[] = [];
  const excluded: { imagePath: string; reason: string }[] = [];
  for (const p of imagePaths) {
    const reason = EXCLUDED_BASENAMES.get(basename(p).toLowerCase());
    if (reason) excluded.push({ imagePath: p, reason });
    else targets.push(p);
  }

  const results = await runReviewsWithLimit(targets, rules, signal, deps);

  return { results, disclaimer: REVIEW_DISCLAIMER, excluded };
}

/**
 * 同時に走らせる検査の数（L5 / 2026-08-05 STΛCK実機FB「確認が遅い」）。
 *
 * ## なぜ直列をやめたか
 *
 * 旧実装は「層Bは effort を上げた vision を含み、並列に投げると Codex 側で詰まる」
 * という理由で完全な直列だった。詰まりを避ける判断は正しいが、**1本ずつ**は
 * 反対側へ振り切りすぎている。40枚を1枚あたり十数秒で回すと、待ち時間が
 * 人の集中の持続を超える（実機で体感された遅さの主因）。
 *
 * ## なぜ 3 か
 *
 * 「詰まらせない」と「待たせない」の折衷。無制限（`Promise.all` で40本同時）は
 * 旧コメントが警告している詰まりをそのまま踏む。3 なら同時実行は常に少数に留まり、
 * それでいて所要時間は直列の 1/3 程度になる。
 *
 * **詰まる実測が出たら 1 に戻せる**（1 にすると旧来の直列と同じ挙動になる）。
 * そのために定数を1箇所に置き、上限の意味を持たない分岐を作らない。
 */
export const REVIEW_CONCURRENCY = 3;

/**
 * 上限つきの並列で検査を回し、**入力順のまま**結果を返す。
 *
 * ## 順序を保つ（最重要）
 *
 * 完了順に `push` すると、速く終わった画像から並ぶ。画面の一覧は番号順に
 * 読まれる前提なので、順序が揺れると「どの絵の指摘か」を人が追えなくなる。
 * 結果は**添字で確定した場所へ書く**（完了順に依存しない）。
 *
 * ## 中断（AbortSignal）
 *
 * `signal` は各 `reviewStickerImage` へそのまま渡っており、途中で中断されれば
 * 実行中のものは各自で終わる。ここでは**まだ始めていないものを始めない** —
 * 中断後に新しい Codex 実行を起こさないための、ワーカー入口での確認。
 *
 * ## 例外を投げない
 *
 * `reviewStickerImage` は自分で try/catch して `error` 付きの結果を返す契約なので、
 * 1枚の失敗で `Promise.all` 全体が落ちることはない。契約が変わったときに
 * 黙って全滅しないよう、ここでも保険の catch を置いて**その1枚だけ**を error にする。
 */
async function runReviewsWithLimit(
  targets: readonly string[],
  rules: readonly StickerReviewRule[],
  signal: AbortSignal | undefined,
  deps: StickerReviewDeps,
): Promise<StickerReviewResult[]> {
  const results = new Array<StickerReviewResult>(targets.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= targets.length) return;
      // 中断されたら新しい実行を始めない（走り出したものは各自で終わる）。
      if (signal?.aborted) {
        results[index] = {
          imagePath: targets[index],
          issues: [],
          error: "検査を中断しました。",
          undetermined: [],
        };
        continue;
      }
      try {
        results[index] = await reviewStickerImage(targets[index], rules, signal, deps);
      } catch (err) {
        // reviewStickerImage は自分で catch する契約だが、破れても全滅させない。
        results[index] = {
          imagePath: targets[index],
          issues: [],
          error: (err as Error)?.message ?? String(err),
          undetermined: [],
        };
      }
    }
  };

  const lanes = Math.max(1, Math.min(REVIEW_CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return results;
}

/** 層Bの結果をクリップボード用のプレーンテキストへ整形する。 */
export function formatReviewAsText(report: StickerReviewReport): string {
  const sevLabel: Record<RegulationSeverity, string> = {
    high: "要確認",
    mid: "気になる",
    low: "軽微",
  };
  const lines: string[] = ["LINEスタンプ 審査セルフチェック結果", ""];

  for (const r of report.results) {
    lines.push(`■ ${basename(r.imagePath)}`);
    if (r.error) {
      lines.push(`  検査エラー: ${r.error}`);
    } else if (r.issues.length === 0 && r.undetermined.length === 0) {
      lines.push("  気になる点は見つかりませんでした");
    } else {
      for (const issue of r.issues) {
        const name = LINE_STICKER_REVIEW_BY_ID.get(issue.ruleId)?.name ?? issue.ruleId;
        lines.push(`  [${sevLabel[issue.severity]}] ${name}: ${issue.message}`);
        if (issue.evidence) lines.push(`    根拠: ${issue.evidence}`);
      }
      // 未判定は「該当なし」ではない（R3）。コピーした控えでも区別できるようにする。
      if (r.undetermined.length > 0) {
        lines.push(
          `  一部を判定できませんでした（${r.undetermined.join(" / ")}）。目視で確認してください`,
        );
      }
    }
    lines.push("");
  }

  for (const e of report.excluded) {
    lines.push(`■ ${basename(e.imagePath)}`);
    lines.push(`  ${e.reason}`);
    lines.push("");
  }

  lines.push(report.disclaimer);
  return lines.join("\n").trimEnd();
}
