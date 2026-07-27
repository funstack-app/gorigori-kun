import {
  NO_SELECT,
  cameraEquipmentOptions,
  shotOptions,
  styleOptions,
} from "./catalog";
import type { SceneReferenceSlot, SceneState } from "./types";

/**
 * シーン構築の選択を **JSON 構造化プロンプト** に変換する。
 *
 * ## なぜ JSON か (2026-07-25 STΛCK指示)
 *
 * 従来の buildPrompt は `subject: X, composition: Y, lighting: Z` という
 * カンマ区切りのラベル付き文字列を作っていた。選択が増えるほど平坦に伸び、
 * どの語がどの軸なのかがモデルにも人にも読み取りにくい。
 *
 * JSON にすると (a) 軸と値の対応が明示される (b) 画像/動画で別スキーマを持てる
 * (c)「AIで整える」で構造を保ったまま自然文へ落とせる。
 * アスペクト比のような「値そのもの」も、文の一部でなく独立したキーになる。
 *
 * 空の軸はキーごと落とす (null を並べない)。選択していないことを
 * 「未指定」として明示的に書くと、モデルがそれを指示と誤読することがある。
 */

function hasText(value: string): boolean {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 && trimmed !== NO_SELECT;
}

const labelTranslations: Record<string, string> = {
  自然光: "natural light",
  スタジオ: "studio lighting",
  逆光: "backlight",
  フィルム: "film camera",
  デジタル: "digital camera",
};

function normalize(value: string): string {
  const trimmed = value.trim();
  return labelTranslations[trimmed] ?? trimmed;
}

/** カタログの `prompt` 完成形を優先し、無ければ値をそのまま使う。 */
function resolved(
  value: string,
  options: { value: string; prompt?: string }[],
): string | undefined {
  if (!hasText(value)) return undefined;
  const matched = options.find((opt) => opt.value === value);
  return matched?.prompt ?? value.trim();
}

function references(slots: SceneReferenceSlot[]) {
  const enabled = slots.filter((slot) => slot.enabled);
  if (enabled.length === 0) return undefined;
  return enabled.map((slot) => {
    const note = slot.note.trim();
    return note ? { slot: slot.id, note } : { slot: slot.id };
  });
}

/** 画像生成用の構造化プロンプト。undefined のキーは JSON 化時に落ちる。 */
export type ImagePromptJson = {
  subject?: string;
  /** 旧・単一の構図キー。3軸分割 (2026-07-27) 以降は使わないが、外部で参照されうるため型は残す。 */
  composition?: string;
  /** どこまで写すか (Close Up / Full Shot 等)。 */
  shot_size?: string;
  /** どこから撮るか (Low Angle / Profile View 等)。 */
  camera_angle?: string;
  /** どう見せるか (Rule of Thirds / Frame in Frame 等)。 */
  framing?: string;
  aspect_ratio?: string;
  environment?: string;
  lighting?: string;
  mood?: string;
  camera?: string;
  shot?: string;
  style?: string;
  references?: { slot: string; note?: string }[];
};

/**
 * 画像生成の JSON を組み立てる。
 * includeAspectRatio=false は「比率だけ別に渡す」呼び出し元向け。
 */
export function buildImagePromptJson(
  scene: SceneState,
  options?: { includeAspectRatio?: boolean },
): ImagePromptJson {
  const includeAspectRatio = options?.includeAspectRatio ?? true;
  const json: ImagePromptJson = {};

  const subject = scene.subjectFraming.subject.trim();
  if (subject) json.subject = subject;

  // 2026-07-27: 構図を3軸 (どこまで写す / どこから撮る / どう見せる) へ分割。
  // 併用できる指定なので、それぞれ別キーで出す。
  if (hasText(scene.subjectFraming.composition)) {
    json.shot_size = normalize(scene.subjectFraming.composition);
  }
  if (hasText(scene.subjectFraming.cameraAngle)) {
    json.camera_angle = normalize(scene.subjectFraming.cameraAngle);
  }
  if (hasText(scene.subjectFraming.framing)) {
    json.framing = normalize(scene.subjectFraming.framing);
  }
  if (includeAspectRatio && hasText(scene.subjectFraming.aspectRatio)) {
    json.aspect_ratio = scene.subjectFraming.aspectRatio.trim();
  }
  if (hasText(scene.subjectFraming.environment)) {
    json.environment = normalize(scene.subjectFraming.environment);
  }
  if (hasText(scene.lightingMood.lightSource)) {
    json.lighting = normalize(scene.lightingMood.lightSource);
  }
  if (hasText(scene.lightingMood.mood)) {
    json.mood = normalize(scene.lightingMood.mood);
  }

  const camera = resolved(scene.camera.equipment, cameraEquipmentOptions);
  if (camera) json.camera = camera;

  // ショット幅は store 互換のため focalLength を保存先として再利用している
  const shot = resolved(scene.camera.focalLength, shotOptions);
  if (shot) json.shot = shot;

  // 統合スタイルは cinematicLook を保存先として再利用している
  const style = resolved(scene.style.cinematicLook, styleOptions);
  if (style) json.style = style;

  const refs = references(scene.reference.slots);
  if (refs) json.references = refs;

  return json;
}

/**
 * 動画生成用の構造化プロンプト。
 * 画像と別スキーマにする理由: 動画は「時間軸」の軸 (動き・カメラワーク・尺) を持ち、
 * 画像側の静止画向けキー (composition 単体など) では表現できない。
 */
export type VideoPromptJson = {
  subject?: string;
  scene?: string;
  subject_motion?: string;
  motion_strength?: string;
  camera_motion?: string;
  staging?: string;
  lighting?: string;
  mood?: string;
  style?: string;
  aspect_ratio?: string;
  duration_seconds?: number;
  references?: { slot: string; note?: string }[];
};

/**
 * 動画用の JSON は buildVideoScenePrompt.ts 側で組み立てる
 * (英語表現の辞書がそこに private で置かれており、export して外から引くと
 *  結合が強くなる)。この型だけを共有する。
 */

/** JSON を整形文字列にする。キーが空なら空文字を返す (呼び出し側で分岐しやすい)。 */
export function stringifyPromptJson(
  json: ImagePromptJson | VideoPromptJson,
): string {
  const keys = Object.keys(json);
  if (keys.length === 0) return "";
  return JSON.stringify(json, null, 2);
}

/** JSON の軸数を数える (UI の「N要素」表示用)。 */
export function countPromptJsonElements(
  json: ImagePromptJson | VideoPromptJson,
): number {
  return Object.values(json).filter(
    (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0),
  ).length;
}
