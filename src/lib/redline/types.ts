/**
 * 赤入れ反映スキルの型定義。
 *
 * クライアントの赤入れ（注釈付き画像）を AI に解釈させ、
 * 「どこを・何と・どう直すか」の構造化リストにする。
 * 設計参考: _work/gori-skill-design/ai-image-video-taxonomy.md
 *   「赤入れ反映スキルへの示唆」— 読む→指す→直す→検品 の4段。
 *
 * この型は「読む」「指す（領域の言語化まで）」の出力を表す。
 * 「直す」は各指示を編集タブへ受け渡す（RedlineWorkspace 側）。
 */

/** 修正種別。赤入れでよくある4パターン + その他。 */
export type RedlineFixKind =
  | "remove" // 消す（不要な要素の削除）
  | "replace" // 置き換える（別の要素・画像に差し替え）
  | "adjust" // 直す（位置・色・サイズ等の調整）
  | "text" // 文字修正（誤字・文言差し替え）
  | "other"; // 上記に当てはまらない / 判別不能

/** 修正種別の日本語ラベル（UI 表示用）。 */
export const REDLINE_FIX_KIND_LABEL: Record<RedlineFixKind, string> = {
  remove: "消す",
  replace: "置き換える",
  adjust: "直す",
  text: "文字修正",
  other: "その他",
};

/** 有効な修正種別かを判定する（AI 出力の正規化に使う）。 */
export function isRedlineFixKind(value: unknown): value is RedlineFixKind {
  return (
    value === "remove" ||
    value === "replace" ||
    value === "adjust" ||
    value === "text" ||
    value === "other"
  );
}

/**
 * 1件の修正指示。
 *
 * no-silent-gap-filling の原則に従い、AI が指示を確信できない場合は
 * ambiguous=true にし、推測で埋めない（UI で「要確認」バッジを出す）。
 */
export type RedlineInstruction = {
  /** 通し番号（1始まり）。UI のカード見出しに使う。 */
  number: number;
  /** 対象領域の説明（位置を言葉で。例: 「右上のロゴ付近」）。 */
  areaDescription: string;
  /** 指示内容（何をどう直すか）。 */
  instruction: string;
  /** 修正種別。 */
  fixKind: RedlineFixKind;
  /** 曖昧さフラグ。true なら「要確認」（推測で埋めていない）。 */
  ambiguous: boolean;
  /** 曖昧な理由（ambiguous=true のとき AI が付す。任意）。 */
  ambiguityReason?: string;
};

/** AI 解釈の結果セット。 */
export type RedlineResult = {
  /** 抽出した修正指示の一覧。 */
  instructions: RedlineInstruction[];
  /**
   * AI が全体について添えた所見（任意）。
   * 「赤入れが薄くて読めない箇所がある」等のメタ情報。
   */
  overallNote?: string;
};
