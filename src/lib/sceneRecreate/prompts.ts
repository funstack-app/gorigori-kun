/**
 * シーン再現(映像分析)のプロンプト構築 + Codex 応答の解釈。
 *
 * 映像文法の判定基準をプロンプトに焼き込む。codex は動画を直接見られないので、
 * (1) 各キーフレームを個別に codex_describe_image で説明文化 → (2) その説明文列 +
 * ユーザーの補足を codex_text_query に渡して JSON でショット割りを構造化する、
 * という2段構成をとる(呼び出しは analyze.ts)。
 *
 * 未信頼入力(Codex 応答)の検証はこのファイルの normalizeSceneAnalysis に集約する。
 */

import {
  CAMERA_ANGLE_LABELS,
  CAMERA_WORK_LABELS,
  SHOT_SIZE_LABELS,
  type CameraAngle,
  type CameraWork,
  type SceneAnalysis,
  type ShotAnalysis,
  type ShotSize,
} from "./types";

const VALID_SHOT_SIZES: ShotSize[] = [
  "extreme-close-up",
  "close-up",
  "medium",
  "long",
  "extreme-long",
  "unknown",
];
const VALID_CAMERA_WORKS: CameraWork[] = [
  "fixed",
  "pan",
  "tilt",
  "dolly",
  "zoom",
  "handheld",
  "crane",
  "unknown",
];
const VALID_ANGLES: CameraAngle[] = [
  "eye-level",
  "high-angle",
  "low-angle",
  "birds-eye",
  "dutch",
  "unknown",
];

/**
 * 1キーフレームを説明文化するためのプロンプト(codex_describe_image は固定の
 * 「再現用英語プロンプトを返せ」なので、こちらは映像分析向けの視点を持たせる)。
 * ※ codex_describe_image は image_path のみ受け取り prompt を渡せないため、
 *   この関数の出力は「テキスト集約段(analyze.ts の第2段)」でフレーム説明を
 *   束ねる際のラベルづけに使う。実画像の説明は codex_describe_image が担う。
 */
export function frameLabel(index: number): string {
  return `フレーム${index + 1}`;
}

/** シーン全体をショット割りへ構造化させる system プロンプト(映像文法の判定基準)。 */
export const SCENE_ANALYSIS_SYSTEM_PROMPT = [
  "あなたはプロの映像ディレクター兼シネマトグラファーです。",
  "参考動画のキーフレーム(時系列順の静止画)の説明文列と、ユーザーの補足を受け取り、",
  "映像文法(film grammar)の観点でショット割りと演出意図を分析します。",
  "",
  "判定基準:",
  "- ショットサイズ: 画面に占める被写体の大きさ。extreme-close-up / close-up / medium / long / extreme-long のいずれか。判別不能は unknown。",
  "- アングル: eye-level(アイレベル) / high-angle(俯瞰) / low-angle(あおり) / birds-eye(真俯瞰) / dutch(傾き)。不明は unknown。",
  "- カメラワーク: 連続フレーム間の被写体・背景の位置変化から推定する。fixed(固定) / pan(横振り) / tilt(縦振り) / dolly(前後移動=寄り引き) / zoom(画角変化) / handheld(手持ちの揺れ) / crane。静止画列からの推定なので確信がなければ unknown。",
  "- 被写体の動きと目的: 何をどう見せるための動きか(視線を誘導する/緊張を高める 等)。",
  "- カットの動機: なぜここで次のショットに切るか(アクションつなぎ/視線つなぎ/リアクション/情報開示 等)。",
  "- 演出意図: そのショットが観客に与える効果を言語化する。",
  "",
  "シーン全体では:",
  "- 180度ルール(イマジナリーライン): 被写体の位置関係・視線方向が一貫しているか。破っている箇所があれば指摘する。",
  "- 視線誘導: 構図・動き・被写界深度で観客の視線をどこへ導いているか。",
  "- 演出構造: シーン全体の起承転結・リズム・狙い。",
  "",
  "出力は必ず次の JSON のみ(説明文・前置き・Markdown コードフェンスは不要):",
  "{",
  '  "shots": [',
  "    {",
  '      "shotNumber": 1,',
  '      "shotSize": "medium",',
  '      "angle": "eye-level",',
  '      "cameraWork": "fixed",',
  '      "subjectMotion": "被写体の動きと目的(日本語)",',
  '      "cutMotivation": "カットの動機(日本語)",',
  '      "directorialIntent": "演出意図の言語化(日本語)"',
  "    }",
  "  ],",
  '  "continuityAndEyeline": "180度ルールと視線誘導の分析(日本語)",',
  '  "overallStructure": "シーン全体の演出構造(日本語)"',
  "}",
  "",
  "shotSize / angle / cameraWork は上記の英語 enum 値のみを使う。それ以外の説明語を混ぜない。",
].join("\n");

