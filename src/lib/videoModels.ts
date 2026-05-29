/**
 * P0-2 動画モデル静的定義 (2026-05-28)。
 *
 * 設計判断: higgsfield CLI の `model get <id> --json` 動的取得ではなく、
 * 静的TS定義を採用。理由は Codex Verifier クロスレビュー:
 *   - CLI JSON 仕様変化に UI が直撃しない
 *   - 型安全
 *   - オフライン・認証不安定時にもフォーム描画可能
 *   - 非エンジニアユーザー向け説明文・推奨値を作りやすい
 *
 * 新モデル追加時はこのファイルに定義を追加する。
 */

export type VideoModelId = "kling3_0" | "seedance_2_0" | "veo3_1";

/** i2v 入力フィールド名 (CLI に渡すフラグ名で識別) */
export type I2VInputField = "input_image" | "medias" | "input_images";

export type VideoModelParam =
  | { kind: "enum"; name: string; label: string; values: string[]; default: string }
  | { kind: "integer"; name: string; label: string; min: number; max: number; default: number }
  | { kind: "boolean"; name: string; label: string; default: boolean };

export type VideoModelDefinition = {
  id: VideoModelId;
  label: string;
  jobSetType: string;
  description: string;
  /** 利用可能な aspect_ratio (CLI の値そのまま) */
  aspectRatios: string[];
  defaultAspectRatio: string;
  /** duration の制約 */
  duration:
    | { kind: "enum"; values: number[]; default: number }
    | { kind: "integer"; default: number; min: number; max: number };
  /** モデル固有パラメータ (mode/quality/resolution/sound/genre/model_variant 等) */
  extraParams: VideoModelParam[];
  /** i2v 入力フィールド名 (CLI フラグ名) */
  i2vInputField: I2VInputField;
  /** t2v / i2v / 両対応 */
  inputMode: "t2v" | "i2v" | "both";
  /** 1回の生成あたり概算クレジット (default param時) */
  costEstimate: number;
};

export const VIDEO_MODELS: VideoModelDefinition[] = [
  {
    id: "kling3_0",
    label: "Kling 3.0",
    jobSetType: "kling3_0",
    description: "コスパ最強。3アスペクト対応、duration 任意。",
    aspectRatios: ["16:9", "9:16", "1:1"],
    defaultAspectRatio: "16:9",
    duration: { kind: "integer", default: 5, min: 2, max: 10 },
    extraParams: [
      { kind: "enum", name: "mode", label: "モード", values: ["pro", "std", "4k"], default: "std" },
      { kind: "enum", name: "sound", label: "音声", values: ["on", "off"], default: "on" },
    ],
    i2vInputField: "medias",
    inputMode: "both",
    costEstimate: 10,
  },
  {
    id: "seedance_2_0",
    label: "Seedance 2.0",
    jobSetType: "seedance_2_0",
    description: "7アスペクト対応、genre/mode/resolution 豊富。",
    aspectRatios: ["auto", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
    defaultAspectRatio: "16:9",
    duration: { kind: "integer", default: 5, min: 2, max: 10 },
    extraParams: [
      {
        kind: "enum",
        name: "genre",
        label: "ジャンル",
        values: ["auto", "action", "horror", "comedy", "noir", "drama", "epic"],
        default: "auto",
      },
      { kind: "enum", name: "mode", label: "モード", values: ["std", "fast"], default: "std" },
      {
        kind: "enum",
        name: "resolution",
        label: "解像度",
        values: ["480p", "720p", "1080p"],
        default: "720p",
      },
    ],
    i2vInputField: "medias",
    inputMode: "both",
    costEstimate: 22,
  },
  {
    id: "veo3_1",
    label: "Google Veo 3.1",
    jobSetType: "veo3_1",
    description: "Google品質。quality 3段階、duration は 8秒固定。",
    aspectRatios: ["16:9", "9:16"],
    defaultAspectRatio: "16:9",
    // 実制約 (higgsfield model get veo3_1): 8秒固定 (min 8 / max 8)
    duration: { kind: "enum", values: [8], default: 8 },
    extraParams: [
      {
        kind: "enum",
        name: "model",
        label: "モデル variant",
        values: ["veo-3-1-preview", "veo-3-1-fast"],
        default: "veo-3-1-fast",
      },
      { kind: "enum", name: "quality", label: "品質", values: ["basic", "high", "ultra"], default: "basic" },
    ],
    i2vInputField: "input_image",
    inputMode: "both",
    costEstimate: 22,
  },
];

export function findVideoModel(id: VideoModelId | string): VideoModelDefinition | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}
