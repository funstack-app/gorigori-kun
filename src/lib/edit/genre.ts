/**
 * レイヤー大ジャンル (人 / テキスト / 背景 / 小物)。
 *
 * Canva 級の編集体験の中核: 分解結果を「物体のフラット列」ではなく
 * 大ジャンルのレイヤー階層として見せる (2026-07-06 gap-audit G1)。
 *
 * ジャンルの決まり方 (優先順):
 * 1. Codex vision (listObjects) が返す category — 画像を実際に見た分類なので最優先
 * 2. この分類器 (classifyWord) — en プロンプト / ja ラベルの決定論キーワード判定
 * 3. レイヤー構造からのフォールバック (layerHelpers.objectGenre) — textbox は text、
 *    id "bg" は background、それ以外は prop
 *
 * 境界の決め (矛盾に名前を付ける):
 * - ロゴ = text。文字・ロゴは「打ち替え/差し替えの対象」として同じ見出しに揃える
 * - 人型ロボット・キャラクター = prop に倒す。SCHP 人物パーツ分解が効く保証がなく、
 *   「人」見出しに置くと展開(将来のG2)が壊れる。Codex category が person を返した
 *   場合のみ person (実物を見た判定を信頼する)
 */

export type LayerGenre = "person" | "text" | "background" | "prop";

export const GENRE_LABELS: Record<LayerGenre, string> = {
  person: "人",
  text: "テキスト",
  background: "背景",
  prop: "小物",
};

/** レイヤーツリーの見出し順。z順の直感 (人・文字が手前、背景が最奥) に合わせる。 */
export const GENRE_ORDER: LayerGenre[] = ["person", "text", "prop", "background"];

export function isLayerGenre(value: unknown): value is LayerGenre {
  return value === "person" || value === "text" || value === "background" || value === "prop";
}

// ── 決定論キーワード分類 ──────────────────────────────────────────
// en は単語境界トークンで一致 (person in black coat → person)。
// ja は2文字以上のキーワードは部分一致、1文字 (人 等) は完全一致のみ
// (「人形」「豆人形」を人に誤分類しないため)。

const PERSON_EN = new Set([
  "person",
  "people",
  "human",
  "man",
  "men",
  "woman",
  "women",
  "boy",
  "girl",
  "child",
  "children",
  "kid",
  "kids",
  "baby",
  "lady",
  "guy",
  "bride",
  "groom",
]);

const PERSON_JA = ["人物", "男性", "女性", "男の子", "女の子", "子供", "こども", "赤ちゃん", "少年", "少女"];
const PERSON_JA_EXACT = new Set(["人"]);

const TEXT_EN = new Set([
  "text",
  "letters",
  "lettering",
  "word",
  "words",
  "title",
  "headline",
  "caption",
  "subtitle",
  "logo",
  "typography",
  "font",
]);

const TEXT_JA = ["文字", "テキスト", "ロゴ", "タイトル", "見出し", "字幕", "文言"];

const BACKGROUND_EN = new Set(["background", "backdrop", "sky", "wall", "floor", "ground"]);

const BACKGROUND_JA = ["背景", "地面"];
const BACKGROUND_JA_EXACT = new Set(["空", "壁", "床"]);

function tokenizeEn(en: string): string[] {
  return en
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function matchJa(ja: string, contains: string[], exact: ReadonlySet<string>): boolean {
  const trimmed = ja.trim();
  if (exact.has(trimmed)) return true;
  return contains.some((keyword) => trimmed.includes(keyword));
}

/**
 * en プロンプト + ja ラベルから大ジャンルを決定論で分類する。
 * どのキーワードにも当たらないものは prop (小物)。
 */
export function classifyWord(en: string, ja = ""): LayerGenre {
  const tokens = tokenizeEn(en);
  if (tokens.some((token) => PERSON_EN.has(token)) || matchJa(ja, PERSON_JA, PERSON_JA_EXACT)) {
    return "person";
  }
  if (tokens.some((token) => TEXT_EN.has(token)) || matchJa(ja, TEXT_JA, new Set())) {
    return "text";
  }
  if (
    tokens.some((token) => BACKGROUND_EN.has(token)) ||
    matchJa(ja, BACKGROUND_JA, BACKGROUND_JA_EXACT)
  ) {
    return "background";
  }
  return "prop";
}

/**
 * Codex vision の category (未信頼の外部入力) を検証して大ジャンルへ正規化する。
 * 有効な4値ならそれを信頼し、欠落・壊れた値なら決定論分類器へフォールバックする。
 */
export function normalizeGenre(category: unknown, en: string, ja = ""): LayerGenre {
  if (isLayerGenre(category)) return category;
  return classifyWord(en, ja);
}

/**
 * ジャンル付きレイヤー列を見出し付きツリー (非空ジャンルのみ、GENRE_ORDER 順) に
 * グループ化する。入力の並び (= z順) はグループ内で保存する。
 */
export function groupLayersByGenre<T extends { genre: LayerGenre }>(
  layers: readonly T[],
): Array<{ genre: LayerGenre; label: string; layers: T[] }> {
  return GENRE_ORDER.map((genre) => ({
    genre,
    label: GENRE_LABELS[genre],
    layers: layers.filter((layer) => layer.genre === genre),
  })).filter((group) => group.layers.length > 0);
}
