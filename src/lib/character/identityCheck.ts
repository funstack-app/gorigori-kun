/**
 * 同一性検品フック(プラガブル・interface のみ)。
 *
 * 参照画像と生成した全カットが「同一人物か」を採点する差し込み口。実採点ロジック
 * (顔埋め込み / ローカル照合 / codex vision) は S5 で別調査中のため、本スライスは
 * interface と差し込み位置だけ固め、実装は Noop(score 付与なし)で通す。
 *
 * `.claude/rules/no-silent-gap-filling.md` 準拠: 検品できないカットは identityScore を
 * undefined のまま登録し「未検品」を可視化する(もっともらしく埋めない)。
 * 将来 IdentityChecker の実装を差し替えるだけで採点を追加できる(呼び出し側は不変)。
 */

export type IdentityCheckResult = {
  /** 全体の同一性スコア 0-100。未実装/失敗時は undefined(欠落を可視化)。 */
  score?: number;
  /** カット別スコア(cutId -> 0-100)。低いカットの再生成判断に使う。 */
  perCut?: Record<string, number>;
  /** 検品の総合判定。 */
  verdict: "verified" | "needs_review" | "unavailable";
  /** 検品を通した日時(epoch ms)。characterMeta.verifiedAt に入る。未検品は undefined。 */
  checkedAt?: number;
};

export interface IdentityChecker {
  check(
    sourceImage: string,
    sheetImages: { cutId: string; path: string }[],
  ): Promise<IdentityCheckResult>;
}

/**
 * S5 未完のあいだの既定チェッカー。常に unavailable を返し、score/perCut は付けない。
 * 「未検品」を可視化するための実装(欠落を欠落のまま返す)。
 */
export class NoopIdentityChecker implements IdentityChecker {
  async check(
    _sourceImage: string,
    _sheetImages: { cutId: string; path: string }[],
  ): Promise<IdentityCheckResult> {
    return { verdict: "unavailable" };
  }
}

/** 現在の既定チェッカー。実装差し替え時はここを変える(呼び出し側は不変)。 */
export const defaultIdentityChecker: IdentityChecker = new NoopIdentityChecker();
