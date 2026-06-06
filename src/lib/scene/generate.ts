import { higgsfield, images } from "../ipc";
import { buildPrompt } from "./buildPrompt";
import type { SceneState } from "./types";

export type SceneGenerationCount = number;

export type SceneGenerationResult = {
  batchId: string;
  generatedPaths: string[];
  failedCount: number;
  /**
   * 失敗した各ワーカーの理由 (NSFW判定・クレジット不足・タイムアウト等)。
   * higgsfield 経路は IPC 結果に含まれる。codex/image_gen 経路は含まれない
   * ため空配列になる (その場合の分類は classifyFailures が hasFailure で吸収)。
   */
  errors: string[];
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
    const r = await higgsfield.generateCompare({
      models: higgsfieldModels,
      prompt,
      cwd: options.cwd,
      refImagePaths,
      aspect,
    });
    return { ...r, errors: r.errors ?? [] };
  }

  if (options.higgsfield) {
    const r = await higgsfield.generateBatch({
      jobSetType: options.higgsfield.jobSetType,
      displayName: options.higgsfield.displayName,
      prompt,
      count: options.count,
      cwd: options.cwd,
      refImagePaths,
      aspect,
    });
    return { ...r, errors: r.errors ?? [] };
  }

  // codex/image_gen 経路: Rust(batch_gen.rs)は errors を serialize しないため
  // 実行時は undefined になる。?? [] で必ず配列に正規化する。
  const r = await images.generateBatch({
    prompt,
    count: options.count,
    cwd: options.cwd,
    refImagePaths,
    maskPaths: options.maskPaths,
    model: options.model,
    effort: options.effort,
    aspect,
  });
  return { ...r, errors: r.errors ?? [] };
}
