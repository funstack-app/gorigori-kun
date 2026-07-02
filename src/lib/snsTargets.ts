// SNS リサイズ書き出しのプリセット定義 (W2-2 / 監査B-1)。
//
// Rust 側 `images_export_resized(paths, targets, output_dir)` の `targets` に
// そのまま渡せる形。mode は "cover"(中央クロップ) / "contain"(余白パディング) を
// 各プリセットの既定として持たせるが、UI 側で一括切替もできる。

export type ResizeMode = "cover" | "contain";

export type SnsTarget = {
  /** 出力ファイル名サフィックス兼内部キー (半角英数・_・- のみ)。 */
  name: string;
  /** UI 表示名 (日本語)。 */
  label: string;
  width: number;
  height: number;
  /** このプリセットの既定モード。UI で上書き可能。 */
  mode: ResizeMode;
};

/** SNS 各媒体の標準サイズプリセット。 */
export const SNS_TARGETS: readonly SnsTarget[] = [
  {
    name: "instagram_square",
    label: "Instagram 正方形 (1080×1080)",
    width: 1080,
    height: 1080,
    mode: "cover",
  },
  {
    name: "instagram_story",
    label: "ストーリー・リール (1080×1920)",
    width: 1080,
    height: 1920,
    mode: "cover",
  },
  {
    name: "x_post",
    label: "X 投稿 (1600×900)",
    width: 1600,
    height: 900,
    mode: "cover",
  },
  {
    name: "youtube_thumbnail",
    label: "YouTube サムネ (1280×720)",
    width: 1280,
    height: 720,
    mode: "cover",
  },
  {
    name: "lp_hero",
    label: "LP ヒーロー (1920×1080)",
    width: 1920,
    height: 1080,
    mode: "cover",
  },
] as const;
