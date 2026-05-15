export type GoriSkillId =
  | "gori-storyboard"
  | "gori-multi-angle"
  | "image2-mobile-lp-builder";

export type GoriSkill = {
  id: GoriSkillId;
  name: string;
  shortName: string;
  icon: string;
  description: string;
  path: string;
  availableInApp: boolean;
  launchHint: string;
};

// 画像生成直結のクリエイティブ系スキルのみ収録。
// エッセイ生成・UIクローンは「クリエイティブ画像生成ツール」の範囲外。
// (Codex とのクロスレビュー 2026-05-14 で確定)
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
    launchHint: "マルチアングルのスキル実行パネルを開きます (近日公開)。",
  },
  {
    id: "image2-mobile-lp-builder",
    name: "モバイルLPビルダー",
    shortName: "Mobile LP",
    icon: "📱",
    description:
      "参照画像からスマホ向けLPの構成とビジュアルを組み立てます。",
    path: "~/.codex/skills/image2-mobile-lp-builder",
    availableInApp: false,
    launchHint: "モバイルLPのスキル実行パネルを開きます。",
  },
];

export function getGoriSkill(id: string | null | undefined): GoriSkill | undefined {
  return GORI_SKILLS.find((skill) => skill.id === id);
}
