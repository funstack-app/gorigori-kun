import { NO_SELECT } from "./catalog";
import type { VideoSceneState } from "./video-types";

/**
 * 動画シーン構築 (useVideoSceneStore) の 6 要素から、英語の動画生成プロンプトを
 * 組み立てる。画像版 buildPrompt.ts と同じ piece() パターン・カンマ区切り・
 * NO_SELECT スキップを踏襲する。
 *
 * 動画モデル (Kling/Seedance/Veo 等) は英語プロンプトの方が安定するため、
 * UI の日本語値を VIDEO_LABELS で英語へ変換してから流す。辞書に無い値
 * (自由記述の主役など) はそのまま渡す。
 */
const VIDEO_LABELS: Record<string, string> = {
  // 構図
  "Close Up": "close-up shot",
  Medium: "medium shot",
  Wide: "wide shot",
  "Bird's-eye": "bird's-eye view",
  "Dutch Angle": "dutch angle",
  "Over-the-shoulder": "over-the-shoulder shot",
  // カメラワーク
  静止: "static camera",
  パン左: "pan left",
  パン右: "pan right",
  チルトアップ: "tilt up",
  チルトダウン: "tilt down",
  ドリーイン: "dolly in",
  ドリーアウト: "dolly out",
  トラッキング: "tracking shot",
  クレーン: "crane shot",
  ハンディ手ブレ: "handheld shaky cam",
  オービット: "orbit around subject",
  // カメラ速度
  スロー: "slow movement",
  標準: "natural speed",
  高速: "fast movement",
  // カメラ開始位置
  中央: "starting centered",
  左寄り: "starting from the left",
  右寄り: "starting from the right",
  上寄り: "starting from a high angle",
  下寄り: "starting from a low angle",
  // 被写体の動き
  歩く: "walking",
  走る: "running",
  近づく: "approaching",
  離れる: "moving away",
  後ずさる: "stepping back",
  振り返る: "turning around",
  見渡す: "looking around",
  見上げる: "looking up",
  見下ろす: "looking down",
  フレーム侵入: "entering the frame",
  フレーム退出: "exiting the frame",
  倒れる: "falling down",
  座る: "sitting down",
  跳ぶ: "jumping",
  笑う: "smiling",
  泣く: "crying",
  驚く: "looking surprised",
  // ライティング
  自然光: "natural light",
  スタジオ: "studio lighting",
  逆光: "backlight",
  夕暮れ: "golden hour light",
  キャンドル: "candlelight",
  ネオン: "neon lighting",
  フラッシュ: "harsh flash light",
  // 時間帯
  朝: "morning",
  昼: "midday",
  夕: "dusk",
  夜: "night",
  マジックアワー: "magic hour",
  // 天候
  晴れ: "clear sky",
  曇り: "overcast",
  雨: "rainy",
  雪: "snowy",
  霧: "foggy",
  // スタイル
  シネマティック: "cinematic look",
  ドキュメンタリー: "documentary style",
  ミュージックビデオ: "music video style",
  CM: "commercial style",
  雑誌: "editorial style",
  アニメ: "anime style",
  フィルム: "film grain look",
  VHS: "lo-fi VHS look",
  // テンポ
  速め: "fast pacing",
  ゆっくり: "slow pacing",
};

function hasValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== NO_SELECT;
}

function normalize(value: string): string {
  const trimmed = value.trim();
  return VIDEO_LABELS[trimmed] ?? trimmed;
}

function piece(label: string, value: string): string | null {
  if (!hasValue(value)) return null;
  return `${label}: ${normalize(value)}`;
}

/**
 * 動画シーン状態からカンマ区切りプロンプトを生成する。
 * 何も選んでいなければ空文字を返す (起動時に 0 要素表示)。
 *
 * 構造:
 *   [主役] [構図] [被写体の動き] [カメラワーク] [カメラ速度]
 *   [開始位置] [ライティング] [時間帯] [天候] [スタイル]
 */
export function buildVideoScenePrompt(scene: VideoSceneState): string {
  const pieces: Array<string | null> = [];

  const subject = scene.subject.text.trim();
  if (subject) pieces.push(`subject: ${subject}`);

  pieces.push(piece("composition", scene.subject.composition));
  pieces.push(piece("subject motion", scene.motion.verb));
  pieces.push(piece("camera movement", scene.cameraMovement.motion));
  pieces.push(piece("camera speed", scene.cameraMovement.speed));
  pieces.push(piece("camera start", scene.cameraMovement.startPosition));
  pieces.push(piece("lighting", scene.lighting.source));
  pieces.push(piece("time of day", scene.lighting.timeOfDay));
  pieces.push(piece("weather", scene.lighting.weather));
  pieces.push(piece("style", scene.style.look));

  return pieces.filter((p): p is string => p !== null).join(", ");
}
