import { convertFileSrc } from "@tauri-apps/api/core";

import { codexVision } from "../ipc";

/**
 * 画像内の文字ブロック1件。座標は 0〜1000 の正規化スケール
 * (Rust 側 codex_analyze_design のプロンプトがこのスケールを指定している)。
 */
export type TextBlock = {
  text: string;
  /** [左上x, 左上y, 幅, 高さ]。0〜1000 正規化。 */
  bbox: [number, number, number, number];
  color: string | null;
};

/** 抽出結果。文字が1つも無い画像では blocks が空配列になる (これは正常)。 */
export type TextExtraction = {
  blocks: TextBlock[];
  /** 全文字ブロックの面積合計が画像全体に占める割合 (0〜1)。文字面積ルールの判定材料。 */
  textAreaRatio: number;
  /** 画像の実寸 (px)。ロゴ・文字の最小サイズ判定に使う。 */
  imageWidth: number;
  imageHeight: number;
};

const NORMALIZED_SCALE = 1000;

/** 画像の実寸を取得する。Rust 側プロンプトに渡す必要があるため先に測る。 */
async function measureImage(imagePath: string): Promise<{ width: number; height: number }> {
  const url = convertFileSrc(imagePath);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("画像を読み込めませんでした"));
    img.src = url;
  });
  if (!img.naturalWidth || !img.naturalHeight) {
    throw new Error("画像の寸法を取得できませんでした");
  }
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Codex の生出力から text_blocks を取り出す。
 *
 * 外部 LLM 出力は未信頼入力として扱う: 形が違えば黙って空で埋めず throw する
 * (no-silent-gap-filling。「文字が無い画像」と「抽出に失敗した」を取り違えると
 * 検査が静かに空振りする)。
 */
function parseTextBlocks(raw: string): TextBlock[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  // 2026-07-27 修正: 以前は trimmed 全体を JSON.parse していたため、AI が
  // 「以下が解析結果です。{...}」のように前置きを1行付けただけで検査が丸ごと失敗し、
  // 文字だけでなく構図・色・NG表現の判定もまとめて消えていた。
  // Rust 側の同じ出力を食う parse_design_understanding (edit/understanding.rs:77-83) は
  // 最初の { と最後の } で切り出しており、そのテストデータには「前置き {…} 後置き」が
  // 「実測の揺れを再現」というコメント付きで入っている。**Rust は前置きが付くと知って
  // いるのに TS 側だけ JSON だけ来る前提だった**ため、同じ規則へ揃える。
  const s = trimmed.indexOf("{");
  const e = trimmed.lastIndexOf("}");
  if (s < 0 || e <= s) {
    throw new Error("文字抽出の応答に JSON が含まれていませんでした");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(s, e + 1));
  } catch {
    throw new Error("文字抽出の応答が JSON として読めませんでした");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("文字抽出の応答の形式が不正です");
  }
  const blocks = (parsed as Record<string, unknown>).text_blocks;
  if (!Array.isArray(blocks)) {
    throw new Error("文字抽出の応答に text_blocks 配列がありません");
  }

  const result: TextBlock[] = [];
  for (const item of blocks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) continue;

    const bboxRaw = rec.bbox;
    if (!Array.isArray(bboxRaw) || bboxRaw.length !== 4) continue;
    const nums = bboxRaw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
    if (nums.some((v) => v === null)) continue;
    const box = normalizeBbox(nums as [number, number, number, number]);
    if (!box) continue;

    result.push({
      text,
      bbox: box,
      color: typeof rec.color === "string" ? rec.color : null,
    });
  }
  return result;
}

/**
 * bbox を 0〜1000 の正規化スケールへ揃える。範囲外・壊れた値は null で捨てる。
 *
 * 2026-07-27 追加: 以前は値をそのまま信じていたため、AI が指示を無視して実ピクセル座標
 * (例 [100,200,1800,400]) を返すと素通りし、文字面積が「画像の72%」のように誤って
 * 報告され、実際は5%しかない画像に重い違反が付いていた。
 *
 * Rust 側の normalize_bbox (edit/understanding.rs:131-162) が同じ入力に対して
 * (a) ピクセル座標判定 (b) xywh/xyxy の書式揺れ判定 (c) 画像内クランプ を全部やっており、
 * 「4000px 原寸でモデルがピクセル座標を返した」実測もコメントに残っている。
 * **同じプロンプトの同じ出力を食う2経路で解釈がズレないよう**、規則をこちらへ移す。
 */
