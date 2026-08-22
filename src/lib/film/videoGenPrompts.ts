import type { AssetType, FilmBlock } from "./types";

export const VIDEO_GENERATION_ABSOLUTE_RULES = [
  "1生成はこの1ブロックだけにする。別ブロックの出来事を足さない。",
  "色調名、色指定、カラーコードは絶対に入れない。色は仕上げで一括調整する。",
  "文字やロゴの生成を指示しない。字幕、透かし、UI、判読可能な擬似文字を画面へ足さない。",
  "決定版アセットの人物・場所・小物の同一性を保ち、別の見た目へ置き換えない。",
  "脚本にないカット、人物、物、セリフ、音を足さない。",
] as const;

export type VideoGenerationAssetInput = {
  id: string;
  name: string;
  type: AssetType;
  prompt: string;
  referencePath?: string | null;
};

export type VideoGenerationPromptInput = {
  title: string;
  theme: string;
  lookDescription?: string | null;
  lookMasterPath?: string | null;
  stylePrefix: string;
  sceneId: string;
  sceneLocation?: string | null;
  block: FilmBlock;
  assets: readonly VideoGenerationAssetInput[];
  referenceNotation?: string | null;
};

function valueOrUnset(value: string | null | undefined): string {
  return value?.trim() || "未設定";
}

function formatAssets(
  assets: readonly VideoGenerationAssetInput[],
): string {
  if (assets.length === 0) return "このブロックに登録された決定版アセットはなし。";
  return assets
    .map((asset, index) => {
      const reference = asset.referencePath?.trim()
        ? `参照画像${index + 1}: ${asset.referencePath}`
        : "参照画像: 未確定";
      return `## ${asset.id} ${asset.name}（${asset.type}）\n${reference}\n決定版の生成指示文:\n${valueOrUnset(asset.prompt)}`;
    })
    .join("\n\n");
}

/**
 * 承認済みの設計、決定版アセット、1ブロック分の脚本を順番固定で合成する。
 * AI呼び出しを含まない純関数なので、同じ入力からは必ず同じ文章を返す。
 */
export function buildVideoGenerationPrompt(
  input: VideoGenerationPromptInput,
): string {
  const { block } = input;
  return `# ① 設計の決定事項
作品: ${valueOrUnset(input.title)}
一番伝えたいこと: ${valueOrUnset(input.theme)}
場面: ${valueOrUnset(input.sceneId)} / ${valueOrUnset(input.sceneLocation)}
決定ルックの設計: ${valueOrUnset(input.lookDescription)}
決定ルック画像: ${valueOrUnset(input.lookMasterPath)}

# ② 登場アセットの決定版
${formatAssets(input.assets)}
参照の書き方: ${valueOrUnset(input.referenceNotation)}

# ③ この1ブロックの台本
${input.sceneId}/${block.id} / ${block.durationSeconds}秒
画: ${valueOrUnset(block.visual)}
芝居: ${valueOrUnset(block.performance)}
セリフ: ${valueOrUnset(block.dialogue)}
音: ${valueOrUnset(block.sound)}

# 絶対規律
${VIDEO_GENERATION_ABSOLUTE_RULES.map((rule) => `- ${rule}`).join("\n")}

# 全動画に共通する見た目の固定文（末尾固定）
${valueOrUnset(input.stylePrefix)}`;
}

/** NG理由を次の生成条件へ明記し、同じ文面のまま再生成しない。 */
export function appendVideoGenerationRevision(prompt: string, reason: string): string {
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new Error("やり直す理由を入力してください");
  return `${prompt.trim()}\n\n# 前回の不採用理由と今回の修正\n- 前回の問題: ${trimmedReason}\n- この問題を直し、それ以外の確定事項は変えない。`;
}

export function summarizeFilmBlock(block: FilmBlock, maxLength = 64): string {
  const source = block.visual.trim() || block.performance.trim() || block.dialogue.trim() || "要約なし";
  return source.length <= maxLength ? source : `${source.slice(0, Math.max(1, maxLength - 1))}…`;
}
