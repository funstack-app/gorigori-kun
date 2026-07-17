import { higgsfieldMcp, images, magnific } from "../ipc";
import { buildPrompt } from "./buildPrompt";
import type { SceneState } from "./types";

// Magnific 比較生成の同時接続上限。4モデル全部を同時に codex exec→MCP 接続すると
// OAuth セッションが競合して HTTP 401 が出る(2026-06-08 実機で確認)。2 に絞ると
// 競合がほぼ消える。速度より「全部成功して反映される」ことを優先する。
const MAGNIFIC_COMPARE_CONCURRENCY = 2;

// Higgsfield MCP 比較生成の同時接続上限。Magnific と同じ理由 (codex exec→MCP の
// OAuth セッション競合) で 2 に絞る。MCP には generateCompare が無いので、各モデルを
// 1枚ずつ generateBatch して並べる (CLI 版 generateCompare のフロント側再現)。
const HIGGSFIELD_COMPARE_CONCURRENCY = 2;

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
  turnId?: string;
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

  // Higgsfield 比較生成 (2026-06-10 段階8: MCP移行)。MCP には generateCompare が無いので、
  // Magnific 比較と同じく各モデルを 1枚ずつ generateBatch して index 対応を保ったまま並べる。
  // 失敗枠は空文字 path を入れてカードのモデル名と画像のズレを防ぐ。
  if (higgsfieldModels.length >= 2) {
    const models = higgsfieldModels;
    const perModel: { path: string; failed: boolean; error?: string }[] =
      models.map(() => ({
        path: "",
        failed: true,
        error: "生成が実行されませんでした",
      }));

    let cursor = 0;
    const runWorker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= models.length) return;
        try {
          const r = await higgsfieldMcp.generateBatch({
            prompt,
            model: models[i].jobSetType,
            count: 1,
            aspect,
            refImagePaths,
          });
          const path = r.generatedPaths[0];
          if (path) {
            perModel[i] = { path, failed: false };
          } else {
            perModel[i] = {
              path: "",
              failed: true,
              error: r.errors?.[0] ?? "Higgsfield 生成に失敗しました",
            };
          }
        } catch (e) {
          perModel[i] = {
            path: "",
            failed: true,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
    };

    const concurrency = Math.min(HIGGSFIELD_COMPARE_CONCURRENCY, models.length);
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    return {
      batchId: `higgsfield-compare-${Date.now()}`,
      generatedPaths: perModel.map((m) => m.path),
      failedCount: perModel.filter((m) => m.failed).length,
      errors: perModel.filter((m) => m.error).map((m) => m.error as string),
    };
  }

  if (options.higgsfield) {
    const r = await higgsfieldMcp.generateBatch({
      prompt,
      model: options.higgsfield.jobSetType,
      count: options.count,
      aspect,
      refImagePaths,
    });
    return {
      batchId: `higgsfield-${Date.now()}`,
      generatedPaths: r.generatedPaths,
      failedCount: r.failedCount,
      errors: r.errors ?? [],
    };
  }

  // Magnific 比較生成 (2026-06-08)。2モデル以上選択時、各モデルで1枚ずつ生成して並べる。
  // Higgsfield の generateCompare と同じ思想。コアには一切影響しない。
  //
  // 2026-06-08 修正 (実機バグ): 4モデル同時に codex exec→Magnific MCP へ並列接続すると
  // OAuth セッションが競合し HTTP 401 を返すモデルが出る。旧実装は Promise.all だったため
  // 1モデルでも reject すると全体が reject → 上位 catch が removeBatch でカードごと削除し、
  // 「タイムラインから消えてライブラリにだけ残る」症状になっていた。
  // 対策2点:
  //   (1) Promise.allSettled で1モデルの失敗が成功分を巻き込まないようにする。
  //   (2) 同時接続を MAGNIFIC_COMPARE_CONCURRENCY 件に絞り 401 競合自体を減らす。
  // さらに generatedPaths はモデル index 対応を保つ(失敗は空文字)。flatMap だと
  // 失敗モデルがあるとカードのモデル名と画像がズレるため。
  if (options.magnificModels && options.magnificModels.length >= 2) {
    const models = options.magnificModels;
    // モデル index と同じ並びで結果を埋める。失敗枠は path 空・error 保持。
    // 初期値は failed:true(安全側デフォルト)。万一あるスロットが runWorker に
    // 訪問されず上書きされなくても、失敗として数え「嘘の成功枚数」を出さない。
    // 成功時は下の try で failed:false に上書きされるので正常系の挙動は変わらない。
    const perModel: { path: string; failed: boolean; error?: string }[] =
      models.map(() => ({
        path: "",
        failed: true,
        error: "生成が実行されませんでした",
      }));

    let cursor = 0;
    const runWorker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= models.length) return;
        try {
          const r = await magnific.generateBatch({
            prompt,
            model: models[i],
            count: 1,
            aspect,
            refImagePaths,
          });
          const path = r.generatedPaths[0];
          if (path) {
            perModel[i] = { path, failed: false };
          } else {
            perModel[i] = {
              path: "",
              failed: true,
              error: r.errors?.[0] ?? "Magnific 生成に失敗しました",
            };
          }
        } catch (e) {
          // 401 競合・タイムアウト等。この1モデルだけ失敗扱いにし、他は止めない。
          perModel[i] = {
            path: "",
            failed: true,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
    };

    const concurrency = Math.min(MAGNIFIC_COMPARE_CONCURRENCY, models.length);
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    return {
      batchId: `magnific-compare-${Date.now()}`,
      // index 対応を保つ。空文字 worker は batches.applyEvent 側で failed になる。
      generatedPaths: perModel.map((m) => m.path),
      failedCount: perModel.filter((m) => m.failed).length,
      errors: perModel.filter((m) => m.error).map((m) => m.error as string),
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
    turnId: options.turnId,
  });
  return { ...r, errors: r.errors ?? [] };
}
