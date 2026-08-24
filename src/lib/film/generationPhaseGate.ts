import { getAssetFactoryGateState } from "./assetFactory";
import type { FilmProject } from "./types";

/** ⑤/⑥へ進めるかを、素材あり・素材なしの経路ごとに判定する。 */
export function canEnterGenerationPhase(project: FilmProject): boolean {
  if (project.assets.length === 0) return Boolean(project.approvals.look);
  return getAssetFactoryGateState(project.assets).canProceed;
}
