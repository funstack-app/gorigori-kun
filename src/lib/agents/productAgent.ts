import { codexTextQuery } from "./codexQuery";
import { PRODUCT_AGENT_SYSTEM_PROMPT } from "./systemPrompts";
import type {
  AgentResult,
  AgentRunner,
  ProductPromptResult,
  ProductSceneInput,
} from "./types";

const PRODUCT_TEXT_INSTRUCTION = [
  "For this run, return plain text only.",
  "Return one concise English image-generation prompt. Do not wrap it in JSON or Markdown.",
].join("\n");

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Agent request was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function compact(parts: Array<string | undefined>): string {
  return parts
    .map((part: string | undefined): string => part?.trim() ?? "")
    .filter((part: string): boolean => part.length > 0)
    .join(", ");
}

function normalizeCreativity(strictness: number | undefined): string {
  if (strictness === undefined) return "";
  if (strictness <= 33) return "precise controlled execution";
  if (strictness >= 67) return "creative interpretation with expressive detail";
  return "balanced realism and creative direction";
}

function buildFallbackResult(
  input: ProductSceneInput,
): AgentResult<ProductPromptResult> {
  const subjectAndComposition = compact([
    input.subject,
    input.composition,
    input.aspectRatio ? `${input.aspectRatio} aspect ratio` : undefined,
    input.environment,
  ]);
  const lightAndMood = compact([input.lighting, input.mood]);
  const camera = compact([
    input.camera,
    input.focalLength,
    input.lens,
    input.film,
  ]);
  const style = compact([
    normalizeCreativity(input.strictness),
    input.photographerStyle
      ? `inspired by ${input.photographerStyle}`
      : undefined,
    input.cinematicLook,
    input.filter,
  ]);
  const references = compact(input.references ?? []);

  const prompt = compact([
    subjectAndComposition,
    lightAndMood,
    camera,
    style,
    references ? `use visual references: ${references}` : undefined,
    "high detail, coherent composition, production-ready image",
  ]);

  const data: ProductPromptResult = {
    prompt,
    sections: {
      subjectAndComposition,
      lightAndMood,
      camera,
      style,
      references,
    },
  };

  return {
    status: "mock",
    data,
    rawText: JSON.stringify({
      systemPrompt: PRODUCT_AGENT_SYSTEM_PROMPT,
      ...data,
    }),
  };
}

function buildPromptInput(input: ProductSceneInput): string {
  return [
    "Optimize the following Japanese structured scene input into one English image-generation prompt.",
    `Subject: ${input.subject?.trim() || "unspecified"}`,
    `Composition: ${input.composition?.trim() || "unspecified"}`,
    `Aspect ratio: ${input.aspectRatio?.trim() || "unspecified"}`,
    `Environment: ${input.environment?.trim() || "unspecified"}`,
    `Lighting: ${input.lighting?.trim() || "unspecified"}`,
    `Mood: ${input.mood?.trim() || "unspecified"}`,
    `Camera: ${input.camera?.trim() || "unspecified"}`,
    `Focal length: ${input.focalLength?.trim() || "unspecified"}`,
    `Lens: ${input.lens?.trim() || "unspecified"}`,
    `Film: ${input.film?.trim() || "unspecified"}`,
    `Strictness: ${normalizeCreativity(input.strictness) || "unspecified"}`,
    `Photographer style: ${input.photographerStyle?.trim() || "unspecified"}`,
    `Cinematic look: ${input.cinematicLook?.trim() || "unspecified"}`,
    `Filter: ${input.filter?.trim() || "unspecified"}`,
    `References: ${compact(input.references ?? []) || "unspecified"}`,
  ].join("\n");
}

export const runAgent: AgentRunner<ProductSceneInput, ProductPromptResult> =
  async ({ input, signal }): Promise<AgentResult<ProductPromptResult>> => {
    assertNotAborted(signal);

    try {
      const result = await codexTextQuery({
        systemPrompt: `${PRODUCT_AGENT_SYSTEM_PROMPT}\n${PRODUCT_TEXT_INSTRUCTION}`,
        prompt: buildPromptInput(input),
        expectJson: false,
        signal,
      });
      const optimizedPrompt = result.text.trim();
      if (!optimizedPrompt) {
        return buildFallbackResult(input);
      }
      const fallback = buildFallbackResult(input);
      return {
        status: "ready",
        data: {
          prompt: optimizedPrompt,
          sections: fallback.data.sections,
        },
        rawText: result.text,
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      return buildFallbackResult(input);
    }
  };

export async function runOptimize(
  scene: ProductSceneInput,
  signal?: AbortSignal,
): Promise<AgentResult<ProductPromptResult>> {
  return runAgent({ input: scene, signal });
}
