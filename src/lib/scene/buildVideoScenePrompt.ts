import { NO_SELECT } from "./catalog";
import type { VideoSceneState } from "./video-types";

/**
 * 動画シーン構築 (useVideoSceneStore) の4軸から、i2v 映像文脈型の英語プロンプトを
 * 組み立てる。
 *
 * 設計 (2026-05-29 i2v再設計, Claude + Codex クロスレビュー):
 * - t2iタグ羅列 (`key: value, ...`) をやめ、短い英文 (映像指示文) にする。
 * - i2v では first frame に既にある静的情報 (構図/服装/外見) を再説明しない。
 * - 動き・カメラ・環境変化に振り切る。
 * - 出力例:
 *     "The subject slowly walks forward. The camera gently pushes in.
 *      Rain falls steadily across the scene. Cinematic look."
 *
 * 動画モデル (Kling/Seedance/Veo) は英語の方が安定するため、UIの日本語値を
 * 動詞句・節へ変換する。辞書に無い値 (自由記述の主役) はそのまま使う。
 */

/** 被写体の動き → 動詞句 (主語のあとに続く) */
const MOTION_VERB: Record<string, string> = {
  歩く: "walks forward",
  走る: "runs forward",
  近づく: "moves closer to the camera",
  離れる: "walks away into the distance",
  後ずさる: "steps backward",
  振り返る: "turns around to look back",
  見渡す: "looks around the surroundings",
  見上げる: "looks up toward the sky",
  見下ろす: "looks down toward the ground",
  フレーム侵入: "walks into the frame",
  フレーム退出: "walks out of the frame",
  倒れる: "slowly falls to the ground",
  座る: "sits down",
  跳ぶ: "jumps up",
  笑う: "gradually smiles",
  泣く: "begins to cry softly",
  驚く: "reacts with surprise",
};

/** 動きの強度 → 副詞 (動詞句の前に挿入) */
const MOTION_INTENSITY: Record<string, string> = {
  ゆっくり: "slowly",
  繊細に: "with subtle motion,",
  標準: "",
  力強く: "with bold, energetic motion,",
  速め: "quickly",
};

/** カメラの動き → カメラ文 */
const CAMERA_MOTION: Record<string, string> = {
  静止: "The camera stays locked-off",
  パン左: "The camera pans to the left",
  パン右: "The camera pans to the right",
  チルトアップ: "The camera tilts up",
  チルトダウン: "The camera tilts down",
  ドリーイン: "The camera pushes in toward the subject",
  ドリーアウト: "The camera pulls back from the subject",
  トラッキング: "The camera tracks alongside the subject",
  クレーン: "The camera rises in a crane movement",
  ハンディ手ブレ: "The camera follows with a subtle handheld shake",
  オービット: "The camera orbits around the subject",
};

/** カメラ速度 → 副詞 */
const CAMERA_SPEED: Record<string, string> = {
  スロー: "slowly",
  標準: "",
  高速: "quickly",
};

/** ライティング → 動的な光の変化として書く */
const LIGHTING: Record<string, string> = {
  自然光: "soft natural light fills the scene",
  スタジオ: "even studio light wraps the subject",
  逆光: "backlight rims the subject",
  夕暮れ: "warm golden light flares across the scene",
  キャンドル: "warm candlelight flickers",
  ネオン: "neon light glows across the scene",
  フラッシュ: "harsh light flashes",
};

/** 天候 → 環境の動き */
const WEATHER: Record<string, string> = {
  晴れ: "under a clear sky",
  曇り: "under soft overcast light",
  雨: "rain falls steadily across the scene",
  雪: "snow drifts gently through the air",
  霧: "fog rolls slowly through the scene",
};

/** 環境の動き */
const ENVIRONMENT: Record<string, string> = {
  風で草が揺れる: "wind moves through the grass",
  煙が立ち込める: "smoke drifts through the air",
  水面の反射: "reflections ripple across the surface",
  木の葉が舞う: "leaves drift through the air",
  光が揺らぐ: "light flickers softly",
};

/** スタイル → 末尾に短く */
const STYLE: Record<string, string> = {
  シネマティック: "Cinematic look.",
  ドキュメンタリー: "Documentary style.",
  ミュージックビデオ: "Music video style.",
  CM: "Polished commercial style.",
  雑誌: "Editorial style.",
  アニメ: "Anime-style motion.",
  フィルム: "Film grain look.",
  VHS: "Lo-fi VHS look.",
};

function has(value: string): boolean {
  const t = value.trim();
  return t.length > 0 && t !== NO_SELECT;
}

function lookup(dict: Record<string, string>, value: string): string {
  return dict[value.trim()] ?? "";
}

/** 文の先頭を大文字化し、末尾にピリオドを付ける */
function sentence(parts: Array<string | undefined>): string {
  const text = parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
  if (!text) return "";
  const capped = text.charAt(0).toUpperCase() + text.slice(1);
  return capped.endsWith(".") || capped.endsWith(",") ? capped.replace(/,$/, ".") : `${capped}.`;
}

/**
 * 4軸シーン状態から i2v 映像文脈プロンプトを生成する。
 * 何も選んでいなければ空文字 (起動時0要素)。
 */
export function buildVideoScenePrompt(scene: VideoSceneState): string {
  const sentences: string[] = [];

  // 主役 (参照ラベル)。自由記述はそのまま、無ければ "The subject"
  const subjectText = scene.subject.text.trim();
  const subject = subjectText || "the subject";

  // 1. 主役の動き文: "The subject slowly walks forward."
  if (has(scene.motion.verb)) {
    const verb = lookup(MOTION_VERB, scene.motion.verb) || scene.motion.verb;
    const intensity = has(scene.motion.intensity)
      ? lookup(MOTION_INTENSITY, scene.motion.intensity)
      : "";
    sentences.push(sentence([subject, intensity, verb]));
  } else if (subjectText) {
    // 動きが無くても主役だけ書きたい場合
    sentences.push(sentence([subject, "stands in the scene"]));
  }

  // 2. カメラ文
  if (has(scene.camera.motion)) {
    const cam = lookup(CAMERA_MOTION, scene.camera.motion) || `The camera ${scene.camera.motion}`;
    const speed = has(scene.camera.speed) ? lookup(CAMERA_SPEED, scene.camera.speed) : "";
    sentences.push(sentence([cam, speed]));
  }

  // 3. 環境・天候の動き文
  const envParts: string[] = [];
  if (has(scene.staging.weather)) {
    const w = lookup(WEATHER, scene.staging.weather);
    if (w) envParts.push(w);
  }
  if (has(scene.staging.environment)) {
    const e = lookup(ENVIRONMENT, scene.staging.environment);
    if (e) envParts.push(e);
  }
  if (envParts.length > 0) {
    sentences.push(sentence([envParts.join(", ")]));
  }

  // 4. ライティング (動的)
  if (has(scene.staging.lighting)) {
    const l = lookup(LIGHTING, scene.staging.lighting);
    if (l) sentences.push(sentence([l]));
  }

  // 5. スタイル (末尾)
  if (has(scene.staging.style)) {
    const s = lookup(STYLE, scene.staging.style);
    if (s) sentences.push(s);
  }

  return sentences.filter((s) => s.length > 0).join(" ");
}
