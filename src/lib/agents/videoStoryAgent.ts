import { codexTextQuery } from "./codexQuery";
import { VIDEO_STORY_AGENT_SYSTEM_PROMPT } from "./systemPrompts";
import type {
  AgentResult,
  AgentRunner,
  StoryboardCut,
  StoryboardResult,
  VideoDuration,
  VideoStoryInput,
} from "./types";

const STORYBOARD_JSON_INSTRUCTION = [
  "JSON 形式のみで返してください。",
  '出力例: {"cuts":[{"cutNumber":1,"role":"起","composition":"構図","cameraWork":"カメラワーク","durationSeconds":5}],"totalDurationSeconds":15}',
  "role は 起 / 承 / 転 / 結 のいずれか。cuts は 3-4 件。",
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

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asRole(value: unknown): StoryboardCut["role"] | undefined {
  return value === "起" || value === "承" || value === "転" || value === "結"
    ? value
    : undefined;
}

function durationToSeconds(duration: VideoDuration): number {
  switch (duration) {
    case "15s":
      return 15;
    case "30s":
      return 30;
    case "60s":
      return 60;
    case "custom":
      return 30;
  }
}

function distribute(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remaining = total - base * count;
  return Array.from({ length: count }, (_: unknown, index: number): number =>
    base + (index < remaining ? 1 : 0),
  );
}

function buildMockStoryboardResult(
  input: VideoStoryInput,
): AgentResult<StoryboardResult> {
  const totalDurationSeconds = durationToSeconds(input.duration);
  const cutCount = totalDurationSeconds <= 15 ? 3 : 4;
  const durations = distribute(totalDurationSeconds, cutCount);
  const core = input.core.trim() || "主人公の小さな変化";

  const templates: Array<Omit<StoryboardCut, "durationSeconds">> = [
    {
      cutNumber: 1,
      role: "起",
      composition: `${core} の始まりを、状況が一目でわかる構図で見せる`,
      cameraWork: "固定カメラ、ミディアムショット",
    },
    {
      cutNumber: 2,
      role: "承",
      composition: "主人公が行動を起こす瞬間を見せる",
      cameraWork: "ゆっくりしたパン、ミディアムから寄り",
    },
    {
      cutNumber: 3,
      role: cutCount === 3 ? "結" : "転",
      composition:
        cutCount === 3
          ? "気持ちや状況が変わった結果を印象的に見せる"
          : "光、表情、場所の変化で転機を見せる",
      cameraWork: "引きから寄り、自然な移動感",
    },
    {
      cutNumber: 4,
      role: "結",
      composition: "最後の感情を顔や余白で残す締めの構図",
      cameraWork: "ゆるいズームイン、クローズアップ",
    },
  ];

  const cuts = templates
    .slice(0, cutCount)
    .map((cut, index: number): StoryboardCut => ({
      ...cut,
      durationSeconds: durations[index] ?? 0,
    }));

  const data: StoryboardResult = { cuts, totalDurationSeconds };
  return {
    status: "mock",
    data,
    rawText: JSON.stringify({
      systemPrompt: VIDEO_STORY_AGENT_SYSTEM_PROMPT,
      ...data,
    }),
  };
}

function parseStoryboardResult(value: unknown): StoryboardResult | null {
  if (!isRecord(value) || !Array.isArray(value.cuts)) {
    return null;
  }

  const cuts = value.cuts.map(
    (item: unknown, index: number): StoryboardCut | null => {
      if (!isRecord(item)) {
        return null;
      }
      const role = asRole(item.role);
      const composition = asString(item.composition);
      const cameraWork = asString(item.cameraWork);
      const durationSeconds = asPositiveNumber(item.durationSeconds);
      if (!role || !composition || !cameraWork || !durationSeconds) {
        return null;
      }
      return {
        cutNumber: Math.round(asPositiveNumber(item.cutNumber) ?? index + 1),
        role,
        composition,
        cameraWork,
        durationSeconds: Math.round(durationSeconds),
      };
    },
  );

  if (
    cuts.length < 3 ||
    cuts.length > 4 ||
    cuts.some((cut) => cut === null)
  ) {
    return null;
  }

  const totalDurationSeconds =
    asPositiveNumber(value.totalDurationSeconds) ??
    cuts.reduce(
      (sum: number, cut: StoryboardCut | null): number =>
        sum + (cut?.durationSeconds ?? 0),
      0,
    );

  return {
    cuts: cuts as StoryboardCut[],
    totalDurationSeconds: Math.round(totalDurationSeconds),
  };
}

export const runAgent: AgentRunner<VideoStoryInput, StoryboardResult> =
  async ({ input, signal }): Promise<AgentResult<StoryboardResult>> => {
    assertNotAborted(signal);

    try {
      const result = await codexTextQuery({
        systemPrompt: `${VIDEO_STORY_AGENT_SYSTEM_PROMPT}\n${STORYBOARD_JSON_INSTRUCTION}`,
        expectJson: true,
        signal,
        prompt: [
          "短尺動画の起承転結ストーリーボードを作ってください。",
          `ストーリーの核: ${input.core.trim() || "主人公の小さな変化"}`,
          `尺: ${input.duration}`,
          `合計秒数: ${durationToSeconds(input.duration)}`,
        ].join("\n"),
      });
      const data = parseStoryboardResult(result.parsedJson);
      if (!data) {
        return buildMockStoryboardResult(input);
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
      return buildMockStoryboardResult(input);
    }
  };

export async function buildStoryboard(
  input: VideoStoryInput,
  signal?: AbortSignal,
): Promise<AgentResult<StoryboardResult>> {
  return runAgent({ input, signal });
}
