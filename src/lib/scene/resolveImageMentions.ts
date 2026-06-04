/**
 * プロンプト中の `@imgN` メンションを実際の参照画像パスに解決する。
 *
 * 背景 (2026-06-04):
 * 旧実装では `@img1` は textarea 上の飾りでしかなく、プロンプト本文に
 * `@img1` という文字列がそのまま残ってモデルへ送られていた。画像選択には
 * 一切効かず、AI へのノイズになっていた (STΛCK 指摘)。
 *
 * このユーティリティは送信直前に呼び、以下を行う:
 * 1. プロンプト中の `@img1`〜`@imgN` を検出する
 * 2. マッチした番号に対応する参照画像 (references[n-1]) を「使う画像」に選ぶ
 * 3. プロンプトからは `@imgN` 文字列を取り除く (AI にノイズを送らない)
 *
 * 設計判断:
 * - メンションが1つも無ければ `mentioned` は空配列を返し、呼び出し側は
 *   従来どおり (参照ラック全部 / sourceImage) のフォールバックを使う。
 * - 範囲外の番号 (@img9 だが参照は2枚) は無視する。存在しない画像を
 *   渡してモデル側エラーになるのを防ぐ。
 * - 重複 (@img1 を2回書く) は1回に正規化する。順序は本文中の登場順。
 */

/** `@imgN` の N は 1 始まり。references は 0 始まりなので -1 して引く。 */
const MENTION_PATTERN = /@img(\d+)/g;

export type MentionRef = {
  path: string;
  name: string;
};

export type ResolveImageMentionsResult = {
  /** `@imgN` を取り除いた後のプロンプト本文 (前後・連続空白を正規化済み) */
  cleanedPrompt: string;
  /**
   * 本文で実際に参照された画像 (登場順・重複排除・範囲外除外)。
   * 1つでもあれば呼び出し側はこれを使う。空なら従来フォールバック。
   */
  mentioned: MentionRef[];
  /** 本文に1つでも `@imgN` 記法があったか (範囲外含む) */
  hadMention: boolean;
};

/**
 * @param prompt    ユーザーが書いたプロンプト本文
 * @param references 参照ラックの画像 (登録順 = @img1, @img2, ...)
 */
export function resolveImageMentions(
  prompt: string,
  references: readonly MentionRef[],
): ResolveImageMentionsResult {
  const mentioned: MentionRef[] = [];
  const seenPaths = new Set<string>();
  let hadMention = false;

  // 登場順を保つため matchAll で走査する。
  for (const match of prompt.matchAll(MENTION_PATTERN)) {
    hadMention = true;
    const n = Number.parseInt(match[1], 10);
    // n は 1 始まり。範囲外 (0 / 参照数超過) は無視する。
    if (!Number.isInteger(n) || n < 1 || n > references.length) {
      continue;
    }
    const ref = references[n - 1];
    if (seenPaths.has(ref.path)) {
      continue;
    }
    seenPaths.add(ref.path);
    mentioned.push({ path: ref.path, name: ref.name });
  }

  const cleanedPrompt = stripMentions(prompt);

  return { cleanedPrompt, mentioned, hadMention };
}

/**
 * プロンプトから `@imgN` を除去し、除去で生じた余分な空白を整える。
 * - `@imgN` を空文字に置換
 * - 連続スペースを1つに
 * - 句読点前の空白 (" ,") を詰める
 * - 前後 trim
 */
function stripMentions(prompt: string): string {
  return prompt
    .replace(MENTION_PATTERN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.、。])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}
