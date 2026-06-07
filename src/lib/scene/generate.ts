import { higgsfield, images } from "../ipc";
import { buildPrompt } from "./buildPrompt";
import type { SceneState } from "./types";

export type SceneGenerationCount = number;

export type SceneGenerationResult = {
  batchId: string;
  generatedPaths: string[];
  failedCount: number;
  /**
   * 失敗した各ワーカーの理由 (NSFW判定・クレジット不足・タイムアウト・
   * image_gen 未呼び出し等)。higgsfield 経路・codex/image_gen 経路の
   * どちらも理由を載せて返す (codex経路は 2026-06-07 修正で対応)。
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

  // codex/image_gen 経路: Rust(batch_gen.rs)が失敗 worker の理由を errors に
  // 載せて返す (2026-06-07 修正)。?? [] は念のための正規化 (旧バイナリ互換)。
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
