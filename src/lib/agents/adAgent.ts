import { codexTextQuery } from "./codexQuery";
import {
  AD_COPY_AGENT_SYSTEM_PROMPT,
  AD_PITCH_AGENT_SYSTEM_PROMPT,
} from "./systemPrompts";
import type {
  AdCopyInput,
  AdCopyResult,
  AdPitch,
  AdPitchInput,
  AdPitchResult,
  AdTargetInput,
  AgentResult,
  AgentRunner,
  AppealAxis,
} from "./types";

const AXIS_LABELS: Record<AppealAxis, string> = {
  functional: "機能訴求",
  emotional: "感情訴求",
  comparative: "比較訴求",
  empathy: "共感訴求",
};

const AD_PITCH_JSON_INSTRUCTION = [
  "JSON 形式のみで返してください。",
  '出力例: {"pitches":[{"id":"pitch-1","axis":"functional","title":"短い案名","angle":"画像広告に使う訴求角度","reason":"このターゲットに効く理由"}]}',
  "axis は functional / emotional / comparative / empathy のいずれか。pitches は必ず3件。",
].join("\n");

const AD_COPY_JSON_INSTRUCTION = [
  "JSON 形式のみで返してください。",
  '出力例: {"mainCopy":"画像内に置ける短いメインコピー","subCopy":"補足コピー"}',
].join("\n");

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Agent request was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asAppealAxis(value: unknown): AppealAxis | undefined {
  return value === "functional" ||
    value === "emotional" ||
    value === "comparative" ||
    value === "empathy"
    ? value
    : undefined;
}

function targetSummary(target: AdTargetInput): string {
  return [
    target.age,
    target.gender,
    target.attribute,
    target.pain ? `悩み: ${target.pain}` : undefined,
  ]
    .map((part: string | undefined): string => part?.trim() ?? "")
    .filter((part: string): boolean => part.length > 0)
    .join(" / ");
}

function selectedAxes(axis: AppealAxis | undefined): AppealAxis[] {
  if (axis) {
    const candidates: AppealAxis[] = [axis, "empathy", "functional"];
    return candidates.filter(
      (value: AppealAxis, index: number, array: AppealAxis[]): boolean =>
        array.indexOf(value) === index,
    );
  }
  return ["functional", "emotional", "empathy"];
}

function buildMockPitchResult(input: AdPitchInput): AgentResult<AdPitchResult> {
  const summary = targetSummary(input.target);
  const axes = selectedAxes(input.appealAxis);
  const pain = input.target.pain?.trim() || "今の不満";
  const product = input.product.trim() || "商品/サービス";

  const pitches: AdPitch[] = axes.slice(0, 3).map(
    (axis: AppealAxis, index: number): AdPitch => ({
      id: `pitch-${index + 1}`,
      axis,
      title:
        axis === "functional"
          ? `${product}で時間と手間を減らす`
          : axis === "emotional"
            ? `${product}が日常の気分を変える瞬間`
            : axis === "comparative"
              ? "いつもの選択では届かない価値"
              : `${pain}に寄り添う選択`,
      angle:
        axis === "functional"
          ? "機能・手軽さ・成果を正面から見せる"
          : axis === "emotional"
            ? "使用後の気持ちの変化を主役にする"
            : axis === "comparative"
              ? "従来の選択との違いを一目で伝える"
              : "ターゲットの悩みを代弁して距離を縮める",
      reason: summary
        ? `${summary} に対して ${AXIS_LABELS[axis]} が使いやすい。`
        : `${AXIS_LABELS[axis]} として画像広告に展開しやすい。`,
    }),
  );

  const data: AdPitchResult = { pitches };
  return {
    status: "mock",
    data,
    rawText: JSON.stringify({
      systemPrompt: AD_PITCH_AGENT_SYSTEM_PROMPT,
      ...data,
    }),
  };
}

