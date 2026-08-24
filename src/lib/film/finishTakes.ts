import type { FilmBlock, FilmTake } from "./types";

/** 採用テイクだけを、脚本ブロックの上映順で返す。 */
export function collectAdoptedTakePaths(
  blocks: readonly FilmBlock[],
  takes: readonly FilmTake[],
): string[] {
  return blocks.flatMap((block) => {
    const take = takes.find((candidate) => candidate.blockId === block.id && candidate.adopted);
    return take ? [take.path] : [];
  });
}
