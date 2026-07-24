/**
 * 漫画制作スキルのプロンプト組み立て。
 *
 * - ネーム生成プロンプト: 話+形式+登場キャラ → JSON でコマ割りを返させる
 * - コマ画像生成プロンプト: コマの構図・演技・登場キャラ属性を1本のプロンプトへ合成
 *
 * AI が知っている一般知識（コマ割りの一般論など）は書かない。
 * 「必ず JSON で返す」「形式ごとのコマ数を守る」という制約だけを明示する。
 */

import type { ComicCharacter, ComicFormat, ComicPanel } from "./types";

/**
 * ネーム（コマ割り+セリフ）を JSON で生成させるプロンプトを組む。
 *
 * 応答は下記スキーマの JSON 配列だけを返させる（前置き・後置きの散文を禁止）。
 * パースは parseComicName() が担う（コードフェンス除去＋部分抽出に耐える）。
 */
export function buildNamePrompt(
  synopsis: string,
  format: ComicFormat,
  characters: ComicCharacter[],
): string {
  const charList =
    characters.length > 0
      ? characters
          .map((c) => {
            const attr = c.attributes?.trim();
            return attr ? `- ${c.name}（${attr}）` : `- ${c.name}`;
          })
          .join("\n")
      : "（登場キャラの指定なし。話に合わせて配役してよい）";

  return [
    "あなたはプロの漫画ネーム作家です。以下の話を、指定コマ数の漫画ネーム（コマ割り＋セリフ）に構成してください。",
    "",
    "【話（あらすじ）】",
    synopsis.trim(),
    "",
    "【形式】",
    `全 ${format} コマ。起承転結を意識し、最後のコマでオチ・引きを作る。`,
    "",
    "【登場キャラ】",
    charList,
    "",
    "【出力形式（厳守）】",
    "次のスキーマの JSON 配列だけを出力してください。前置き・説明・コードフェンス外の文章を一切付けないでください。",
    "各要素:",
    "{",
    '  "index": コマ番号(1始まりの整数),',
    '  "composition": "構図・カメラの説明（引き/寄り、アングル、画角）",',
    '  "characters": ["このコマに登場するキャラ名", ...],',
    '  "acting": "演技・表情・動きの説明",',
    '  "dialogue": "セリフ（複数話者は改行区切り。無言コマは空文字）",',
    '  "prompt": "画像生成用の1コマ分プロンプト（構図＋演技＋背景を英語で簡潔に）"',
    "}",
    "",
    `配列の要素数は必ず ${format} 個にしてください。characters には上記の登場キャラ名を使ってください。`,
  ].join("\n");
}

/**
 * ネーム応答テキストから ComicPanel[] を抽出する。
 * - ```json フェンスがあれば剥がす
 * - 最初の '[' から対応する ']' までを JSON としてパースする
 * パースできない/形が違う場合は null を返す（呼び出し側でエラー表示）。
 */
export function parseComicName(raw: string): ComicPanel[] | null {
  if (!raw) return null;

  // コードフェンスを剥がす
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // 最初の配列を抽出（前後に散文が混ざっても拾う）
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);

  let data: unknown;
  try {
    data = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  const panels: ComicPanel[] = [];
  const panelNumbers = new Set<number>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.index !== "number" ||
      !Number.isInteger(obj.index) ||
      obj.index < 1 ||
      panelNumbers.has(obj.index)
    ) {
      return null;
    }
    if (typeof obj.prompt !== "string" || !obj.prompt.trim()) return null;
    panelNumbers.add(obj.index);
    const chars = Array.isArray(obj.characters)
      ? obj.characters.filter((c): c is string => typeof c === "string")
      : [];
    panels.push({
      index: obj.index,
      composition: typeof obj.composition === "string" ? obj.composition : "",
      characters: chars,
      acting: typeof obj.acting === "string" ? obj.acting : "",
      dialogue: typeof obj.dialogue === "string" ? obj.dialogue : "",
      prompt: obj.prompt,
    });
  }

  return panels;
}

/**
 * 1コマの画像生成プロンプトを組む。
 * コマの prompt（人が編集済み）に、登場キャラの属性テキストを合成する。
 * 参照画像は既存の refImagePaths 経路で別途渡すので、ここでは属性テキストのみ足す。
 */
export function buildPanelImagePrompt(
  panel: ComicPanel,
  characters: ComicCharacter[],
): string {
  const base = panel.prompt.trim() || panel.composition.trim();

  // このコマに登場するキャラの属性だけを合成する
  const appearing = characters.filter((c) =>
    panel.characters.some((name) => name.trim() === c.name.trim()),
  );
  const attrBlock = appearing
    .map((c) => (c.attributes?.trim() ? `${c.name}: ${c.attributes.trim()}` : ""))
    .filter(Boolean)
    .join("; ");

  const parts = [
    "manga panel, black and white line art, screentone",
    base,
  ];
  if (attrBlock) parts.push(`character design — ${attrBlock}`);
  if (panel.acting.trim()) parts.push(panel.acting.trim());

  return parts.filter(Boolean).join(", ");
}
