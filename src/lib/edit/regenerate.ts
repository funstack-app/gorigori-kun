import { images as imagesIpc } from "../ipc";
import { useBatches } from "../store/batches";
import { buildMaskFromLayer } from "./buildMask";
import type { RegenerateLayerArgs } from "./types";

/**
 * 選択レイヤーをマスク化し、元画像 + マスク + 参照レイヤー で codex に投げる。
 *
 * Rust 側 batch_gen は maskPaths が空でない slot を見つけると
 * inpainting 用テンプレに切り替わる。そのため:
 *
 *   refImagePaths[0] = 元画像 (sourceImagePath)
 *   maskPaths[0]    = 選択レイヤーから生成した白黒マスク
 *   refImagePaths[1..] = harmonize=true のとき、他の visible レイヤー
 *   maskPaths[1..]  = "" (マスクなし参照)
 *
 * これで「白い領域だけ AI が編集、他は 1 ピクセルも触らない」挙動になる。
 */
export async function regenerateLayer({
  layer,
  sourceImagePath,
  prompt,
  allLayers,
  harmonize,
  cwd,
  model,
  effort,
  aspect,
}: RegenerateLayerArgs): Promise<string> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw new Error("編集指示を入力してください。");
  }

  const maskPath = await buildMaskFromLayer(layer.imagePath, layer.name);

  const harmonyLayers = harmonize
    ? allLayers.filter(
        (other) =>
          other.id !== layer.id && other.visible && other.imagePath !== layer.imagePath,
      )
    : [];

  const refImagePaths = [sourceImagePath, ...harmonyLayers.map((l) => l.imagePath)];
  const maskPaths = [maskPath, ...harmonyLayers.map(() => "")];

  const batchId = `local-layer-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  useBatches.getState().startBatch({
    batchId,
    prompt: trimmedPrompt,
    references: [{ path: sourceImagePath, name: `${layer.name} を編集` }],
    count: 1,
    // レイヤー再生成も codex 経路。タイムラインでモデル名を出すため渡す。
    provider: "codex",
    modelDisplayName: model ?? "image_gen",
  });

  try {
    const result = await imagesIpc.generateBatch({
      prompt: trimmedPrompt,
      count: 1,
      cwd,
      refImagePaths,
      maskPaths,
      model,
      effort,
      aspect,
    });
    const generatedPath = result.generatedPaths[0];
    if (!generatedPath || result.failedCount > 0) {
      throw new Error("レイヤー再生成に失敗しました。");
    }
    return generatedPath;
  } catch (error) {
    useBatches.getState().removeBatch(batchId);
    throw error;
  }
}
