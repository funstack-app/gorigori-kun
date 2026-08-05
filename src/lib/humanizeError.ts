/**
 * トーストに出す前に、生のエラー文字列 (Tauri 権限エラー等) を
 * 人間向けの簡潔なメッセージに変換する。
 *
 * 生エラーをそのまま出すと
 * 「... fs.write_text_file not allowed. Permissions associated with this command: ...」
 * のような長文がトーストにあふれて読めない。代表的なケースを固定文言にする。
 */
/**
 * クレジット/利用枠の不足を示す語。
 *
 * 判定語は `src/lib/scene/retryClassify.ts` の PERMANENT_KEYWORDS クレジット節、
 * および Rust 側 `codex::process::humanize_generation_failure` のクレジット分岐と
 * 同じ語彙で揃える (恒久的失敗としてリトライ対象から外す分類・Rust 側の日本語化・
 * フロントのトースト表示の3箇所が、同じ語で同じ判断をするようにするため)。
 */
const CREDIT_SHORTAGE_PATTERN =
  /not_enough_credits|not enough credits|insufficient_credits|insufficient credits|insufficient_quota|out of credits|クレジットが不足|クレジット不足/i;

export function humanizeError(err: unknown): string {
  const raw = String(err);
  // クレジット不足を最優先で判定する。`not_enough_credits` は下の
  // `not found` パターン(`not` + 任意)には掛からないが、将来の文言変化で
  // 権限・不明ファイル分岐に吸われると「枠切れなのにファイルが無い」と
  // 誤案内するため、順序で守る。
  if (CREDIT_SHORTAGE_PATTERN.test(raw)) {
    return "AIの利用枠(クレジット)が不足しています。作成済みのデータはすべて残っています。設定 → アカウントで残量を確認するか、時間をおいてからもう一度お試しください。";
  }
  if (/not allowed|forbidden|permission|scope/i.test(raw)) {
    return "保存先の権限がありません。設定 → 保存先で保存先を確認してください。";
  }
  if (/no such file|not found|enoent/i.test(raw)) {
    return "ファイルが見つかりませんでした。";
  }
  // 上記以外は 1 行に丸めて出す (改行・連続空白を畳んで長すぎる場合は切る)。
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}