/**
 * 第2段(集約)のユーザープロンプトを組む。
 * frameDescriptions は各キーフレームの説明文(codex_describe_image 由来)を時系列順に並べたもの。
 */
export function buildSceneAnalysisPrompt(args: {
  frameDescriptions: string[];
  userNote: string;
}): string {
  const frames = args.frameDescriptions
    .map((desc, i) => `${frameLabel(i)}: ${desc.trim() || "(説明取得に失敗)"}`)
    .join("\n");
  const note = args.userNote.trim();
  const parts = [
    "以下は参考動画のキーフレーム(時系列順)の説明です。",
    "隣り合うフレームの差分からカメラワーク・被写体の動きを推定し、ショット割りに分割してください。",
    "同一ショットが複数フレームにまたがることも、1フレームで複数ショットが切り替わることもあります。",
    "",
    "【キーフレーム説明】",
    frames,
  ];
  if (note) {
    parts.push("", "【ユーザーの補足(何が良いと感じたか・参考URL等)】", note);
  }
  parts.push("", "上記を映像文法で分析し、指定の JSON だけを返してください。");
  return parts.join("\n");
}

/**
 * 自分のキャラ/商品で再現するための、1ショット分のプロンプト本文を組む。
 * subjectPrompt はキャラ型プリセット由来の被写体記述(空可)。
 */
export function buildRecreateShotPrompt(args: {
  shot: ShotAnalysis;
  subjectPrompt: string;
}): string {
  const subject = args.subjectPrompt.trim() || "(あなたの被写体・キャラ・商品)";
  const lines = [
    `${subject} を撮る。`,
    `ショットサイズ: ${SHOT_SIZE_LABELS[args.shot.shotSize]}`,
    `アングル: ${CAMERA_ANGLE_LABELS[args.shot.angle]}`,
    `カメラワーク: ${CAMERA_WORK_LABELS[args.shot.cameraWork]}`,
    `被写体の動き: ${args.shot.subjectMotion.trim()}`,
    `狙い: ${args.shot.directorialIntent.trim()}`,
  ];
  return lines.filter((l) => l.trim().length > 0).join(" / ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex 応答(未信頼入力)の検証・正規化
// ─────────────────────────────────────────────────────────────────────────────

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asEnum<T extends string>(value: unknown, valid: T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase() as T;
  return valid.includes(v) ? v : fallback;
}

function normalizeShot(raw: unknown, index: number): ShotAnalysis | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const shotNumber =
    typeof r.shotNumber === "number" && Number.isFinite(r.shotNumber)
      ? Math.trunc(r.shotNumber)
      : index + 1;
  return {
    shotNumber,
    shotSize: asEnum(r.shotSize, VALID_SHOT_SIZES, "unknown"),
    angle: asEnum(r.angle, VALID_ANGLES, "unknown"),
    cameraWork: asEnum(r.cameraWork, VALID_CAMERA_WORKS, "unknown"),
    subjectMotion: asString(r.subjectMotion),
    cutMotivation: asString(r.cutMotivation),
    directorialIntent: asString(r.directorialIntent),
  };
}

/**
 * Codex の parsedJson を SceneAnalysis へ正規化する。
 * shots が空/壊れなら null を返す(silent gap filling を避け、呼び出し側でエラー表示)。
 */
export function normalizeSceneAnalysis(parsed: unknown): SceneAnalysis | null {
  if (parsed == null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const rawShots = Array.isArray(p.shots) ? p.shots : [];
  const shots = rawShots
    .map((s, i) => normalizeShot(s, i))
    .filter((s): s is ShotAnalysis => s != null);
  if (shots.length === 0) return null;
  return {
    shots,
    continuityAndEyeline: asString(p.continuityAndEyeline),
    overallStructure: asString(p.overallStructure),
  };
}
