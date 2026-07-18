/**
 * シーン再現(映像分析) MVP の型定義。
 *
 * 参考動画のキーフレーム(時系列スクショ)を映像文法で分析し、
 * ショット割り・カメラワーク・演出意図を構造化する。
 * codex は動画ファイルを直接見られないため、MVP は「ユーザーが時系列順の
 * キーフレーム画像を投入する」方式で成立させる(将来: 自動フレーム抽出)。
 *
 * 全て frozen 前提の純データ型。可変メソッドは持たせない。
 */

/** ショットサイズ(画面に占める被写体の大きさ)。 */
export type ShotSize =
  | "extreme-close-up"
  | "close-up"
  | "medium"
  | "long"
  | "extreme-long"
  | "unknown";

/** ショットサイズの日本語ラベル(表示用)。 */
export const SHOT_SIZE_LABELS: Record<ShotSize, string> = {
  "extreme-close-up": "ドアップ",
  "close-up": "クローズアップ",
  medium: "ミディアム",
  long: "ロング",
  "extreme-long": "ロングショット(引き)",
  unknown: "不明",
};

/** カメラワークの推定(静止画列からの推定なので確定でなく推定)。 */
export type CameraWork =
  | "fixed"
  | "pan"
  | "tilt"
  | "dolly"
  | "zoom"
  | "handheld"
  | "crane"
  | "unknown";

/** カメラワークの日本語ラベル(表示用)。 */
export const CAMERA_WORK_LABELS: Record<CameraWork, string> = {
  fixed: "固定(FIX)",
  pan: "パン",
  tilt: "ティルト",
  dolly: "ドリー(寄り引き)",
  zoom: "ズーム",
  handheld: "手持ち",
  crane: "クレーン",
  unknown: "不明",
};

/** カメラアングル。 */
export type CameraAngle =
  | "eye-level"
  | "high-angle"
  | "low-angle"
  | "birds-eye"
  | "dutch"
  | "unknown";

/** カメラアングルの日本語ラベル(表示用)。 */
export const CAMERA_ANGLE_LABELS: Record<CameraAngle, string> = {
  "eye-level": "アイレベル",
  "high-angle": "ハイアングル(俯瞰)",
  "low-angle": "ローアングル(あおり)",
  "birds-eye": "真俯瞰",
  dutch: "ダッチ(傾き)",
  unknown: "不明",
};

/** 1ショット分の分析結果。 */
export type ShotAnalysis = {
  /** ショット番号(1始まり)。 */
  shotNumber: number;
  shotSize: ShotSize;
  angle: CameraAngle;
  /** 静止画列から推定したカメラワーク。 */
  cameraWork: CameraWork;
  /** 被写体の動きとその目的(何を見せたいか)。 */
  subjectMotion: string;
  /** カット(次ショットへ切る)の動機。 */
  cutMotivation: string;
  /** 演出意図の言語化(なぜこのショットか)。 */
  directorialIntent: string;
};

/** シーン全体の分析結果。 */
export type SceneAnalysis = {
  shots: ShotAnalysis[];
  /** 180度ルール・視線誘導の分析。 */
  continuityAndEyeline: string;
  /** シーン全体の演出構造(起承転結・リズム・狙い)。 */
  overallStructure: string;
};

/** 分析の実行フェーズ状態。 */
export type AnalyzeStatus = "idle" | "describing" | "analyzing" | "done" | "error";

/** 1キーフレームの投入エントリ(時系列順に並ぶ)。 */
export type Keyframe = {
  /** 安定 key(並べ替えでも維持)。 */
  id: string;
  /** ローカルの絶対パス。 */
  path: string;
};

/** 再現用に生成した1ショット分のプロンプト。 */
export type RecreateShotPrompt = {
  shotNumber: number;
  shotSizeLabel: string;
  cameraLabel: string;
  /** コピーして使える1ショット分の再現プロンプト。 */
  prompt: string;
};
