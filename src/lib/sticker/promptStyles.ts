/**
 * プロンプトの「書き味」（設計書 v3 §1.7・STΛCK決定7）。
 *
 * ## この設計の目的は「決めないこと」
 *
 * 情緒型（`sticker-craft-research.md` P-1 甲）と仕様型（同 P-12 乙）のどちらが良いかは
 * **まだ決まっていない**。実測は「**乙のほうが再現性が高く、甲のほうが良い絵が出る**」
 * （同 §2 Q3）というトレードオフを報告しており、片方が明確に優位ではない。
 *
 * したがって設計は**どちらかを選ばず、両方を差し替え可能なデータとして持つ**。
 * 実験（設計書 §8）で確定させる。**既定は暫定の仮置きである。**
 *
 * ## 構造上の制約（実験を可能にするための必須条件・設計書 §1.7）
 *
 * 1. **プロンプト文言をこのファイルの外に書かない。** 文言が漏れたら差し替えられなくなる
 * 2. **背景句・予防句は書き味と独立**させる。緑背景と `hard-edge cutout` は
 *    どちらのスタイルにも同じものが付く。比較したいのは書き味であって背景処理ではない
 * 3. **画風保持句も両方に共通で入れる。** ここを変えると同一性が崩れ、比較にならない
 * 4. スタイルIDは**生成物のメタデータに記録**する。後から「どちらで作ったか」を
 *    追えないと実験の集計ができない
 *
 * 2・3 を構造で守るため、両スタイルの `build` は共通句を**自分で書かず**
 * `composePrompt` から受け取る。文言をスタイル側にコピーすると 2・3 が壊れる。
 */

/** 書き味のID。生成物のメタデータに記録する（制約4）。 */
export type PromptStyleId = "emotive" | "spec";

/** プロンプト組み立ての入力。 */
/**
 * プロンプト組み立ての入力。
 *
 * ## ここに属性（`attributes`）を持たない（2026-08-05 C1 修正）
 *
 * 登録キャラの属性文字列（「銀髪ロング、赤い瞳、黒いセーラー服」等）は
 * **Rust 側 `build_sheet_prompt` の「不変の見た目 (全カット共通で厳守)」行が担う**。
 * `CharacterSheetParams.attributes` として渡した時点で必ずそこに載るので、
 * ここでも足すと**同じ文字列が1回の生成プロンプトに2箇所現れる**。
 *
 * 旧実装は両方に入れていた。実害は2つ:
 *
 * 1. **同じ指示の二重掲載**。片方は英語の書き味プロンプトの真ん中に日本語が挟まる形で、
 *    もう片方は「厳守」として別行に再掲される。どちらが効いているのか読めない
 * 2. **書き味の実験が汚れる**。この層は「情緒型 vs 仕様型」を比較するための層
 *    （下の設計コメント参照）だが、属性の位置が書き味ごとに変わると、
 *    比較しているのが書き味なのか属性の置き場所なのか分からなくなる
 *
 * 属性は「キャラの不変条件」であって「書き味」ではない。共通句を
 * `composePrompt` へ寄せたのと同じ理由で、**属性も書き味の外**に置く。
 * 役割の重なる2箇所のうち、明示的な役割と回帰テストを持つ Rust 側を残した。
 */
export type StickerPromptInput = {
  /** 表情・ポーズの英語断片（`catalog.ts` の `StickerEntry.promptFragment`）。 */
  promptFragment: string;
};

export type StickerPromptStyle = {
  id: PromptStyleId;
  label: string;
  /** 1行説明（UIでの選択肢表示用）。 */
  description: string;
  /** 各カットのプロンプト本体を組む。**文言はここだけに存在する。** */
  build(input: StickerPromptInput): string;
};

/* ------------------------------------------------------------------ *
 * 共通句（書き味と独立。制約2・3）
 * ------------------------------------------------------------------ */

/**
 * 画風保持句。**両スタイル共通**（制約3）。
 *
 * `expressionSet/catalog.ts` の `EXPRESSION_PROMPT_PREFIX` と同じ思想。
 * 2026-07-29 実機FB で「実写語彙だけで画風指示が無く、アニメ調キャラが写実側へ化けた」
 * 事故が出ているため、画風保持は書き味の実験対象から外して固定する。
 */
export const STYLE_PRESERVATION_CLAUSE =
  "same person, identical face, hairstyle and outfit, same art style as the reference image — keep the original drawing style, linework, coloring and rendering exactly, do not photorealize";

/**
 * クロマキー用の背景句。**両スタイル共通**（制約2）。
 *
 * 値は `character_sheet.rs:72` の `COMPOSITE_SHEET_BG_LINE_GREEN` と揃える。
 * 背景色を先に決めてから抜くので、前景が純白でも抜ける（設計書 §1.4）。
 */
export const CHROMA_BACKGROUND_CLAUSE =
  "solid chroma key green background, exact #00FF00 / RGB 0,255,0, evenly lit, no shadows, no gradient";

