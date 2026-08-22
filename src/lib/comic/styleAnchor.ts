import {
  MAX_ENV_REFERENCES,
  MAX_PAGE_REFERENCES,
} from "./references";
import type { ComicEnvReference } from "./types";

/**
 * ページ丸ごと生成で使う参照画像の総上限。
 *
 * 既存の「キャラ最大9枚 + 背景・小物最大3枚」を増やさず、その中の先頭1枠を
 * 画風のお手本へ譲る。上限を増やすと、過去に確認済みの生成遅延を再発させるため。
 */
export const MAX_COMIC_PAGE_REFERENCE_IMAGES =
  MAX_PAGE_REFERENCES + MAX_ENV_REFERENCES;

export type StyleAnchoredReferencePlan = {
  /** generateBatch へ渡す順番。お手本があれば必ず先頭。 */
  refImagePaths: string[];
  /** 実際に残ったキャラ参照。 */
  charRefPaths: string[];
  /** 実際に残った背景・小物参照。 */
  envReferences: ComicEnvReference[];
  /** 上限のため外した参照。UIで報告する。 */
  displacedPaths: string[];
  /** プロンプト上の「画風のお手本」の番号。前置き参照があればその分だけずれる。 */
  styleAnchorReferenceIndex?: number;
  /** お手本と同じ画像がキャラ参照にも含まれていたか。 */
  anchorAlsoCharacter: boolean;
};

function cleanPath(value: string | null | undefined): string | null {
  const path = value?.trim();
  return path ? path : null;
}

/**
 * 画風のお手本を最優先にし、既存参照を残り枠へ決定論で詰める。
 *
 * お手本なしでは既存の配列と順番をそのまま返す。お手本ありの時だけ重複を除き、
 * キャラ → 背景・小物の既存順で残す。上限から押し出したパスは必ず返す。
 */
export function planStyleAnchoredReferences(args: {
  styleAnchorImagePath?: string | null;
  charRefPaths: string[];
  envReferences?: ComicEnvReference[];
  /** お手本を含む、この呼び出しで追加できる画像参照の総数。 */
  maxReferences?: number;
  /** マスク編集の元ページなど、呼び出し側が先に置く参照画像の数。 */
  referenceIndexOffset?: number;
}): StyleAnchoredReferencePlan {
  const envReferences = args.envReferences ?? [];
  const anchor = cleanPath(args.styleAnchorImagePath);
  const referenceIndexOffset = Math.max(0, args.referenceIndexOffset ?? 0);

  // アンカーなしは現行の文章のみ方式。並び・重複・枚数へ一切介入しない。
  if (!anchor) {
    return {
      refImagePaths: [
        ...args.charRefPaths,
        ...envReferences.map((reference) => reference.imagePath),
      ],
      charRefPaths: [...args.charRefPaths],
      envReferences: [...envReferences],
      displacedPaths: [],
      styleAnchorReferenceIndex: undefined,
      anchorAlsoCharacter: false,
    };
  }

  // 上限が誤って0以下でも、設計上の最優先枠であるアンカー1枚は必ず残す。
  const maxReferences = Math.max(1, Math.floor(args.maxReferences ?? MAX_COMIC_PAGE_REFERENCE_IMAGES));
  const remainingBudget = maxReferences - 1;
  const seen = new Set<string>([anchor]);
  const charRefPaths: string[] = [];
  const keptEnvReferences: ComicEnvReference[] = [];
  const displacedPaths: string[] = [];
  let anchorAlsoCharacter = false;

  const tryKeep = (
    rawPath: string,
    kind: "character" | "environment",
    environment?: ComicEnvReference,
  ) => {
    const path = cleanPath(rawPath);
    if (!path) return;
    if (seen.has(path)) {
      if (kind === "character" && path === anchor) anchorAlsoCharacter = true;
      return;
    }
    seen.add(path);
    if (charRefPaths.length + keptEnvReferences.length >= remainingBudget) {
      displacedPaths.push(path);
      return;
    }
    if (kind === "character") charRefPaths.push(path);
    else if (environment) keptEnvReferences.push({ ...environment, imagePath: path });
  };

  args.charRefPaths.forEach((path) => tryKeep(path, "character"));
  envReferences.forEach((reference) =>
    tryKeep(reference.imagePath, "environment", reference),
  );

  return {
    refImagePaths: [
      anchor,
      ...charRefPaths,
      ...keptEnvReferences.map((reference) => reference.imagePath),
    ],
    charRefPaths,
    envReferences: keptEnvReferences,
    displacedPaths,
    styleAnchorReferenceIndex: referenceIndexOffset + 1,
    anchorAlsoCharacter,
  };
}
