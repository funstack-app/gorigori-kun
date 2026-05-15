import {
  NO_SELECT,
  cameraEquipmentOptions,
  shotOptions,
  styleOptions,
} from "./catalog";
import type { SceneReferenceSlot, SceneState } from "./types";

const labelTranslations: Record<string, string> = {
  自然光: "natural light",
  スタジオ: "studio lighting",
  逆光: "backlight",
  フィルム: "film camera",
  デジタル: "digital camera",
};

function normalizeLabel(value: string): string {
  return labelTranslations[value] ?? value;
}

function hasText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== NO_SELECT;
}

function piece(label: string, value: string): string | null {
  if (!hasText(value)) return null;
  return `${label}: ${normalizeLabel(value.trim())}`;
}

/**
 * 統合スタイル軸用。styleOptions の `prompt` 完成形があればそれを使い、
 * なければ value をそのまま label に渡す（旧データ・自由文の互換）。
 */
function stylePiece(styleValue: string): string | null {
  if (!hasText(styleValue)) return null;
  const matched = styleOptions.find((opt) => opt.value === styleValue);
  if (matched?.prompt) return `style: ${matched.prompt}`;
  return `style: ${styleValue.trim()}`;
}

/** カメラ機材軸。cameraEquipmentOptions の prompt があれば使う。 */
function cameraPiece(value: string): string | null {
  if (!hasText(value)) return null;
  const matched = cameraEquipmentOptions.find((opt) => opt.value === value);
  if (matched?.prompt) return `camera: ${matched.prompt}`;
  return `camera: ${value.trim()}`;
}

/** ショット幅軸（旧 焦点距離 + レンズ統合）。shotOptions から探す。 */
function shotPiece(value: string): string | null {
  if (!hasText(value)) return null;
  const matched = shotOptions.find((opt) => opt.value === value);
  if (matched?.prompt) return `shot: ${matched.prompt}`;
  return `shot: ${value.trim()}`;
}

function referencePhrase(slots: SceneReferenceSlot[]): string | null {
  const enabled = slots.filter((slot) => slot.enabled);
  if (enabled.length === 0) return null;
  const refs = enabled.map((slot) => {
    const note = slot.note.trim();
    return note ? `${slot.id} (${note})` : slot.id;
  });
  return `references: ${refs.join(", ")}`;
}

/**
 * Build a comma-separated prompt from the scene state.
 * Returns an empty string when nothing has been chosen so the
 * Prompt panel reports 0 elements at startup (no implicit defaults).
 *
 * 構造:
 *   [主役と構図] [光と雰囲気] [カメラ] [統合スタイル] [参照]
 *
 * 旧 photographerStyle / filter / freedom は廃止。
 * style.cinematicLook を統合スタイルの保存先として再利用。
 */
export function buildPrompt(scene: SceneState): string {
  const pieces: string[] = [];

  const subject = scene.subjectFraming.subject.trim();
  if (subject) pieces.push(`subject: ${subject}`);

  const composition = piece("composition", scene.subjectFraming.composition);
  if (composition) pieces.push(composition);

  const aspect = piece("aspect ratio", scene.subjectFraming.aspectRatio);
  if (aspect) pieces.push(aspect);

  const environment = piece("environment", scene.subjectFraming.environment);
  if (environment) pieces.push(environment);

  const light = piece("lighting", scene.lightingMood.lightSource);
  if (light) pieces.push(light);

  const mood = piece("mood", scene.lightingMood.mood);
  if (mood) pieces.push(mood);

  const camera = cameraPiece(scene.camera.equipment);
  if (camera) pieces.push(camera);

  // ショット幅は store 互換性のため focalLength を保存先として再利用。
  // 旧 lens / film フィールドは使わない（フィルムはスタイルに統合済み）。
  const shot = shotPiece(scene.camera.focalLength);
  if (shot) pieces.push(shot);

  // 統合スタイル（旧 cinematicLook の保存先を再利用）
  const style = stylePiece(scene.style.cinematicLook);
  if (style) pieces.push(style);

  const references = referencePhrase(scene.reference.slots);
  if (references) pieces.push(references);

  return pieces.join(", ");
}
