/**
 * EC納品セットの納品カタログ（スキル一覧v2.1 #12 / MVP）
 *
 * 商品写真1枚から「白背景 / ライフスタイルシーン / ディテール寄り」の納品一式を
 * セットで生成するための既定カット定義。ユーザーはチェックで取捨選択できる。
 *
 * マルチアングル（src/lib/multiangle/angles.ts）と同じ CutPromptSpec 構造に落として
 * 既存の生成経路（Rust: multiangle_run / multiangle_regenerate_cut）をそのまま使う。
 * したがって promptFragment は「商品を撮り直したように見せる」ための英語表現に焼く。
 *
 * 商品の同一性維持（形状・ラベル・ロゴ・色を変えない）は PRODUCT_IDENTITY_LOCK に
 * 集約し、全カット共通で生成プロンプトへ焼き込む。
 */

/** 納品カットの分類。UI のグルーピングと既定選択の判断に使う。 */
export type ProductCutGroup = "white" | "lifestyle" | "detail";

export type ProductCut = {
  /** 一意ID。store のキー・Rust 側 cutId・ファイル名に使う。 */
  id: string;
  /** UI 表示名（日本語）。 */
  label: string;
  /** 分類タグ（UIグルーピング用）。 */
  group: ProductCutGroup;
  /** カットの狙いを1行で（UIの説明表示用）。 */
  hint: string;
  /**
   * 生成プロンプトに焼き込む英語表現（構図・背景・ライティング）。
   * 商品そのものは参照画像で固定し、ここでは「どう撮るか」だけを指定する。
   * `{scene}` を含む場合はライフスタイルシーン指定（sceneHint）で差し替える。
   */
  promptFragment: string;
};

/**
 * 全カット共通で焼き込む「商品の同一性維持」句。
 * 形状・比率・ラベル・ロゴ・文字・色を絶対に変えないことを最優先で指示する。
 */
export const PRODUCT_IDENTITY_LOCK =
  "This is a product photography reshoot. Keep the exact same product from the reference image: " +
  "identical shape, proportions, material, color, label text, logo and packaging. " +
  "Do not redesign, restyle, relabel, add or remove any part of the product. " +
  "Only the camera framing, background and lighting change, as if the same physical product " +
  "were re-photographed in a studio. Photorealistic, high resolution, sharp focus on the product, " +
  "no text overlay, no watermark, no collage, single product, single image.";

/**
 * 既定の納品カタログ（6カット）。
 * white 2 / lifestyle 2 / detail 2 の構成。各カットは独立して並列生成される。
 */
export const PRODUCT_CUTS: ProductCut[] = [
  // ── 白背景系（EC主画像・サムネ向け） ──
  {
    id: "white_front",
    label: "白背景・正面",
    group: "white",
    hint: "EC主画像/サムネ向けの正面カット",
    promptFragment:
      "clean pure white seamless studio background (#ffffff), product centered and shot straight-on at eye level, " +
      "soft even e-commerce lighting, subtle natural contact shadow beneath the product, catalog main image style",
  },
  {
    id: "white_angle",
    label: "白背景・斜め",
    group: "white",
    hint: "立体感が伝わる45度アングル",
    promptFragment:
      "clean pure white seamless studio background (#ffffff), product photographed from a 45-degree three-quarter angle " +
      "to show depth and dimension, soft even lighting, gentle contact shadow, premium catalog look",
  },

  // ── ライフスタイルシーン系（使用シーン想起） ──
  {
    id: "lifestyle_1",
    label: "シーンカット1",
    group: "lifestyle",
    hint: "使用シーンを想起させる生活感カット",
    promptFragment:
      "lifestyle product photo placed in {scene}, natural realistic environment, soft window daylight, " +
      "shallow depth of field with a softly blurred background, warm inviting mood, product remains the clear hero of the frame",
  },
  {
    id: "lifestyle_2",
    label: "シーンカット2",
    group: "lifestyle",
    hint: "別角度・別構図のシーンカット",
    promptFragment:
      "lifestyle product photo in {scene}, different composition and angle from the first scene, " +
      "styled with tasteful complementary props around but not covering the product, natural ambient light, " +
      "editorial e-commerce styling, product stays in sharp focus",
  },

  // ── ディテール寄り系（質感・素材の訴求） ──
  {
    id: "detail_texture",
    label: "ディテール・質感",
    group: "detail",
    hint: "素材の質感が伝わる寄りカット",
    promptFragment:
      "extreme close-up macro shot of the product surface, emphasizing material texture and finish, " +
      "crisp detail, soft directional light raking across the surface to reveal texture, shallow depth of field, " +
      "neutral clean background",
  },
  {
    id: "detail_label",
    label: "ディテール・ラベル",
    group: "detail",
    hint: "ラベル/ロゴ/表記が読める寄りカット",
    promptFragment:
      "close-up detail shot focusing on the product's label, logo and printed information, kept perfectly legible and unchanged, " +
      "sharp focus on the branding area, soft even lighting, neutral clean background",
  },
];

/** 既定で選択状態にするカット（MVPでは全6カット）。 */
export const DEFAULT_SELECTED_CUT_IDS: string[] = PRODUCT_CUTS.map((c) => c.id);

export function getProductCut(id: string | null | undefined): ProductCut | undefined {
  return PRODUCT_CUTS.find((cut) => cut.id === id);
}

/**
 * カットの promptFragment にシーン指定（例:「木目のテーブル」）を差し込む。
 * `{scene}` を含まないカット（白背景・ディテール）はそのまま返す。
 * シーン未指定なら汎用の自然なシーン表現でフォールバックする。
 */
export function resolveCutFragment(cut: ProductCut, sceneHint: string): string {
  if (!cut.promptFragment.includes("{scene}")) return cut.promptFragment;
  const scene = sceneHint.trim() || "a natural, uncluttered real-world setting that suits the product";
  return cut.promptFragment.replace(/\{scene\}/g, scene);
}

/**
 * 生成用の1カット分プロンプトを組み立てる（商品説明 + 同一性維持句 + 構図）。
 * Rust 側の build_multiangle_prompt はこの promptFragment と environment を受け取り
 * さらに整形するため、ここでは「商品説明 + 同一性ロック + 構図」を promptFragment に
 * まとめて渡す（Rust 側の共通句と二重にならないよう、構図の主語を明確化する）。
 */
export function buildCutPromptFragment(
  cut: ProductCut,
  productDescription: string,
  sceneHint: string,
): string {
  const composition = resolveCutFragment(cut, sceneHint);
  const desc = productDescription.trim();
  const descLine = desc ? `Product: ${desc}. ` : "";
  return `${descLine}${PRODUCT_IDENTITY_LOCK} Composition for this shot: ${composition}.`;
}