/**
 * フリンジ予防句。**両スタイル共通**（制約2）。
 *
 * 抜き後の縁の半透明の滲みは層Aでは検出しにくく、目視でも見落としやすい。
 * プロンプト段階で潰せば工程が丸ごと消える（設計書 §1.4。出典 `sticker-craft-research.md` §3-3）。
 */
export const FRINGE_PREVENTION_CLAUSE =
  "hard-edge cutout, no anti-aliased halo, single solid silhouette, no negative-space gaps";

/**
 * 文字を描かせない句。**両スタイル共通**。
 *
 * 理由は2つとも実測（設計書 §1.3）:
 * 1. 審査NG「単純なテキストのみの画像」を踏むリスク
 * 2. AIに日本語文字を描かせると崩れる（漢字は透過時に欠け、白文字は背景ごと抜ける）
 *
 * 文字入れは既存の編集機能でユーザーが決定論的に行う。
 */
export const NO_TEXT_CLAUSE =
  "no text, no letters, no speech bubbles, no watermark, no signature";

/** 共通句を1本に束ねたもの（順序を固定して差分を安定させる）。 */
export const SHARED_CLAUSES: readonly string[] = [
  STYLE_PRESERVATION_CLAUSE,
  CHROMA_BACKGROUND_CLAUSE,
  FRINGE_PREVENTION_CLAUSE,
  NO_TEXT_CLAUSE,
];

/**
 * 書き味固有の部分と共通句を合成する。
 *
 * **共通句は必ず後ろに付く**。スタイル側は共通句を自分で書かない（制約2・3を構造で守る）。
 * 空要素は落として区切りの重複を防ぐ。
 */
function composePrompt(styleSpecificParts: string[]): string {
  return [...styleSpecificParts, ...SHARED_CLAUSES]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
}

/* ------------------------------------------------------------------ *
 * 書き味の2実装
 * ------------------------------------------------------------------ */

/**
 * 情緒型（甲）。世界観・質感・空気を語る。
 * 出典: `sticker-craft-research.md` P-1（日本語圏で最も情報量が多い実例）。
 *
 * 実測評価: **良い絵が出やすいが、再現性は仕様型に劣る**（同 §2 Q3）。
 */
const EMOTIVE_STYLE: StickerPromptStyle = {
  id: "emotive",
  label: "情緒型",
  description: "世界観や質感を言葉で語る書き方。絵の魅力が出やすい一方、ばらつきが出やすい。",
  build(input) {
    return composePrompt([
      "a warm, endearing character sticker illustration",
      input.promptFragment,
      "soft even lighting with gentle shadows, matte texture, expressive and full of personality",
      "charming and comforting atmosphere, the kind of drawing you want to send to a friend",
      "the character alone, nothing else in the frame",
    ]);
  },
};

/**
 * 仕様型（乙）。構図・数値・構成を指定する。
 * 出典: `sticker-craft-research.md` P-12（英語圏のマスコット指定）。
 *
 * 実測評価: **再現性が高いが、絵の魅力は情緒型に劣る**（同 §2 Q3）。
 */
const SPEC_STYLE: StickerPromptStyle = {
  id: "spec",
  label: "仕様型",
  description: "構図と仕様を数値的に指定する書き方。同じものが安定して出やすい。",
  build(input) {
    return composePrompt([
      "character sticker asset, single subject, centered composition, full figure within frame",
      input.promptFragment,
      "clean bold outline, flat color fill, die-cut sticker silhouette",
      "flat even lighting, no cast shadow on the background",
    ]);
  },
};

/** 書き味の一覧（UIの選択肢の並び順）。 */
export const STICKER_PROMPT_STYLES: readonly StickerPromptStyle[] = [
  SPEC_STYLE,
  EMOTIVE_STYLE,
] as const;

/**
 * 暫定既定。**実験（設計書 §8）で確定していない。**
 *
 * 実測（`sticker-craft-research.md` §2 Q3）では
 * 「乙のほうが再現性が高く、甲のほうが良い絵が出る」とされ、両者にトレードオフがある。
 * **再現性を優先して `spec` を暫定既定に置くが、これは実験前の仮置きである。**
 * 実験で結果が出たらこの値を書き換えること（値の変更だけで切り替わるようにしてある）。
 */
export const DEFAULT_PROMPT_STYLE: PromptStyleId = "spec";

/** id → スタイルの逆引き。未知IDは undefined。 */
export function getPromptStyle(id: PromptStyleId): StickerPromptStyle | undefined {
  return STICKER_PROMPT_STYLES.find((s) => s.id === id);
}

/**
 * 指定の書き味でプロンプトを組む。未知IDは既定へ落とす（生成を止めない）。
 *
 * 呼び出し側は**使ったスタイルIDを生成物のメタデータに記録すること**（制約4）。
 * 記録しないと実験の集計ができない。
 */
export function buildStickerPrompt(
  styleId: PromptStyleId,
  input: StickerPromptInput,
): string {
  const style = getPromptStyle(styleId) ?? getPromptStyle(DEFAULT_PROMPT_STYLE);
  // DEFAULT_PROMPT_STYLE は必ず STICKER_PROMPT_STYLES に含まれるので undefined にならない。
  if (!style) throw new Error(`unknown prompt style: ${styleId}`);
  return style.build(input);
}