function buildMockCopyResult(input: AdCopyInput): AgentResult<AdCopyResult> {
  const pitchTitle =
    typeof input.pitch === "string" ? input.pitch : input.pitch.title;
  const pain = input.target.pain?.trim();
  const mainCopy = pitchTitle.replace(/。$/u, "");
  const subCopy = pain
    ? `その「${pain}」を、今日から軽くする。`
    : "毎日の選択を、もっと軽くする。";

  const data: AdCopyResult = { mainCopy, subCopy };
  return {
    status: "mock",
    data,
    rawText: JSON.stringify({
      systemPrompt: AD_COPY_AGENT_SYSTEM_PROMPT,
      ...data,
    }),
  };
}

function parsePitchResult(value: unknown): AdPitchResult | null {
  if (!isRecord(value) || !Array.isArray(value.pitches)) {
    return null;
  }

  const pitches = value.pitches
    .slice(0, 3)
    .map((item: unknown, index: number): AdPitch | null => {
      if (!isRecord(item)) {
        return null;
      }
      const axis = asAppealAxis(item.axis);
      const title = asString(item.title);
      const angle = asString(item.angle);
      const reason = asString(item.reason);
      if (!axis || !title || !angle || !reason) {
        return null;
      }
      return {
        id: asString(item.id) ?? `pitch-${index + 1}`,
        axis,
        title,
        angle,
        reason,
      };
    });

  if (pitches.length !== 3 || pitches.some((pitch) => pitch === null)) {
    return null;
  }

  return { pitches: pitches as AdPitch[] };
}

function parseCopyResult(value: unknown): AdCopyResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const mainCopy = asString(value.mainCopy);
  const subCopy = asString(value.subCopy);
  return mainCopy && subCopy ? { mainCopy, subCopy } : null;
}

export const runPitchAgent: AgentRunner<AdPitchInput, AdPitchResult> =
  async ({ input, signal }): Promise<AgentResult<AdPitchResult>> => {
    assertNotAborted(signal);

    try {
      const result = await codexTextQuery({
        systemPrompt: `${AD_PITCH_AGENT_SYSTEM_PROMPT}\n${AD_PITCH_JSON_INSTRUCTION}`,
        expectJson: true,
        signal,
        prompt: [
          "商品/サービスとターゲットから、画像広告に使える訴求案を3件作ってください。",
          `商品/サービス: ${input.product.trim() || "商品/サービス"}`,
          `ターゲット: ${targetSummary(input.target) || "未指定"}`,
          `優先したい訴求軸: ${input.appealAxis ? AXIS_LABELS[input.appealAxis] : "指定なし"}`,
        ].join("\n"),
      });
      const data = parsePitchResult(result.parsedJson);
      if (!data) {
        return buildMockPitchResult(input);
      }
      return {
        status: "ready",
        data,
        rawText: result.text,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildMockPitchResult(input);
    }
  };

export const runCopyAgent: AgentRunner<AdCopyInput, AdCopyResult> =
  async ({ input, signal }): Promise<AgentResult<AdCopyResult>> => {
    assertNotAborted(signal);

    try {
      const pitch =
        typeof input.pitch === "string"
          ? { title: input.pitch, angle: input.pitch, reason: "" }
          : input.pitch;
      const result = await codexTextQuery({
        systemPrompt: `${AD_COPY_AGENT_SYSTEM_PROMPT}\n${AD_COPY_JSON_INSTRUCTION}`,
        expectJson: true,
        signal,
        prompt: [
          "採用した広告訴求案から、日本語の画像広告コピーを作ってください。",
          `訴求案: ${pitch.title}`,
          `訴求角度: ${pitch.angle}`,
          `理由: ${pitch.reason}`,
          `ターゲット: ${targetSummary(input.target) || "未指定"}`,
        ].join("\n"),
      });
      const data = parseCopyResult(result.parsedJson);
      if (!data) {
        return buildMockCopyResult(input);
      }
      return {
        status: "ready",
        data,
        rawText: result.text,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildMockCopyResult(input);
    }
  };

export async function proposePitches(
  input: AdPitchInput,
  signal?: AbortSignal,
): Promise<AgentResult<AdPitchResult>> {
  return runPitchAgent({ input, signal });
}

export async function composeCopy(
  input: AdCopyInput,
  signal?: AbortSignal,
): Promise<AgentResult<AdCopyResult>> {
  return runCopyAgent({ input, signal });
}
