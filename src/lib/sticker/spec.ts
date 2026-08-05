/**
 * LINEスタンプ規格の定数テーブル（設計書 v3 §1.8 / §1.10 / §3 / §4.1）。
 *
 * ## なぜカテゴリ別テーブルなのか
 *
 * 余白ポリシーがカテゴリ間で**真逆**になる:
 *
 * | カテゴリ | 余白 |
 * |---|---|
 * | 通常スタンプ | 約10px **必須** |
 * | 絵文字        | **0**（余白なしで全面配置） |
 * | BIGスタンプ   | **不要**（システムが自動付与） |
 *
 * 1つの正規化関数へ共通化すると必ずどれかが落ちる。カテゴリごとに値を持ち、
 * 呼び出し側が `STICKER_SPECS[category]` を引く形にしておけば、v1 で通常のみを
 * 実装しても後から絵文字・BIG を「値を足すだけ」で扱える。
 *
 * ## 数値の出典
 *
 * 通常スタンプの寸法・余白・容量は一次情報
 * （`_work/gorigori-feedback/wave7/line-ai-policy-verified.md` §3-2 / §6-4）に基づく。
 * 余白は公式表記が **px**（「約10px」）なので px を焼く。個人ブログ由来の「3%」は採らない。
 *
 * **公式根拠が無い値は `MIN_INK_RATIO` だけ**で、その旨を当該定数のコメントに明記している。
 */

/** スタンプのカテゴリ。v1 で実装するのは `normal` のみ（設計書 §3）。 */
export type StickerCategory = "normal" | "emoji" | "big";

/** 1カテゴリ分の規格。 */
export type StickerSpec = {
  category: StickerCategory;
  /** UI 表示名。 */
  label: string;
  /** スタンプ画像の寸法上限（この値**以内**。ちょうどである必要はない）。 */
  maxWidth: number;
  maxHeight: number;
  /**
   * 被写体の周囲に確保する余白（px）。
   * 通常=10 / 絵文字=0（全面配置）/ BIG=0（システムが自動付与するため付けない）。
   */
  padding: number;
  /** メイン画像の寸法（ちょうど一致が要求される）。持たないカテゴリは null。 */
  mainImage: { width: number; height: number } | null;
  /** タブ画像の寸法（ちょうど一致）。持たないカテゴリは null。 */
  tabImage: { width: number; height: number } | null;
  /** 1画像あたりのファイルサイズ上限（バイト）。 */
  maxBytesPerImage: number;
  /** セット合計のファイルサイズ上限（バイト）。 */
  maxBytesTotal: number;
  /** 選べる枚数。 */
  counts: readonly number[];
  /** v1 で実装済みか。false のカテゴリは UI に出さない（設計書 §3 スコープ外）。 */
  implemented: boolean;
};

/**
 * 選べる枚数（STΛCK決定2）。
 *
 * 32/40 は `MAX_SHEET_CUTS`(30) を超えるため2波に分けて生成する（設計書 §1.2）。
 * 波は生成の都合であって工程ではないので、**UIには波の概念を出さない**。
 */
export const STICKER_COUNTS = [8, 16, 24, 32, 40] as const;

export type StickerCount = (typeof STICKER_COUNTS)[number];

/** 既定の枚数。8 は商品として少なく、40 は初回コストが重い（設計書 §1.2）。 */
export const DEFAULT_STICKER_COUNT: StickerCount = 16;

/** 1バッチで投げられるカット数の上限。`character_sheet.rs` の `MAX_SHEET_CUTS`(30) 未満に収める。 */
export const STICKER_BATCH_MAX_CUTS = 20;

/** 通常スタンプの余白（px）。公式表記が px なので px を焼く（設計書 §1.8）。 */
export const NORMAL_PADDING_PX = 10;

/** 1画像 1MB。 */
export const MAX_BYTES_PER_IMAGE = 1_048_576;

/** セット合計 60MB。 */
export const MAX_BYTES_TOTAL = 62_914_560;

