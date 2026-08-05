// 画像生成の失敗理由を「一時的失敗（リトライで直る可能性あり）」と
// 「恒久的失敗（リトライしても無駄）」に分類する純関数群。
//
// FB#18 (2026-06-06): ユーザー報告「失敗が多い、条件で成功失敗が混在」。
// 一時的なネットワーク/タイムアウト/混雑由来の失敗は自動リトライで救えるが、
// NSFW 等のコンテンツ判定・クレジット不足・パラメータ不正は何度試しても
// 同じ理由で弾かれる。後者をリトライ対象から除外して、ユーザーには理由を
// そのまま提示する。
//
// 分類根拠は Rust 側 (src-tauri/src/commands/higgsfield.rs の
// translate_higgsfield_error / extract_failure_reason) が返す文言と、
// codex 経由 (batch_gen.rs) の WorkerFailed エラー文言。決定論なので
// 純関数にし、LLM を介さない。

/**
 * 恒久的失敗（リトライしても結果が変わらない）を示すキーワード。
 * 日本語（翻訳済み文言）と英語（CLI/API 生エラー）の両方を含む。
 * すべて小文字で比較する。
 */
const PERMANENT_KEYWORDS: readonly string[] = [
  // ── NSFW / コンテンツ安全フィルター ──
  "nsfw",
  "moderat", // moderated / moderation / content_moderation
  "content policy",
  "content_moderation",
  "safety",
  "rejected",
  "安全フィルター",
  "コンテンツ判定",
  "性的表現",
  "暴力",
  // ── クレジット不足（補充するまで直らない＝同一プロンプトの即時リトライでは無駄）──
  // 語彙は `src/lib/humanizeError.ts` の CREDIT_SHORTAGE_PATTERN および Rust 側
  // `codex::process::humanize_generation_failure` のクレジット分岐と揃える。
  // ズレると「リトライしないのに英語のまま」「日本語化されるのにリトライされる」
  // という中途半端な状態になる（tests-unit/creditShortageMessage.test.ts で固定）。
  "not_enough_credits",
  "not enough credits",
  "insufficient_credits",
  "insufficient credits",
  "insufficient_quota",
  "out of credits",
  "クレジットが不足",
  "クレジット不足",
  // ── パラメータ不正（アプリ側バグ。リトライしても同じ）──
  "unknown params",
  "invalid values",
  "パラメータが不正",
  "生成パラメータが不正",
  // ── プロンプト未入力（入力を変えるまで直らない）──
  "valid string",
  "プロンプトが空",
  // ── 認証切れ（再ログインするまで直らない）──
  "unauthorized",
  "not authenticated",
  "認証が切れ",
  "認証切れ",
];

/**
 * 1 件のエラー文字列が恒久的失敗かどうかを判定する。
 * マッチしなければ一時的失敗（＝リトライ可）とみなす。
 */
export function isPermanentFailure(error: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return PERMANENT_KEYWORDS.some((kw) => lower.includes(kw));
}

export type RetryDecision = {
  /** リトライしてよいか（一時的失敗が 1 件以上ある）。 */
  shouldRetry: boolean;
  /** 全失敗が恒久的だったか（リトライ無意味）。 */
  allPermanent: boolean;
  /** 恒久的失敗の理由（重複除去済み・ユーザー表示用）。 */
  permanentReasons: string[];
  /** 一時的失敗の理由（重複除去済み・ログ用）。 */
  temporaryReasons: string[];
};

/**
 * 失敗理由の配列から、リトライすべきかを決める。
 *
 * - 失敗理由が空（errors を取得できなかった codex 経路など）でも、
 *   `hasFailure` が true なら「分類不能の一時的失敗」として 1 回はリトライさせる。
 *   なぜ: codex/image_gen 経路は IPC 結果に errors を載せないため理由が取れない。
 *   原因不明の失敗はネットワーク/混雑由来が多く、リトライで救える確率が高い。
 *
 * @param errors    失敗理由文字列（空配列の場合あり）
 * @param hasFailure 実際に失敗が発生したか（failedCount > 0 など）
 */
export function classifyFailures(
  errors: readonly string[],
  hasFailure: boolean,
): RetryDecision {
  const cleaned = errors.map((e) => e.trim()).filter((e) => e.length > 0);

  if (cleaned.length === 0) {
    // 理由不明の失敗。失敗が起きていれば一時的失敗扱いでリトライ可。
    return {
      shouldRetry: hasFailure,
      allPermanent: false,
      permanentReasons: [],
      temporaryReasons: [],
    };
  }

  const permanent: string[] = [];
  const temporary: string[] = [];
  for (const reason of cleaned) {
    if (isPermanentFailure(reason)) {
      permanent.push(reason);
    } else {
      temporary.push(reason);
    }
  }

  const dedupe = (arr: string[]): string[] => Array.from(new Set(arr));
  const permanentReasons = dedupe(permanent);
  const temporaryReasons = dedupe(temporary);
  const allPermanent = temporary.length === 0 && permanent.length > 0;

  return {
    // 一時的失敗が 1 件でもあればリトライする。
    shouldRetry: temporary.length > 0,
    allPermanent,
    permanentReasons,
    temporaryReasons,
  };
}
