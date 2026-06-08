import { higgsfield, images, magnific } from "../ipc";
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
  // Magnific オプショナル拡張 (2026-06-08)。Magnificモデルが選ばれたときだけセットされる。
  // magnific=単一生成、magnificModels=比較生成(各モデル1枚)。
  magnific?: {
    model: string;
  };
  magnificModels?: string[];
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

  // Magnific 比較生成 (2026-06-08)。2モデル以上選択時、各モデルで1枚ずつ生成して並べる。
  // Higgsfield の generateCompare と同じ思想。コアには一切影響しない。
  if (options.magnificModels && options.magnificModels.length >= 2) {
    const results = await Promise.all(
      options.magnificModels.map((model) =>
        magnific.generateBatch({ prompt, model, count: 1, aspect, refImagePaths }),
      ),
    );
    return {
      batchId: `magnific-compare-${Date.now()}`,
      generatedPaths: results.flatMap((r) => r.generatedPaths),
      failedCount: results.reduce((sum, r) => sum + r.failedCount, 0),
      errors: results.flatMap((r) => r.errors ?? []),
    };
  }

  // Magnific 単一生成 (2026-06-08)。Magnificモデルが1つ選ばれたときだけこの経路。
  // コア(下の codex/image_gen) には一切影響しない。MCP経由生成→URL DL→保存。
  if (options.magnific) {
    const r = await magnific.generateBatch({
      prompt,
      model: options.magnific.model,
      count: options.count,
      aspect,
      refImagePaths,
    });
    return {
      batchId: `magnific-${Date.now()}`,
      generatedPaths: r.generatedPaths,
      failedCount: r.failedCount,
      errors: r.errors ?? [],
    };
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