/**
 * 不透明画素の面積がキャンバス面積に占める割合の下限。これを下回ると `ink-too-small` 警告。
 *
 * ⚠️ **この値に公式根拠はない。実運用で調整する暫定値である**（設計書 §1.9 / D13）。
 * LINE の一次情報には「被写体がどれだけ小さいと不可か」の記述が存在しない。
 * 「余白を取りすぎて被写体が豆粒になった」事故を拾うための実務的な下限として 0.03 を置く。
 * 実データが溜まったら見直すこと。**エラーではなく警告に留めるのは根拠が無いため**。
 */
export const MIN_INK_RATIO = 0.03;

/**
 * カテゴリ別の規格テーブル。
 *
 * `emoji` / `big` は **v1 では実装しない**（`implemented: false`）。
 * 値を持っているのは「余白ポリシーが真逆であること」を型と値で示し、
 * 将来 padding を共通化する誤りを防ぐため（設計書 §3）。
 */
export const STICKER_SPECS: Readonly<Record<StickerCategory, StickerSpec>> = {
  normal: {
    category: "normal",
    label: "スタンプ",
    maxWidth: 370,
    maxHeight: 320,
    padding: NORMAL_PADDING_PX,
    mainImage: { width: 240, height: 240 },
    tabImage: { width: 96, height: 74 },
    maxBytesPerImage: MAX_BYTES_PER_IMAGE,
    maxBytesTotal: MAX_BYTES_TOTAL,
    counts: STICKER_COUNTS,
    implemented: true,
  },
  emoji: {
    category: "emoji",
    label: "絵文字",
    maxWidth: 180,
    maxHeight: 180,
    // 通常と真逆。絵文字は余白なしで全面に配置する。
    padding: 0,
    mainImage: { width: 240, height: 240 },
    tabImage: null,
    maxBytesPerImage: MAX_BYTES_PER_IMAGE,
    // 絵文字は合計 20MB（通常の 60MB とは別）。
    maxBytesTotal: 20_971_520,
    counts: [8, 15, 24, 40] as const,
    implemented: false,
  },
  big: {
    category: "big",
    label: "BIGスタンプ",
    maxWidth: 480,
    maxHeight: 640,
    // システムが自動付与するため、こちらでは付けない。
    padding: 0,
    mainImage: { width: 240, height: 240 },
    tabImage: { width: 96, height: 74 },
    maxBytesPerImage: MAX_BYTES_PER_IMAGE,
    maxBytesTotal: MAX_BYTES_TOTAL,
    counts: [8, 16, 24] as const,
    implemented: false,
  },
} as const;

/** v1 で実際に使う規格（通常スタンプ）。 */
export const NORMAL_STICKER_SPEC = STICKER_SPECS.normal;

/** 枚数が選択肢に含まれるか（層A D10 の判定に使う）。 */
export function isValidStickerCount(
  count: number,
  category: StickerCategory = "normal",
): boolean {
  return STICKER_SPECS[category].counts.includes(count);
}

/**
 * 指定枚数を生成バッチへ分割する。
 *
 * 波は「生成の都合」であって工程ではない（設計書 §1.2）。返すのは各バッチのカット数だけで、
 * 呼び出し側は通し番号 `k / N` で進捗を見せる。**波の概念をUIに出さないこと。**
 *
 * 各バッチは `STICKER_BATCH_MAX_CUTS` 以下になり、合計は必ず `count` に一致する。
 */
export function splitIntoBatches(
  count: number,
  batchMax: number = STICKER_BATCH_MAX_CUTS,
): number[] {
  if (count <= 0 || batchMax <= 0) return [];
  const batchCount = Math.ceil(count / batchMax);
  // 端数が最後の1バッチへ寄ると「20 + 20 + 1」のような歪な分割になるため、
  // バッチ数を決めてから均等に割る（40 → 20+20、24 → 12+12）。
  const base = Math.floor(count / batchCount);
  const remainder = count % batchCount;
  return Array.from({ length: batchCount }, (_, i) => base + (i < remainder ? 1 : 0));
}
