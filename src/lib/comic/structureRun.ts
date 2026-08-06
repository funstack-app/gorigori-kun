/**
 * 「きっちりコマ割り」の生成前計画。
 *
 * I/Oは行わず、スロット解決・参照配分・コマごとのgenerateBatch引数を純関数で作る。
 * 実際の生成、中止、進捗、ページ合成、state更新はComicWorkspace側が担う。
 */

import { synthesizeSlotsFromRows } from "./layoutSynthesis";
import type { ComicPanelSlot } from "./layoutTemplates";
import {
  STRUCTURE_PAGE_H,
  STRUCTURE_PAGE_W,
  nearestAspectLabel,
} from "./pageAssembly";
import { effectivePageSlots } from "./panelLayoutOps";
import { buildStructurePanelPrompt } from "./prompts";
import {
  MAX_ENV_REFERENCES,
  MAX_PAGE_REFERENCES,
  resolvePanelReferences,
} from "./references";
import type {
  ComicCharacter,
  ComicColorMode,
  ComicEnvReference,
  ComicPanel,
  ComicReadingDirection,
  ComicStoryPage,
} from "./types";

/** 撤去済み旧B部品の内部だけで使う生成方式。 */
export type StructureRunGenMode = "structure";

/** images.generateBatchへそのまま渡せる、1コマ分の引数。 */
export type StructureGenerateBatchRequest = {
  prompt: string;
  count: 1;
  refImagePaths: string[];
  aspect: string;
  sourceTag: string;
};

/** コマ番号と生成引数の対応。panelIndexは1始まり。 */
export type StructurePanelRequest = {
  panelIndex: number;
  request: StructureGenerateBatchRequest;
};

/** U4が生成と成功記録に使う、1ページ分の決定済み計画。 */
export type StructureRunPlan = {
  genMode: StructureRunGenMode;
  slots: ComicPanelSlot[];
  panelRequests: StructurePanelRequest[];
};

/**
 * rows不在時の決定論フォールバック。
 * 上から2コマずつ並べ、奇数の端数だけを最終行の1コマにする。
 */
export function fallbackRowsForPanelCount(panelCount: number): number[][] {
  if (!Number.isInteger(panelCount) || panelCount <= 0) return [];
  const rows: number[][] = [];
  for (let panelNo = 1; panelNo <= panelCount; panelNo += 2) {
    rows.push(
      panelNo + 1 <= panelCount ? [panelNo, panelNo + 1] : [panelNo],
    );
  }
  return rows;
}

/**
 * B方式のスロットを常に返す薄いラッパ。
 * 優先順位はeffectivePageSlots → 生rowsの合成 → 決定論fallback rowsの合成。
 */
export function resolveStructureSlots(args: {
  page: ComicStoryPage;
  storyTemplateId: string | null;
  direction: ComicReadingDirection;
}): ComicPanelSlot[] {
  const effective = effectivePageSlots(args);
  if (effective) return effective;

  const synthesized = args.page.rows
    ? synthesizeSlotsFromRows(
        args.page.rows,
        args.page.panelCount,
        args.direction,
      )
    : null;
  if (synthesized) return synthesized;

  const fallback = synthesizeSlotsFromRows(
    fallbackRowsForPanelCount(args.page.panelCount),
    args.page.panelCount,
    args.direction,
  );
  if (!fallback) {
    throw new Error("コマ数からきっちりコマ割りの配置を作れませんでした。");
  }
  return fallback;
}

function attachedEnvironmentReferences(
  envReferences: ComicEnvReference[],
): ComicEnvReference[] {
  return envReferences
    .filter((reference) => reference.imagePath.trim().length > 0)
    .slice(0, MAX_ENV_REFERENCES);
}

function assertPanelIndexContract(page: ComicStoryPage): ComicPanel[] {
  if (page.panels.length !== page.panelCount) {
    throw new Error("ページのコマ数とコマデータの数が一致しません。");
  }
  const ordered = [...page.panels].sort((a, b) => a.index - b.index);
  ordered.forEach((panel, index) => {
    if (panel.index !== index + 1) {
      throw new Error("コマ番号は1からの連番で指定してください。");
    }
  });
  return ordered;
}

/** 1コマ分の参照配分・prompt・aspectヒントを決定する。 */
export function buildStructurePanelRequest(args: {
  panel: ComicPanel;
  slot: ComicPanelSlot;
  characters: ComicCharacter[];
  colorMode: ComicColorMode;
  styleText?: string;
  envReferences?: ComicEnvReference[];
  direction: ComicReadingDirection;
  pageContext: { panelNo: number; panelTotal: number; synopsis: string };
  sourceTag: string;
}): StructurePanelRequest {
  const environmentReferences = attachedEnvironmentReferences(
    args.envReferences ?? [],
  );
  const panelReferences = resolvePanelReferences(args.panel, args.characters);
  // 合計9枚の中で環境参照を先に確保し、残りだけをキャラ参照へ配る。
  const charBudget = Math.max(
    0,
    MAX_PAGE_REFERENCES - environmentReferences.length,
  );
  const charRefPaths = panelReferences.refPaths.slice(0, charBudget);
  const refImagePaths = [
    ...charRefPaths,
    ...environmentReferences.map((reference) => reference.imagePath),
  ];
  const slotRatio =
    (args.slot.w * STRUCTURE_PAGE_W) /
    (args.slot.h * STRUCTURE_PAGE_H);

  return {
    panelIndex: args.panel.index,
    request: {
      prompt: buildStructurePanelPrompt({
        panel: args.panel,
        characters: args.characters,
        colorMode: args.colorMode,
        styleText: args.styleText,
        hasCharRefs: charRefPaths.length > 0,
        envReferences: environmentReferences.map(({ name, kind }) => ({
          name,
          kind,
        })),
        charRefCount: charRefPaths.length,
        direction: args.direction,
        pageContext: args.pageContext,
      }),
      count: 1,
      refImagePaths,
      aspect: nearestAspectLabel(slotRatio),
      sourceTag: args.sourceTag,
    },
  };
}

/**
 * 1ページのスロットとコマ別生成リクエストを、index-1対応でまとめて決定する。
 * 戻り値のgenModeをU4が成功結果へそのまま記録できる。
 */
export function buildStructureRunPlan(args: {
  page: ComicStoryPage;
  storyTemplateId: string | null;
  direction: ComicReadingDirection;
  characters: ComicCharacter[];
  colorMode: ComicColorMode;
  styleText?: string;
  envReferences?: ComicEnvReference[];
  sourceTag: string;
}): StructureRunPlan {
  const orderedPanels = assertPanelIndexContract(args.page);
  const slots = resolveStructureSlots({
    page: args.page,
    storyTemplateId: args.storyTemplateId,
    direction: args.direction,
  });
  if (slots.length !== args.page.panelCount) {
    throw new Error("コマ割りの情報とコマ数が一致しません。");
  }

  return {
    genMode: "structure",
    slots,
    panelRequests: orderedPanels.map((panel) =>
      buildStructurePanelRequest({
        panel,
        slot: slots[panel.index - 1],
        characters: args.characters,
        colorMode: args.colorMode,
        styleText: args.styleText,
        envReferences: args.envReferences,
        direction: args.direction,
        pageContext: {
          panelNo: panel.index,
          panelTotal: args.page.panelCount,
          synopsis: args.page.synopsis,
        },
        sourceTag: args.sourceTag,
      }),
    ),
  };
}
