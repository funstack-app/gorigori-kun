import type { FontInfo } from "./types";

/**
 * 元画像のテキストの書体特徴。OCR結果とテキストレイヤーのプロパティから決定論で組み立てる。
 * 完全一致は狙わない（gap-audit G3）。近い候補を上位に出し、外れたら「AI差し替え」へ誘導する前提。
 */
export type FontMatchHint = {
  /** OCR由来の言語（"ja" / "en" 等）。FontInfo.languageTags と突き合わせる。 */
  language?: string | null;
  /** 太字か。FontInfo.style の "Bold" と突き合わせる。 */
  bold?: boolean;
  /** セリフ体（明朝）か。null は不明。family名から推定した値を渡す。 */
  serif?: boolean | null;
};

const SERIF_MARKERS = ["serif", "mincho", "明朝", "song", "宋", "times", "georgia"];
const SANS_MARKERS = ["sans", "gothic", "ゴシック", "arial", "helvetica", "meiryo", "メイリオ", "noto sans"];

/** family / displayName からセリフ体かどうかを推定する。判定できなければ null。 */
export function guessSerif(font: Pick<FontInfo, "family" | "displayName">): boolean | null {
  const hay = `${font.family} ${font.displayName}`.toLowerCase();
  const isSerif = SERIF_MARKERS.some((m) => hay.includes(m));
  const isSans = SANS_MARKERS.some((m) => hay.includes(m));
  if (isSerif && !isSans) return true;
  if (isSans && !isSerif) return false;
  return null;
}

/**
 * font が hint にどれだけ近いかを 0..100 で採点する。決定論・純関数。
 * 高いほど近い。要素ごとの加点で、一致しない軸は減点でなく加点なしにして安定させる。
 */
export function scoreFont(font: FontInfo, hint: FontMatchHint): number {
  let score = 0;

  // 言語一致（最重要・40点）。hint.language 未指定なら中立で加点しない。
  if (hint.language) {
    const lang = hint.language.toLowerCase();
    if (font.languageTags.some((t) => t.toLowerCase() === lang)) score += 40;
  }

  // 太さ一致（30点）。style に "bold" を含むか。
  if (hint.bold !== undefined) {
    const styleBold = font.style.toLowerCase().includes("bold");
    if (styleBold === hint.bold) score += 30;
  }

  // セリフ一致（30点）。hint.serif も font 側も推定できたときだけ評価。
  if (hint.serif !== undefined && hint.serif !== null) {
    const fontSerif = guessSerif(font);
    if (fontSerif !== null && fontSerif === hint.serif) score += 30;
  }

  return score;
}

/**
 * fonts を hint への近さで降順に並べる。純関数（入力を破壊しない）。
 * 同点は元の並び順（family昇順を前提）を保つ安定ソート。
 * system-ui は「近似候補」からは除外する（既定であって書体近似の対象ではない）。
 */
export function rankFonts(fonts: FontInfo[], hint: FontMatchHint): FontInfo[] {
  return fonts
    .filter((f) => f.family !== "system-ui")
    .map((font, index) => ({ font, index, score: scoreFont(font, hint) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((x) => x.font);
}

/**
 * 近似候補の上位 limit 件を返す。スコア0（何も一致しない）候補は候補に含めない
 * ——「近い」と偽って提示しないため（張りぼて防止・gap-audit「外れたらAI差し替え」）。
 */
export function suggestFonts(fonts: FontInfo[], hint: FontMatchHint, limit = 3): FontInfo[] {
  return rankFonts(fonts, hint)
    .filter((f) => scoreFont(f, hint) > 0)
    .slice(0, limit);
}
