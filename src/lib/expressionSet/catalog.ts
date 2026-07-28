/**
 * 表情差分スキルの表情カタログ（スキル一覧v2.1 #2・MVP）。
 *
 * 登録済みキャラ（kind === "character" のプリセット）に対し、同一人物・アングル固定で
 * 「表情だけ」を差し替えた差分セットを一括生成するためのカタログ。
 *
 * character/sheetCuts.ts の expression 系カット（bust close-up・same face・change only
 * the expression）と同じ思想で、promptFragment は「顔の同一性を最優先し、表情のみ変える」
 * ことを英語で明示する。cutId は character_sheet_run の出力ファイル名／sheetRoles キーに使う
 * ため、character 側と衝突しない `expr-` プレフィックスで一意化する。
 *
 * role は生成カットを識別するための値（Rust 側は role をそのままイベントに載せて返すだけ）。
 */

export type Expression = {
  /** 一意ID。生成カットのキー・出力ファイル名に使う（expr- プレフィックスで衝突回避）。 */
  id: string;
  /** UI 表示名（日本語）。 */
  label: string;
  /** 生成カットの role 値。 */
  role: string;
  /** 表情のみを変える英語プロンプト断片。アングル固定・顔の同一性最優先を明示する。 */
  promptFragment: string;
};

/** 全カット共通で先頭に付ける固定文言。アングルを固定し「表情のみ変更」を強制する。
 * 画風保持句を含む（2026-07-29 実機FB: 「studio lighting」等の実写語彙だけで画風指示が
 * 無かったため、アニメ調キャラが写実側へ化けていた）。 */
export const EXPRESSION_PROMPT_PREFIX =
  "bust close-up, eye level, straight front view, same person, identical face and hairstyle, same outfit, fixed camera angle, same art style as the reference image — keep the original drawing style, linework, coloring and rendering exactly, do not photorealize, flat even lighting, plain light-gray background";

/**
 * 基本5種の表情。既定でチェックが入る（DEFAULT_EXPRESSION_IDS）。
 * 「同一人物・アングル固定・表情のみ変更」を promptFragment で明示する。
 */
const BASE_EXPRESSIONS: Expression[] = [
  {
    id: "expr-smile",
    label: "笑顔",
    role: "expression-smile",
    promptFragment: "natural warm smile, eyes slightly narrowed, change only the expression",
  },
  {
    id: "expr-angry",
    label: "怒り",
    role: "expression-angry",
    promptFragment: "angry expression, brows furrowed, mouth tense, change only the expression",
  },
  {
    id: "expr-sad",
    label: "悲しみ",
    role: "expression-sad",
    promptFragment: "sad expression, downturned mouth, sorrowful soft eyes, change only the expression",
  },
  {
    id: "expr-surprised",
    label: "驚き",
    role: "expression-surprised",
    promptFragment: "surprised expression, wide open eyes, raised brows, open mouth, change only the expression",
  },
  {
    id: "expr-shy",
    label: "照れ",
    role: "expression-shy",
    promptFragment: "shy bashful expression, faint blush on cheeks, small closed-mouth smile, change only the expression",
  },
];

/** 追加候補の表情。チェックリストで任意に足せる（既定は未選択）。 */
const EXTRA_EXPRESSIONS: Expression[] = [
  {
    id: "expr-neutral",
    label: "真顔",
    role: "expression-neutral",
    promptFragment: "calm neutral expression, mouth closed, relaxed brows, change only the expression",
  },
  {
    id: "expr-wink",
    label: "ウインク",
    role: "expression-wink",
    promptFragment: "playful wink, one eye closed, light smile, change only the expression",
  },
  {
    id: "expr-cry",
    label: "泣き",
    role: "expression-cry",
    promptFragment: "crying expression, teary eyes with tears, downturned trembling mouth, change only the expression",
  },
  {
    id: "expr-laugh",
    label: "大笑い",
    role: "expression-laugh",
    promptFragment: "big open-mouth laugh, eyes crinkled shut, joyful, change only the expression",
  },
  {
    id: "expr-troubled",
    label: "困り顔",
    role: "expression-troubled",
    promptFragment: "troubled worried expression, slanted brows, faint awkward smile, change only the expression",
  },
  {
    id: "expr-serious",
    label: "真剣",
    role: "expression-serious",
    promptFragment: "serious determined expression, firm gaze, closed mouth, change only the expression",
  },
];

/** 全表情カタログ（基本5種 + 追加候補）。 */
export const EXPRESSIONS: Expression[] = [...BASE_EXPRESSIONS, ...EXTRA_EXPRESSIONS];

/** 既定でチェックが入る表情ID（基本5種）。 */
export const DEFAULT_EXPRESSION_IDS: string[] = BASE_EXPRESSIONS.map((e) => e.id);

/** id → Expression の逆引き。 */
export function getExpression(id: string): Expression | undefined {
  return EXPRESSIONS.find((e) => e.id === id);
}

/** id 群を EXPRESSIONS の並び順で解決する（未知IDは捨てる）。 */
export function resolveExpressions(ids: string[]): Expression[] {
  return EXPRESSIONS.filter((e) => ids.includes(e.id));
}

/**
 * 表情の promptFragment を、character_sheet_run に渡す完全なプロンプト断片へ組み立てる。
 * 固定プレフィックス（アングル固定・同一人物）+ 表情固有の断片を連結する。
 */
export function buildExpressionPromptFragment(expression: Expression): string {
  return `${EXPRESSION_PROMPT_PREFIX}, ${expression.promptFragment}`;
}
