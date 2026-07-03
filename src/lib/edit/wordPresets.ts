/**
 * ことばで分離 (SAM3) の日本語→英語プロンプト辞書。
 *
 * なぜ変換するか (2026-07-03 実測): SAM3 のテキストエンコーダは CLIP 系で英語が最も強い。
 * 「basketball」= 確信度 0.983 に対し「ボール」= 0.756、さらに日本語プロンプトは
 * 画像内の日本語文字領域を誤検出する副作用があった (「ロボット」でタイトル文字を 0.53 検出)。
 * UI では日本語で受けて、内部でこの辞書から英語に解決して投げる。
 *
 * 辞書に無い日本語はそのまま SAM3 へ渡す (動くが確信度が下がる旨を UI で示す)。
 */

export type WordPreset = {
  /** 表示名 (日本語)。レイヤー名にもなる。 */
  ja: string;
  /** SAM3 に渡す英語プロンプト。 */
  en: string;
};

/** よく使う候補 (チップ表示順)。 */
export const WORD_CHIPS: WordPreset[] = [
  { ja: "人物", en: "person" },
  { ja: "顔", en: "face" },
  { ja: "髪", en: "hair" },
  { ja: "服", en: "clothes" },
  { ja: "車", en: "car" },
  { ja: "電車", en: "train" },
  { ja: "建物", en: "building" },
  { ja: "ロゴ", en: "logo" },
  { ja: "文字", en: "text" },
  { ja: "空", en: "sky" },
];

/** 日本語→英語の解決辞書 (チップ + よく出る語)。 */
const JA_TO_EN: Record<string, string> = {
  ...Object.fromEntries(WORD_CHIPS.map((p) => [p.ja, p.en])),
  人: "person",
  男性: "man",
  女性: "woman",
  子供: "child",
  犬: "dog",
  猫: "cat",
  鳥: "bird",
  魚: "fish",
  馬: "horse",
  ロボット: "robot",
  ボール: "ball",
  バスケットボール: "basketball",
  サッカーボール: "soccer ball",
  自転車: "bicycle",
  バイク: "motorcycle",
  飛行機: "airplane",
  船: "boat",
  バス: "bus",
  トラック: "truck",
  木: "tree",
  花: "flower",
  草: "grass",
  山: "mountain",
  海: "sea",
  川: "river",
  雲: "cloud",
  月: "moon",
  太陽: "sun",
  星: "star",
  窓: "window",
  ドア: "door",
  椅子: "chair",
  テーブル: "table",
  机: "desk",
  ソファ: "sofa",
  ベッド: "bed",
  コップ: "cup",
  ボトル: "bottle",
  皿: "plate",
  食べ物: "food",
  ケーキ: "cake",
  果物: "fruit",
  野菜: "vegetables",
  スマホ: "smartphone",
  携帯: "smartphone",
  パソコン: "laptop",
  時計: "watch",
  メガネ: "glasses",
  帽子: "hat",
  靴: "shoes",
  バッグ: "bag",
  傘: "umbrella",
  本: "book",
  手: "hand",
  目: "eyes",
  口: "mouth",
  頭: "head",
  腕: "arm",
  脚: "legs",
  シャツ: "shirt",
  ズボン: "pants",
  スカート: "skirt",
  ドレス: "dress",
  ジャケット: "jacket",
  ユニフォーム: "uniform",
  背景: "background",
  道路: "road",
  橋: "bridge",
  信号: "traffic light",
  標識: "sign",
  ポスター: "poster",
  看板: "signboard",
  商品: "product",
  箱: "box",
  ぬいぐるみ: "stuffed animal",
  キャラクター: "cartoon character",
};

/** 入力1語を SAM3 プロンプトに解決する。 */
export function resolveWord(input: string): {
  prompt: string;
  label: string;
  translated: boolean;
} {
  const trimmed = input.trim();
  // 英数字のみ → そのまま英語プロンプトとして使う。
  if (/^[\x20-\x7e]+$/.test(trimmed)) {
    return { prompt: trimmed, label: trimmed, translated: true };
  }
  const en = JA_TO_EN[trimmed];
  if (en) {
    return { prompt: en, label: trimmed, translated: true };
  }
  // 辞書外の日本語: そのまま渡す (確信度は下がる)。
  return { prompt: trimmed, label: trimmed, translated: false };
}

/** カンマ・読点・空白区切りの入力を語のリストへ分解する。 */
export function splitWordsInput(raw: string): string[] {
  return raw
    .split(/[,、\s]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}
