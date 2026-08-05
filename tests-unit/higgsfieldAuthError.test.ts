import { describe, expect, it } from "vitest";
import {
  HIGGSFIELD_REAUTH_MESSAGE,
  isHiggsfieldAuthError,
  toHiggsfieldAuthMessage,
} from "../src/lib/higgsfieldAuthError";

/**
 * bd p20 (2026-08-04): 動画生成の失敗理由に生 RPC 文字列を出さないための検査。
 *
 * 最重要は「認証切れを拾えること」ではなく **「認証切れ以外を握り潰さないこと」**。
 * 誤検知すると NSFW 判定・モデル制限といった有用な理由が
 * 「再接続してください」に化けて、ユーザーが永久に原因に辿り着けなくなる。
 */
describe("isHiggsfieldAuthError", () => {
  it("STΛCK 実機で観測された invalid_grant 文言を認証切れと判定する", () => {
    expect(
      isHiggsfieldAuthError(
        "OAuth token refresh failed: invalid_grant (refresh token was issued to another client)",
      ),
    ).toBe(true);
  });

  it("codex 側の文言揺れ (代表パターン) を拾う", () => {
    const variants = [
      "invalid_grant",
      "Error: refresh token was issued to another client",
      "OAuth token refresh failed",
      "token refresh failed: bad state",
      "refresh token is expired",
      "refresh token has been revoked",
      "unauthorized_client",
    ];
    for (const v of variants) {
      expect(isHiggsfieldAuthError(v), `should match: ${v}`).toBe(true);
    }
  });

  it("生成そのものの失敗理由を認証切れと誤判定しない (最重要)", () => {
    const notAuth = [
      "NSFW content detected",
      "この内容は生成できません (制限コンテンツ)",
      "model does not support 1080p for this aspect ratio",
      "insufficient credits",
      "job failed: timeout while polling",
      "aspect ratio 21:9 is not supported",
      "動画生成に失敗しました",
      "",
      null,
      undefined,
    ];
    for (const v of notAuth) {
      expect(isHiggsfieldAuthError(v), `should NOT match: ${String(v)}`).toBe(false);
    }
  });
});

describe("toHiggsfieldAuthMessage", () => {
  it("認証切れが混ざっていれば固定文言 1 本に畳む", () => {
    const result = toHiggsfieldAuthMessage([
      "OAuth token refresh failed: invalid_grant (refresh token was issued to another client)",
      "OAuth token refresh failed: invalid_grant (refresh token was issued to another client)",
    ]);
    expect(result.isAuthError).toBe(true);
    expect(result.message).toBe(HIGGSFIELD_REAUTH_MESSAGE);
    // 生 RPC 文字列が一切漏れないこと
    expect(result.message).not.toMatch(/invalid_grant|another client|OAuth/i);
  });

  it("認証切れ以外は呼び出し側の従来処理へ委ねる (message を出さない)", () => {
    const result = toHiggsfieldAuthMessage(["NSFW content detected"]);
    expect(result.isAuthError).toBe(false);
    expect(result.message).toBeNull();
  });

  it("理由が空でも落ちない", () => {
    expect(toHiggsfieldAuthMessage([]).isAuthError).toBe(false);
  });

  it("固定文言は再接続の場所を示している (行き止まりにしない)", () => {
    expect(HIGGSFIELD_REAUTH_MESSAGE).toContain("設定");
    expect(HIGGSFIELD_REAUTH_MESSAGE).toContain("再接続");
  });
});
