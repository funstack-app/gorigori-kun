import { codexTextQuery } from "../agents/codexQuery";
import type { ImagePromptJson, VideoPromptJson } from "./buildPromptJson";
import {
  ALLOWED_IMAGE_KEYS,
  ALLOWED_VIDEO_KEYS,
  keepAllowedKeys,
} from "./promptFormat";

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
- Output keys must be a subset of the input keys (no new keys).
- If a "timeline" key exists, keep entries in chronological order and keep
  each "time" range exactly as given.`;

/**
 * テキスト入力 (手入力・企画由来) を構造化する用のシステムプロンプト。
 *
 * 構造化入力用 (上の *_SYSTEM_PROMPT) と分ける理由: 入力が JSON でないため
 * 「入力キーの部分集合」検証が構造的に使えない。キー集合をプロンプトで固定し、
 * コード側は promptFormat.keepAllowedKeys の whitelist で二重に縛る。
 */
const IMAGE_STRUCTURE_SYSTEM_PROMPT = `You convert a free-form image-generation prompt into a structured JSON object.

Rules (follow strictly):
- Input is free text written by the user (Japanese or English). It may be a
  rough idea adopted from a planning chat.
- Output ONLY a JSON object. No prose, no markdown fence.
- Allowed keys (use only these; all optional; no other keys):
  subject, shot_size, camera_angle, framing, aspect_ratio, environment,
  lighting, mood, camera, shot, style.
- Sort what the text says into the matching keys. Write values as concise
  English noun phrases (translate Japanese). Each value under ~15 words.
- Do NOT invent, add, or infer any element the text does not mention.
  Adding unrequested subjects, props, colors, or moods is a failure.
- Do NOT drop information. If something fits no key, append it to "subject".
- Keep any aspect ratio or numeric values exactly as written.
- If the text contains "@img1"-style reference mentions, keep them inside the
  value text as-is. Do not create a separate key for them.`;

const VIDEO_STRUCTURE_SYSTEM_PROMPT = `You convert a free-form video-generation prompt into a structured JSON object.

Rules (follow strictly):
- Input is free text written by the user (Japanese or English). It may be a
  rough idea adopted from a planning chat.
- Output ONLY a JSON object. No prose, no markdown fence.
- Allowed keys (use only these; all optional; no other keys):
  subject, scene, subject_motion, motion_strength, camera_motion, staging,
  lighting, mood, style, aspect_ratio, duration_seconds, timeline.
- Sort what the text says into the matching keys. Write values as concise
  English phrases (translate Japanese). Each value under ~15 words.
- Motion keys (subject_motion, camera_motion, motion_strength) describe change
  over time. Write them as motion, never as static poses.
- Video best practice: if the text describes two or more actions happening in
  sequence, add "timeline": an array of {"time": "0-2s", "action": "...",
  "camera": "..."} entries in chronological order. "time" is a start-end range
  in seconds. If total duration is known, the last range must end at it.
  For a single continuous action, do NOT add a timeline.
- Do NOT invent, add, or infer any element the text does not mention.
  Adding unrequested motion, camera moves, or scene details is a failure.
- Do NOT drop information. If something fits no key, append it to "scene".
- Keep any aspect ratio, duration, or numeric values exactly as written.
- If the text contains "@img1"-style reference mentions, keep them inside the
  value text as-is. Do not create a separate key for them.`;

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

/**
 * 「AIで整える」の入力。
 * - structured: シーン構築の選択から積まれた JSON
 * - text: textarea に表示中のテキスト (手入力・企画由来の両方がここに入る)
 */
export type RefineInput<T extends object> =
  | { kind: "structured"; json: T }
  | { kind: "text"; text: string };

export type RefineFlowResult<T> = {
  /** 整形後 JSON。null = テキスト経路で構造化に失敗 (textarea は変更しない)。
   *  構造化経路の失敗時は従来どおり入力 JSON がそのまま入る。 */
  json: T | null;
  /** LLM 整形が実際に行われたか。 */
  refined: boolean;
  /** 決定論変換のみ (LLM 未使用・手貼り JSON の whitelist 濾過) だったか。 */
  converted: boolean;
  /** 失敗理由 (UI 表示用)。成功時 undefined。 */
  error?: string;
};

/**
 * テキストを構造化する。まず JSON として読めるなら LLM を使わず whitelist 濾過
 * だけで済ませ (過去の整形結果・手貼り JSON の形式変換が無料になる)、
 * 読めないときだけ LLM の構造化プロンプトへ回す。
 */
async function refineText<T extends object>(
  text: string,
  systemPrompt: string,
  allowedKeys: readonly string[],
  signal?: AbortSignal,
): Promise<RefineFlowResult<T>> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { json: null, refined: false, converted: false, error: "整える要素がありません" };
  }

  // 1) すでに構造化テキスト (JSON) ならば決定論変換のみ。LLM を呼ばない。
  const preParsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  })();
  const preFiltered = preParsed === null ? null : keepAllowedKeys<T>(preParsed, allowedKeys);
  if (preFiltered) {
    return { json: preFiltered, refined: false, converted: true };
  }

  // 2) 自由文 → LLM でメディア別スキーマへ仕分ける。
  try {
    const result = await codexTextQuery({
      prompt: trimmed,
      systemPrompt,
      expectJson: true,
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

    const safe = keepAllowedKeys<T>(parsed, allowedKeys);
    if (!safe) {
      return {
        json: null,
        refined: false,
        converted: false,
        error: "AIの応答を解釈できませんでした",
      };
    }
    return { json: safe, refined: true, converted: false };
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") throw err;
    return {
      json: null,
      refined: false,
      converted: false,
      error: (err as Error)?.message ?? "整形に失敗しました",
    };
  }
}

/** 画像の「AIで整える」。入力ソース (構造化 / テキスト) を問わず使える。 */
export async function refineImageInput(
  input: RefineInput<ImagePromptJson>,
  signal?: AbortSignal,
): Promise<RefineFlowResult<ImagePromptJson>> {
  if (input.kind === "structured") {
    const result = await refine(input.json, IMAGE_SYSTEM_PROMPT, signal);
    return { json: result.json, refined: result.refined, converted: false, error: result.error };
  }
  return refineText<ImagePromptJson>(
    input.text,
    IMAGE_STRUCTURE_SYSTEM_PROMPT,
    ALLOWED_IMAGE_KEYS,
    signal,
  );
}

/** 動画の「AIで整える」。入力ソース (構造化 / テキスト) を問わず使える。 */
export async function refineVideoInput(
  input: RefineInput<VideoPromptJson>,
  signal?: AbortSignal,
): Promise<RefineFlowResult<VideoPromptJson>> {
  if (input.kind === "structured") {
    const result = await refine(input.json, VIDEO_SYSTEM_PROMPT, signal);
    return { json: result.json, refined: result.refined, converted: false, error: result.error };
  }
  return refineText<VideoPromptJson>(
    input.text,
    VIDEO_STRUCTURE_SYSTEM_PROMPT,
    ALLOWED_VIDEO_KEYS,
    signal,
  );
}
