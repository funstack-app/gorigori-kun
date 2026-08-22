export type VideoServiceId =
  | "seedance-2.5"
  | "seedance-2.0"
  | "kling-3.0"
  | "veo-3.1"
  | "minimax-h3"
  | "flux3";

export type VideoServiceProfile = {
  id: VideoServiceId;
  label: string;
  blurb: string;
  maxBlockSeconds: number | null;
  referenceNotation: string;
  measured: boolean;
  notes: string;
};

export const DEFAULT_VIDEO_SERVICE_ID: VideoServiceId = "seedance-2.5";

export const VIDEO_SERVICE_PROFILES: readonly VideoServiceProfile[] = [
  {
    id: "seedance-2.5",
    label: "Seedance 2.5",
    blurb: "実測資産が最も多い推奨サービス",
    maxBlockSeconds: 25,
    referenceNotation: "`@Image N`（スペースあり）で役割を名指しする",
    measured: true,
    notes: "Higgsfieldの無制限枠はWeb UIのみ。MCP/CLI経由はクレジットを消費する。",
  },
  {
    id: "seedance-2.0",
    label: "Seedance 2.0",
    blurb: "API経由やHiggsfield以外で使う場合の代替",
    maxBlockSeconds: 15,
    referenceNotation: "`@Image1` / `@Video1` / `@Audio1`（スペースなし・番号直結）",
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。参照記法は実機確認が必要。",
  },
  {
    id: "kling-3.0",
    label: "Kling 3.0",
    blurb: "AI Directorで1生成内に最大6ショットを構成できる",
    maxBlockSeconds: 15,
    referenceNotation: "アップロード画像を exact first frame として指定し、Elementsで再利用する",
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。最大尺は実機確認が必要。",
  },
  {
    id: "veo-3.1",
    label: "Veo 3.1",
    blurb: "プロファイル未作成",
    maxBlockSeconds: null,
    referenceNotation: "プロファイル未作成のため未定",
    measured: false,
    notes: "プロファイル未作成。生成前に公式ガイドからプロファイルを作る（run-ai-film の原則）",
  },
  {
    id: "minimax-h3",
    label: "MiniMax H3",
    blurb: "映像と同期ステレオ音声を単一パスで生成する",
    maxBlockSeconds: 15,
    referenceNotation: "`<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`で役割を宣言する",
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。実用上の推奨ブロック秒数は未確認。",
  },
  {
    id: "flux3",
    label: "FLUX 3",
    blurb: "動画とネイティブ音声を統合したマルチモーダルモデル",
    maxBlockSeconds: 20,
    referenceNotation: "`keyframes`に開始・終了・時刻付き画像を渡す",
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。実用上の推奨ブロック秒数は未確認。",
  },
];

export function findVideoServiceProfile(id: string): VideoServiceProfile | undefined {
  return VIDEO_SERVICE_PROFILES.find((profile) => profile.id === id);
}
