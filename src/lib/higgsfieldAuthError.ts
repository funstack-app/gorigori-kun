/**
 * Higgsfield (リモート MCP) の認証切れエラーを、ユーザーが次に何をすればいいか
 * 分かる日本語に変換する。
 *
 * ## なぜこれが要るか (2026-08-04 / bd p20)
 *
 * トークン更新に失敗すると、MCP 層の生 RPC 文字列がそのまま
 * 動画生成の「失敗理由」としてユーザーに表示されていた:
 *
 *   OAuth token refresh failed: invalid_grant (refresh token was issued to
 *   another client)
 *
 * これは (a) 英語で意味が分からない、(b) 次にやること (再接続) が書かれていない、
 * の 2 点でユーザーを行き止まりにする。生成そのものの失敗 (NSFW 判定・モデル制限
 * 等、モデル側が返す理由) とは性質が違い、**プロンプトを変えても直らない**ため、
 * 再試行ガイドを出すのも誤りになる。
 *
 * そこで認証切れだけを検出して固定文言 + 再接続導線に差し替える。
 * 認証切れ以外の理由は情報量があるので**従来どおりそのまま**通す。
 */

/** 認証切れと判定したときに表示する固定文言 (設定画面の「接続」へ誘導する)。 */
export const HIGGSFIELD_REAUTH_MESSAGE =
  "Higgsfieldの接続が切れています。設定から再接続してください。";

/**
 * 認証切れ (トークン失効・更新失敗) を示す文字列かどうか。
 *
 * `invalid_grant` は OAuth の失効系エラーコードで、refresh token が無効・期限切れ・
 * 別クライアント発行のいずれでも返る。`issued to another client` はその具体ケース。
 * codex 側の文言が版によって揺れるため、代表パターンを幅広く拾う。
 */
export function isHiggsfieldAuthError(reason: unknown): boolean {
  const raw = String(reason ?? "");
  if (!raw) return false;
  return (
    /invalid_grant/i.test(raw) ||
    /issued to another client/i.test(raw) ||
    /(oauth|token)[^\n]{0,40}refresh failed/i.test(raw) ||
    /refresh token[^\n]{0,40}(invalid|expired|revoked)/i.test(raw) ||
    /unauthorized_client/i.test(raw)
  );
}

/**
 * 失敗理由の配列から、認証切れなら固定文言 1 本に畳んだ結果を返す。
 *
 * - 認証切れが 1 件でも含まれる → `{ isAuthError: true, message: 固定文言 }`
 *   (同じ原因で全件失敗するため、生文字列を並べても読み手の助けにならない)
 * - 含まれない → `{ isAuthError: false, message: null }` で呼び出し側の従来処理へ
 */
export function toHiggsfieldAuthMessage(
  reasons: readonly unknown[],
): { isAuthError: boolean; message: string | null } {
  const hit = reasons.some((r) => isHiggsfieldAuthError(r));
  return hit
    ? { isAuthError: true, message: HIGGSFIELD_REAUTH_MESSAGE }
    : { isAuthError: false, message: null };
}
