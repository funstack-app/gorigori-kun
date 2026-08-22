export type VideoServiceId =
  | "seedance-2.5"
  | "seedance-2.0"
  | "kling-3.0"
  | "veo-3.1"
  | "minimax-h3"
  | "flux3";

export type VideoReferenceKind = "image" | "video" | "audio";

export type VideoReferenceRules = {
  /** null は、正本に対応可否が書かれていないことを表す。 */
  startEndFrames: {
    start: boolean | null;
    end: boolean | null;
    combined: boolean | null;
  };
  kinds: readonly VideoReferenceKind[];
  limits: {
    images: number | null;
    videos: number | null;
    audio: number | null;
    total: number | null;
  };
  notes: readonly string[];
};

export type VideoServiceProfile = {
  id: VideoServiceId;
  label: string;
  blurb: string;
  maxBlockSeconds: number | null;
  referenceNotation: string;
  /** プロファイル自体が未作成なら null。推測で参照条件を補わない。 */
  referenceRules: VideoReferenceRules | null;
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
    referenceRules: {
      startEndFrames: { start: null, end: null, combined: null },
      kinds: ["image", "video", "audio"],
      limits: { images: 30, videos: 10, audio: 10, total: 50 },
      notes: [
        "参照は `@Image N` の形で書き、衣装・場所などの役割を名指しする。",
        "開始・終了フレームへの対応可否は正本に記載がない。",
      ],
    },
    measured: true,
    notes: "Higgsfieldの無制限枠はWeb UIのみ。MCP/CLI経由はクレジットを消費する。",
  },
  {
    id: "seedance-2.0",
    label: "Seedance 2.0",
    blurb: "API経由やHiggsfield以外で使う場合の代替",
    maxBlockSeconds: 15,
    referenceNotation: "`@Image1` / `@Video1` / `@Audio1`（スペースなし・番号直結）",
    referenceRules: {
      startEndFrames: { start: null, end: null, combined: null },
      kinds: ["image", "video", "audio"],
      limits: { images: 9, videos: 3, audio: 3, total: 12 },
      notes: [
        "画像・動画・音声は合計12ファイルまで。",
        "参照の役割を名指しできるかと、開始・終了フレーム対応は未確認。",
      ],
    },
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。参照記法は実機確認が必要。",
  },
  {
    id: "kling-3.0",
    label: "Kling 3.0",
    blurb: "AI Directorで1生成内に最大6ショットを構成できる",
    maxBlockSeconds: 15,
    referenceNotation: "アップロード画像を exact first frame として指定し、Elementsで再利用する",
    referenceRules: {
      startEndFrames: { start: true, end: null, combined: null },
      kinds: ["image", "video"],
      limits: { images: null, videos: null, audio: null, total: null },
      notes: [
        "アップロード画像を正確な開始フレームとして指定できる。",
        "Elementsで画像・動画を再利用できるが、枚数上限と終了フレーム対応は未確認。",
      ],
    },
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。最大尺は実機確認が必要。",
  },
  {
    id: "veo-3.1",
    label: "Veo 3.1",
    blurb: "プロファイル未作成",
    maxBlockSeconds: null,
    referenceNotation: "プロファイル未作成のため未定",
    referenceRules: null,
    measured: false,
    notes: "プロファイル未作成。生成前に公式ガイドからプロファイルを作る（run-ai-film の原則）",
  },
  {
    id: "minimax-h3",
    label: "MiniMax H3",
    blurb: "映像と同期ステレオ音声を単一パスで生成する",
    maxBlockSeconds: 15,
    referenceNotation: "`<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`で役割を宣言する",
    referenceRules: {
      startEndFrames: { start: true, end: true, combined: true },
      kinds: ["image", "video", "audio"],
      limits: { images: 9, videos: 3, audio: 3, total: 12 },
      notes: [
        "先頭・末尾フレームを同時に渡すFL2VAに対応。参照素材は役割を明記する。",
        "合計12点という上限は二次情報のみで、一次情報では未確認。",
      ],
    },
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。実用上の推奨ブロック秒数は未確認。",
  },
  {
    id: "flux3",
    label: "FLUX 3",
    blurb: "動画とネイティブ音声を統合したマルチモーダルモデル",
    maxBlockSeconds: 20,
    referenceNotation: "`keyframes`に開始・終了・時刻付き画像を渡す",
    referenceRules: {
      startEndFrames: { start: true, end: true, combined: true },
      kinds: ["image", "video"],
      limits: { images: null, videos: null, audio: null, total: null },
      notes: [
        "開始1枚、開始＋終了2枚、または時刻付き3枚以上のキーフレームに対応。",
        "3枚以上または時刻付きキーフレームでは duration の指定が必須。参照画像の枚数上限は未確認。",
      ],
    },
    measured: false,
    notes: "未実測。本番前にテスト生成1ブロックの合格が前提。実用上の推奨ブロック秒数は未確認。",
  },
];

export function findVideoServiceProfile(id: string): VideoServiceProfile | undefined {
  return VIDEO_SERVICE_PROFILES.find((profile) => profile.id === id);
}
