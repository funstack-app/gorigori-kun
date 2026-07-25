import { codexTextQuery } from "../agents/codexQuery";
import type { ImagePromptJson, VideoPromptJson } from "./buildPromptJson";

/**
 * 「AIで整える」— 選択から積まれた JSON を、生成AIが読みやすい構造化プロンプトへ整える。
 *
 * ## 設計の制約 (2026-07-25 STΛCK指示)
 *
 * - **余計なことはしない**。ユーザーが選んでいない要素を勝手に足さない。
 *   「AIが盛る」ことが最大の事故なので、システムプロンプトで明示的に禁じる。
 * - **長くしすぎない**。冗長な形容詞の水増しは品質を上げず、モデルの注意を薄める。
 * - **裏で軽量モデルを使う**。整形は難しい判断ではないので low effort で十分。
 * - 画像と動画で **別スキーマ**。動画は時間軸の軸を持つため同じ形にできない。
 *
 * 失敗したら元の JSON をそのまま返す (整形は補助機能であり、
 * 失敗して作業が止まる方が悪い)。
 */

const IMAGE_SYSTEM_PROMPT = `You refine a structured image-generation prompt.

Rules (follow strictly):
- Input is JSON describing what the user explicitly chose.
- Output ONLY a JSON object. No prose, no markdown fence.
- Do NOT invent, add, or infer any element the user did not choose.
  Adding unrequested subjects, props, colors, or moods is a failure.
- Keep every key that exists in the input. Do not drop information.
- You MAY rewrite each value into clearer, more model-readable English
  (concise noun phrases; remove redundancy; fix vague wording).
- You MAY merge duplicated meaning between keys, but never delete an axis.
- Keep it SHORT. Each value should stay under ~15 words.
  Do not pad with decorative adjectives.
- Keep aspect_ratio, references, and any numeric values exactly as given.
- Output keys must be a subset of the input keys (no new keys).`;

const VIDEO_SYSTEM_PROMPT = `You refine a structured video-generation prompt.

Rules (follow strictly):
- Input is JSON describing what the user explicitly chose.
- Output ONLY a JSON object. No prose, no markdown fence.
- Do NOT invent, add, or infer any element the user did not choose.
  Adding unrequested motion, camera moves, or scene details is a failure.
- Keep every key that exists in the input. Do not drop information.
- You MAY rewrite each value into clearer, more model-readable English
  (concise phrases; remove redundancy; fix vague wording).
- Motion keys (subject_motion, camera_motion, motion_strength) describe change
  over time. Keep them as motion descriptions, never as static poses.
- Keep it SHORT. Each value should stay under ~15 words.
- Keep aspect_ratio, duration_seconds, references exactly as given.
- Output keys must be a subset of the input keys (no new keys).`;

export type RefineResult<T> = {
  /** 整形後の JSON。失敗時は入力をそのまま返す。 */
  json: T;
  /** 整形が実際に行われたか。false なら入力のまま。 */
  refined: boolean;
  /** 失敗理由 (UI で軽く伝える用)。成功時は undefined。 */
  error?: string;
};

/** 入力キーの部分集合であることを検証する。新しいキーを勝手に足させない。 */
function keepSubsetOfInput<T extends object>(input: T, output: unknown): T | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const inputKeys = new Set(Object.keys(input));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    // 入力に無いキーは捨てる (勝手な追加を構造的に防ぐ)
    if (!inputKeys.has(key)) continue;
    if (value === undefined || value === null) continue;
    result[key] = value;
  }
  // 入力にあったキーが全部消えていたら整形失敗とみなす
  if (Object.keys(result).length === 0) return null;
  return result as T;
}

async function refine<T extends object>(
  json: T,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<RefineResult<T>> {
  const keys = Object.keys(json);
  if (keys.length === 0) {
    return { json, refined: false, error: "整える要素がありません" };
  }

  try {
    const result = await codexTextQuery({
      prompt: JSON.stringify(json, null, 2),
      systemPrompt,
      expectJson: true,
      // 整形は軽い作業。長く待たせない (失敗したら元のまま使えばよい)
      timeoutSecs: 45,
      signal,
    });

    const parsed =
      result.parsedJson ??
      (() => {
        try {
          return JSON.parse(result.text);
        } catch {
          return null;
        }
      })();

    const safe = keepSubsetOfInput(json, parsed);
    if (!safe) {
      return { json, refined: false, error: "AIの応答を解釈できませんでした" };
    }
    return { json: safe, refined: true };
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") throw err;
    return {
      json,
      refined: false,
      error: (err as Error)?.message ?? "整形に失敗しました",
    };
  }
}

/** 画像生成プロンプトを整える。 */
export function refineImagePrompt(
  json: ImagePromptJson,
  signal?: AbortSignal,
): Promise<RefineResult<ImagePromptJson>> {
  return refine(json, IMAGE_SYSTEM_PROMPT, signal);
}

/** 動画生成プロンプトを整える。 */
export function refineVideoPrompt(
  json: VideoPromptJson,
  signal?: AbortSignal,
): Promise<RefineResult<VideoPromptJson>> {
  return refine(json, VIDEO_SYSTEM_PROMPT, signal);
}
