export type GoriSkillId =
  | "gori-storyboard"
  | "gori-multi-angle"
  | "gori-lp-builder"
  | "gori-cutout-ocr"
  | "gori-bg-swap"
  | "gori-pose-transfer"
  | "gori-product-shot"
  | "gori-character-sheet"
  | "gori-thumbnail-batch"
  | "gori-style-transfer"
  | "gori-color-palette"
  | "gori-comic-panel";

export type GoriSkill = {
  id: GoriSkillId;
  name: string;
  shortName: string;
  icon: string;
  description: string;
  path: string;
  /** アプリ内から直接利用可能なスキル。false の場合はグレイアウト表示。 */
  availableInApp: boolean;
  /** 近日公開予定。グレイアウト + 「近日公開」ラベル表示。 */
  comingSoon?: boolean;
  launchHint: string;
  /** ユーザーがインポートしたカスタムスキル。export ボタンを表示する目印にも使う。 */
  imported?: boolean;
};

// 画像生成直結のクリエイティブ系スキルのみ収録。
// 「近日公開」枠は今後の拡張をワクワクさせるための表示。順次解放していく。
export const GORI_SKILLS: GoriSkill[] = [
  {
    id: "gori-storyboard",
    name: "ストーリーカット生成",
    shortName: "Storyboard",
    icon: "🎬",
    description:
      "ストーリーから一貫したカット列を連続生成。キャラ/スタイルを固定して物語を進める。",
    path: "~/.codex/skills/gori-storyboard",
    availableInApp: true,
    launchHint: "ストーリーカットのスキル実行パネルを開きます。",
  },
  {
    id: "gori-multi-angle",
    name: "マルチアングル生成",
    shortName: "Multi-Angle",
    icon: "📐",
    description:
      "環境と被写体を固定し、ショット距離(クローズアップ/ミディアム/ロング)とアングル(俯瞰/煽り/正面)だけ変えて一気にカット量産。",
    path: "~/.codex/skills/gori-multi-angle",
    availableInApp: false,
    comingSoon: true,
    launchHint: "30 カット一気に量産 — 近日公開",
  },
  {
    id: "gori-lp-builder",
    name: "モバイル LP ビルダー",
    shortName: "LP Builder",
    icon: "📱",
    description:
      "参照画像からスマホ向け縦長 LP のヒーロー / 訴求 / CTA セクションを一気に組み立てる。",
    path: "~/.codex/skills/gori-lp-builder",
    availableInApp: false,
    comingSoon: true,
    launchHint: "1ファイルで完結する LP — 近日公開",
  },
  {
    id: "gori-cutout-ocr",
    name: "切り抜き + OCR",
    shortName: "Cutout OCR",
    icon: "✂️",
    description:
      "写真から人物・商品を綺麗に切り抜きながら、写り込んでいる文字も OCR で抽出。",
    path: "~/.codex/skills/gori-cutout-ocr",
    availableInApp: false,
    comingSoon: true,
    launchHint: "AI 切り抜き + テキスト抽出 — 近日公開",
  },
  {
    id: "gori-bg-swap",
    name: "背景差し替え",
    shortName: "BG Swap",
    icon: "🏞",
    description:
      "被写体はそのままに、背景だけプロンプトで自由に置き換える。EC・SNS 投稿の背景違い量産に。",
    path: "~/.codex/skills/gori-bg-swap",
    availableInApp: false,
    comingSoon: true,
    launchHint: "1枚から無限ロケ撮影 — 近日公開",
  },
  {
    id: "gori-pose-transfer",
    name: "ポーズ転写",
    shortName: "Pose Transfer",
    icon: "🤸",
    description:
      "参照画像のポーズを抽出し、別キャラクターに同じポーズを取らせる。",
    path: "~/.codex/skills/gori-pose-transfer",
    availableInApp: false,
    comingSoon: true,
    launchHint: "ポーズを別キャラに着せ替え — 近日公開",
  },
  {
    id: "gori-product-shot",
    name: "プロダクトショット",
    shortName: "Product Shot",
    icon: "📸",
    description:
      "商品写真を背景・小道具・ライティング込みで EC 用に整える。複数バリエーション同時生成。",
    path: "~/.codex/skills/gori-product-shot",
    availableInApp: false,
    comingSoon: true,
    launchHint: "EC 撮影スタジオを内蔵 — 近日公開",
  },
  {
    id: "gori-character-sheet",
    name: "キャラクターシート",
    shortName: "Character Sheet",
    icon: "🧝",
    description:
      "1枚の参照画像から、表情・服装・小道具の異なる同一キャラクターを一括生成。",
    path: "~/.codex/skills/gori-character-sheet",
    availableInApp: false,
    comingSoon: true,
    launchHint: "キャラ立ち絵セットを量産 — 近日公開",
  },
  {
    id: "gori-thumbnail-batch",
    name: "サムネ量産",
    shortName: "Thumbnail Batch",
    icon: "🖼",
    description:
      "1つのコンセプトから YouTube/SNS 用サムネを構図違い・配色違いで 12 種同時生成。",
    path: "~/.codex/skills/gori-thumbnail-batch",
    availableInApp: false,
    comingSoon: true,
    launchHint: "クリック率テスト用に大量生成 — 近日公開",
  },
  {
    id: "gori-style-transfer",
    name: "スタイル転写",
    shortName: "Style Transfer",
    icon: "🎨",
    description:
      "参照画像の画風 (色調・タッチ) を抽出し、別の絵にその画風を適用。",
    path: "~/.codex/skills/gori-style-transfer",
    availableInApp: false,
    comingSoon: true,
    launchHint: "好きな画風で生成 — 近日公開",
  },
  {
    id: "gori-color-palette",
    name: "カラーパレット抽出",
    shortName: "Color Palette",
    icon: "🌈",
    description:
      "参照画像から主要 5〜8 色を抽出し、ブランドカラーパレットとして書き出す。",
    path: "~/.codex/skills/gori-color-palette",
    availableInApp: false,
    comingSoon: true,
    launchHint: "ブランドカラー設計補助 — 近日公開",
  },
  {
    id: "gori-comic-panel",
    name: "マンガコマ割り",
    shortName: "Comic Panel",
    icon: "📖",
    description:
      "ストーリーをマンガ形式 (4コマ / 8コマ) のレイアウトに分割して同時生成。",
    path: "~/.codex/skills/gori-comic-panel",
    availableInApp: false,
    comingSoon: true,
    launchHint: "マンガ風コマ割り生成 — 近日公開",
  },
];

export function getGoriSkill(id: string | null | undefined): GoriSkill | undefined {
  return GORI_SKILLS.find((skill) => skill.id === id);
}
