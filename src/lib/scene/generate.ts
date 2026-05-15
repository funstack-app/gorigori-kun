import { higgsfield, images } from "../ipc";
import { buildPrompt } from "./buildPrompt";
import type { SceneState } from "./types";

export type SceneGenerationCount = number;

export type SceneGenerationResult = {
  batchId: string;
  generatedPaths: string[];
  failedCount: number;
};

export type SceneGenerationOptions = {
  count: SceneGenerationCount;
  cwd?: string;
  model?: string;
  effort?: string;
  promptOverride?: string;
  refImagePaths?: string[];
  maskPaths?: string[];
  higgsfield?: {
    jobSetType: string;
    displayName: string;
  };
  higgsfieldModels?: {
    jobSetType: string;
    displayName: string;
  }[];
};

type SceneReferenceImage = {
  path?: unknown;
  filePath?: unknown;
  src?: unknown;
  enabled?: unknown;
};

type SceneWithReferenceImages = SceneState & {
  reference: SceneState["reference"] & {
    images?: SceneReferenceImage[];
  };
};

function pathFromReferenceImage(image: SceneReferenceImage): string | null {
  const path = image.path ?? image.filePath ?? image.src;
  return typeof path === "string" && path.trim().length > 0
    ? path.trim()
    : null;
}

export function sceneReferenceImagePaths(scene: SceneState): string[] {
  const images = (scene as SceneWithReferenceImages).reference.images ?? [];
  return images
    .filter((image) => image.enabled !== false)
    .map(pathFromReferenceImage)
    .filter((path): path is string => path !== null);
}

export async function generateFromScene(
  scene: SceneState,
  options: SceneGenerationOptions,
): Promise<SceneGenerationResult> {
  const refImagePaths = options.refImagePaths ?? sceneReferenceImagePaths(scene);
  const prompt = options.promptOverride ?? buildPrompt(scene);
  const aspect = scene.subjectFraming.aspectRatio;
  const higgsfieldModels = options.higgsfieldModels ?? [];

  if (higgsfieldModels.length >= 2) {
    return higgsfield.generateCompare({
      models: higgsfieldModels,
      prompt,
      cwd: options.cwd,
      refImagePaths,
      aspect,
    });
  }

  if (options.higgsfield) {
    return higgsfield.generateBatch({
      jobSetType: options.higgsfield.jobSetType,
      displayName: options.higgsfield.displayName,
      prompt,
      count: options.count,
      cwd: options.cwd,
      refImagePaths,
      aspect,
    });
  }

  return images.generateBatch({
    prompt,
    count: options.count,
    cwd: options.cwd,
    refImagePaths,
    maskPaths: options.maskPaths,
    model: options.model,
    effort: options.effort,
    aspect,
  });
}