const NORM_MARGIN = 8;

function normalizeBbox(
  raw: [number, number, number, number],
): [number, number, number, number] | null {
  const [a, b, c, d] = raw;
  // 1つでも 1000 を明確に超えるならピクセル座標とみなす。正規化スケールが不明なので
  // 換算できず、面積比が壊れるため捨てる (推測で埋めない)。
  if (raw.some((v) => v > NORMALIZED_SCALE + NORM_MARGIN)) return null;
  if (raw.some((v) => v < -NORM_MARGIN)) return null;

  // xywh / xyxy の書式揺れを吸収する
  const xywhFits =
    c > 0 && d > 0 && a + c <= NORMALIZED_SCALE + NORM_MARGIN && b + d <= NORMALIZED_SCALE + NORM_MARGIN;
  const xyxyFits = c > a && d > b;
  let x = a;
  let y = b;
  let w: number;
  let h: number;
  if (xywhFits) {
    w = c;
    h = d;
  } else if (xyxyFits) {
    w = c - a;
    h = d - b;
  } else {
    return null;
  }

  // 画像内へクランプ
  const x0 = Math.max(0, Math.min(x, NORMALIZED_SCALE));
  const y0 = Math.max(0, Math.min(y, NORMALIZED_SCALE));
  const x1 = Math.max(0, Math.min(x + w, NORMALIZED_SCALE));
  const y1 = Math.max(0, Math.min(y + h, NORMALIZED_SCALE));
  w = x1 - x0;
  h = y1 - y0;
  // 極端に小さいものはノイズとして捨てる (Rust 側の 2px 相当)
  if (w < 2 || h < 2) return null;
  return [x0, y0, w, h];
}

/**
 * 文字ブロックの面積合計が画像全体に占める割合を出す。
 *
 * 重なりは考慮せず単純合計する (重複を厳密に引くと過小評価になり、
 * 「文字が多すぎる」を見逃す方向に倒れるため。検査は安全側に倒す)。
 * 合計が 1 を超えうるので上限で丸める。
 */
function computeAreaRatio(blocks: readonly TextBlock[]): number {
  const total = NORMALIZED_SCALE * NORMALIZED_SCALE;
  const sum = blocks.reduce((acc, b) => acc + b.bbox[2] * b.bbox[3], 0);
  return Math.min(1, sum / total);
}

/**
 * 画像から文字情報を抽出する。レギュレーション検査の判定材料。
 *
 * 失敗したら throw する (呼び出し側の checkImage が catch して error に落とし、
 * 画面に「検査エラー」として赤字で出る)。空で握りつぶさない。
 */
export async function extractTextInfo(imagePath: string): Promise<TextExtraction> {
  const { width, height } = await measureImage(imagePath);
  const raw = await codexVision.extractTextBlocks(imagePath, width, height);
  const blocks = parseTextBlocks(raw);
  return {
    blocks,
    textAreaRatio: computeAreaRatio(blocks),
    imageWidth: width,
    imageHeight: height,
  };
}

/** 抽出結果を判定 AI に渡すためのプロンプト断片へ整形する。 */
export function formatTextInfoForPrompt(info: TextExtraction): string {
  if (info.blocks.length === 0) {
    return "（この画像から文字は検出されませんでした。文字に関する基準は「該当なし」として扱ってください。）";
  }
  const pct = (info.textAreaRatio * 100).toFixed(1);
  const lines = info.blocks.map((b) => {
    const [x, y, w, h] = b.bbox;
    // 高さは画像高さに対する割合で示す。ロゴ・注記の最小サイズ基準がこの形で書かれているため。
    const heightPct = ((h / NORMALIZED_SCALE) * 100).toFixed(1);
    const color = b.color ? ` 色=${b.color}` : "";
    return `- 「${b.text}」（位置 x=${Math.round(x)} y=${Math.round(y)} / 幅=${Math.round(w)} 高さ=${Math.round(h)} = 画像高さの${heightPct}%${color}）`;
  });
  return [
    `画像サイズ: ${info.imageWidth}×${info.imageHeight}px`,
    `文字が占める面積: 画像全体の約${pct}%`,
    "検出された文字（座標は画像を 1000×1000 に正規化した値）:",
    ...lines,
  ].join("\n");
}
