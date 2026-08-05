/**
 * トーストに出す前に、生のエラー文字列 (Tauri 権限エラー等) を
 * 人間向けの簡潔なメッセージに変換する。
 *
 * 生エラーをそのまま出すと
 * 「... fs.write_text_file not allowed. Permissions associated with this command: ...」
 * のような長文がトーストにあふれて読めない。代表的なケースを固定文言にする。
 */
export function humanizeError(err: unknown): string {
  const raw = String(err);
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
