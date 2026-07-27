// リサイズ書き出しのプリセット定義 (W2-2 / 監査B-1)。
//
// Rust 側 `images_export_resized(paths, targets, output_dir)` の `targets` に
// そのまま渡せる形。mode は "cover"(中央クロップ) / "contain"(余白パディング) を
// 各プリセットの既定として持たせるが、UI 側で一括切替もできる。
//
// ## 2026-07-27 実務規格の追加
//
// 4職種(広告制作/キャラIP/EC運用/映像プリプロ)の実務診断で、全職種が
// 「出てきた画像をそのまま入稿できない」で詰まった。原因は2つ:
//
//   1. プリセットが SNS 5種しか無く、広告媒体(GDN/YDA)・ECモール(楽天/Amazon)の
//      規格が無い。実務の入稿先はここが主戦場
//   2. 全プリセットが mode:"cover"(中央クロップ)だった。商品写真を中央クロップすると
//      **商品の端が切れる**。EC では「商品の見え方が実物と違う」として
//      景表法(優良誤認)の直接原因になり、掲載停止・返品につながる
//
// そのため商品・ロゴなど「切ってはいけないもの」を扱うプリセットは
// mode:"contain"(余白を足して全体を収める)を既定にしている。

export type ResizeMode = "cover" | "contain";

/** プリセットの用途分類。UI のグループ見出しに使う。 */
export type TargetCategory = "sns" | "ad" | "ec" | "video";

export type SnsTarget = {
  /** 出力ファイル名サフィックス兼内部キー (半角英数・_・- のみ)。 */
  name: string;
  /** UI 表示名 (日本語)。 */
  label: string;
  width: number;
  height: number;
  /** このプリセットの既定モード。UI で上書き可能。 */
  mode: ResizeMode;
  /** 用途分類。未指定は "sns" 扱い (既存プリセットの後方互換)。 */
  category?: TargetCategory;
  /** なぜこのモードが既定なのかの一言。UI のツールチップに出す。 */
  note?: string;
};

/** カテゴリの表示名。UI のグループ見出し。 */
export const TARGET_CATEGORY_LABELS: Record<TargetCategory, string> = {
  sns: "SNS",
  ad: "広告バナー",
  ec: "ECモール",
  video: "動画・映像",
};

/** 書き出しサイズのプリセット。カテゴリ順に並べる。 */
export const SNS_TARGETS: readonly SnsTarget[] = [
  // ── SNS ──────────────────────────────────────────────
  {
    name: "instagram_square",
    label: "Instagram 正方形 (1080×1080)",
    width: 1080,
    height: 1080,
    mode: "cover",
    category: "sns",
  },
  {
    name: "instagram_story",
    label: "ストーリー・リール (1080×1920)",
    width: 1080,
    height: 1920,
    mode: "cover",
    category: "sns",
  },
  {
    name: "x_post",
    label: "X 投稿 (1600×900)",
    width: 1600,
    height: 900,
    mode: "cover",
    category: "sns",
  },
  {
    name: "youtube_thumbnail",
    label: "YouTube サムネ (1280×720)",
    width: 1280,
    height: 720,
    mode: "cover",
    category: "sns",
  },
  {
    name: "lp_hero",
    label: "LP ヒーロー (1920×1080)",
    width: 1920,
    height: 1080,
    mode: "cover",
    category: "sns",
  },

  // ── 広告バナー (GDN / YDA の主要枠) ───────────────────
  // media 規格は「この寸法ちょうど」を要求するため cover で埋める。
  // バナーは元から枠に合わせて作る前提なので中央クロップで実務上問題ない。
  {
    name: "banner_300x250",
    label: "レクタングル (300×250)",
    width: 300,
    height: 250,
    mode: "cover",
    category: "ad",
    note: "GDN/YDA で最も配信量が多い枠",
  },
  {
    name: "banner_336x280",
    label: "大レクタングル (336×280)",
    width: 336,
    height: 280,
    mode: "cover",
    category: "ad",
  },
  {
    name: "banner_728x90",
    label: "ビッグバナー (728×90)",
    width: 728,
    height: 90,
    mode: "cover",
    category: "ad",
  },
  {
    name: "banner_160x600",
    label: "ワイドスカイスクレイパー (160×600)",
    width: 160,
    height: 600,
    mode: "cover",
    category: "ad",
  },
  {
    name: "banner_320x100",
    label: "スマホバナー大 (320×100)",
    width: 320,
    height: 100,
    mode: "cover",
    category: "ad",
  },
  {
    name: "banner_1200x628",
    label: "レスポンシブ横長 (1200×628)",
    width: 1200,
    height: 628,
    mode: "cover",
    category: "ad",
    note: "レスポンシブ広告・OGP 兼用",
  },

  // ── EC モール ────────────────────────────────────────
  // すべて contain(余白付き)を既定にする。商品を切らないため。
  // cover にすると商品の端が欠け、実物と違う見え方になる(景表法リスク)。
  {
    name: "ec_rakuten_1000",
    label: "楽天 商品画像 (1000×1000)",
    width: 1000,
    height: 1000,
    mode: "contain",
    category: "ec",
    note: "商品を切らないため余白付きが既定",
  },
  {
    name: "ec_amazon_1600",
    label: "Amazon 商品画像 (1600×1600)",
    width: 1600,
    height: 1600,
    mode: "contain",
    category: "ec",
    note: "ズーム機能の要件を満たす長辺1600px",
  },
  {
    name: "ec_yahoo_600",
    label: "Yahoo!ショッピング (600×600)",
    width: 600,
    height: 600,
    mode: "contain",
    category: "ec",
    note: "商品を切らないため余白付きが既定",
  },
  {
    name: "ec_square_2000",
    label: "高解像度 正方形 (2000×2000)",
    width: 2000,
    height: 2000,
    mode: "contain",
    category: "ec",
    note: "各モールの上限に合わせて縮小できる元データ用",
  },

  // ── 動画・映像 ───────────────────────────────────────
  {
    name: "video_fhd",
    label: "フルHD 横 (1920×1080)",
    width: 1920,
    height: 1080,
    mode: "cover",
    category: "video",
  },
  {
    name: "video_4k",
    label: "4K 横 (3840×2160)",
    width: 3840,
    height: 2160,
    mode: "cover",
    category: "video",
  },
  {
    name: "video_vertical",
    label: "縦型フルHD (1080×1920)",
    width: 1080,
    height: 1920,
    mode: "cover",
    category: "video",
  },
] as const;

/** カテゴリ別にプリセットをまとめる (UI のグループ表示用)。 */
export function groupTargetsByCategory(): Array<{
  category: TargetCategory;
  label: string;
  targets: SnsTarget[];
}> {
  const order: TargetCategory[] = ["sns", "ad", "ec", "video"];
  return order.map((category) => ({
    category,
    label: TARGET_CATEGORY_LABELS[category],
    targets: SNS_TARGETS.filter((t) => (t.category ?? "sns") === category),
  }));
}
