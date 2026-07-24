/**
 * 赤入れ反映スキルの解釈プロンプトと出力パーサ。
 *
 * 元画像 + 赤入れ画像（注釈入り）の2枚を AI に渡し、
 * 「読む→指す」= どこを何と直すかの構造化リスト（JSON）を返させる。
 */

import {
  isRedlineFixKind,
  type RedlineFixKind,
  type RedlineInstruction,
  type RedlineResult,
} from "./types";

/** 出力 JSON を識別するマーカー（planChat の [STORYBOARD_PARAMS] と同じ流儀）。 */
export const REDLINE_MARKER = "[REDLINE_INSTRUCTIONS]";

/**
 * 赤入れ解釈プロンプト。
 *
 * 1 枚目 = 元画像、2 枚目 = 赤入れ画像（注釈入り）として渡す前提で書く。
 * 出力末尾に [REDLINE_INSTRUCTIONS] { ...JSON... } を必ず 1 行付けさせる。
 *
 * no-silent-gap-filling: 赤入れが読めない・意図が確信できない箇所は
 * 推測で埋めず ambiguous=true にさせる（要確認バッジになる）。
 */
export const REDLINE_INTERPRET_PROMPT = [
  "あなたはデザイン制作の修正対応の専門家です。",
  "クライアントからの「赤入れ」（校正の指示書き）を読み取り、制作者が部分修正に使える指示リストに変換してください。",
  "",
  "【入力】",
  "- 1 枚目: 元画像（修正前のデザイン）",
  "- 2 枚目: 赤入れ画像（同じデザインに、丸囲み・矢印・取り消し線・書き込みで修正指示が入ったもの）",
  "  ※ 元画像が無く赤入れ画像だけの場合もあります。その場合は赤入れ画像だけから読み取ってください。",
  "",
  "【やること】",
  "赤入れの注釈（丸囲み・矢印・取り消し線・手書き文字・付箋コメント）を 1 つずつ読み取り、",
  "「どの領域を・何と・どう直すか」を構造化してください。位置は言葉で説明し、範囲を確信できる場合だけ bbox も付けます。",
  "",
  "【各指示に必ず含める項目】",
  "- number: 通し番号（1 始まり）",
  "- areaDescription: 対象領域を言葉で（例:「右上のロゴ付近」「見出しの2行目」「中央の人物の左手」）",
  "- bbox（範囲を確信できる場合だけ）: [x, y, width, height]。画像全体の幅・高さを 1 とした 0〜1 の小数で、x,y は左上。width,height は 0 より大きく、x+width と y+height は 1 以下",
  "- instruction: 何をどう直すか（例:「キャッチコピーを『春の新作』に変更」「背景の看板を消す」）",
  "- fixKind: 修正種別。次のいずれか:",
  "    remove（消す） / replace（置き換える） / adjust（位置・色・サイズを直す） / text（文字修正） / other（判別不能）",
  "- ambiguous: 指示の意図を確信できるなら false、赤入れが薄い・読めない・意図が曖昧なら true",
  "- ambiguityReason: ambiguous が true のときだけ、なぜ曖昧かを一言で",
  "",
  "【最重要・推測で埋めない】",
  "赤入れの文字が読めない、矢印がどこを指すか不明、複数解釈できる等の場合は、",
  "もっともらしく決めつけないでください。ambiguous を true にし、ambiguityReason に理由を書いてください。",
  "修正範囲を確信できない場合は bbox を推測で作らず、必ず省略して ambiguous を true にしてください。",
  "「読めない箇所を読めたことにする」のが最も避けたい失敗です。",
  "",
  "【出力フォーマット】",
  "最初に、見つけた修正点を日本語で簡潔に箇条書きしてください（人間が読む用）。",
  "そのあと、返答の末尾に必ず次の 1 行だけの JSON を出力してください（この行はアプリが機械的に読みます）:",
  "",
  `${REDLINE_MARKER} {"instructions":[{"number":1,"areaDescription":"...","bbox":[0.1,0.2,0.3,0.15],"instruction":"...","fixKind":"text","ambiguous":false},{"number":2,"areaDescription":"...","instruction":"...","fixKind":"remove","ambiguous":true,"ambiguityReason":"矢印の指す先が不明瞭"}],"overallNote":"任意の全体所見"}`,
  "",
  "JSON は 1 行で。instructions が空でも空配列で出力してください。",
].join("\n");

/**
 * マーカー以降の最初の { ... } を括弧の対応を数えて切り出し JSON.parse する。
 * planChat.ts の jsonAfterMarker と同じアルゴリズム（文字列内の括弧を無視）。
 */
function jsonAfterMarker(text: string, marker: string): unknown | null {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function normalizeFixKind(v: unknown): RedlineFixKind {
  return isRedlineFixKind(v) ? v : "other";
}

function normalizeBbox(v: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const [x, y, width, height] = v;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x > 1 ||
    y > 1 ||
    x + width > 1 ||
    y + height > 1
  ) {
    return undefined;
  }
  return [x, y, width, height];
}

function normalizeInstruction(
  raw: unknown,
  fallbackNumber: number,
): RedlineInstruction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const instruction = optStr(o.instruction);
  const areaDescription = optStr(o.areaDescription);
  // 指示本文が無いエントリは意味を持たないので落とす。
  if (!instruction) return null;
  const numberValue =
    typeof o.number === "number" && Number.isFinite(o.number)
      ? (o.number as number)
      : fallbackNumber;
  const ambiguous = o.ambiguous === true;
  // 曖昧な指示や不正な座標は bbox を欠落のまま保ち、推測・補正しない。
  const bbox = ambiguous ? undefined : normalizeBbox(o.bbox);
  return {
    number: numberValue,
    areaDescription: areaDescription ?? "（領域の説明なし）",
    ...(bbox ? { bbox } : {}),
    instruction,
    fixKind: normalizeFixKind(o.fixKind),
    ambiguous,
    ambiguityReason: ambiguous ? optStr(o.ambiguityReason) : undefined,
  };
}

/**
 * AI 応答テキストから REDLINE_INSTRUCTIONS JSON を抽出・正規化する。
 * マーカーが無い / JSON が壊れている場合は null を返す（推測で補完しない）。
 */
export function parseRedlineResult(text: string): RedlineResult | null {
  const payload = jsonAfterMarker(text, REDLINE_MARKER);
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.instructions)) return null;
  const rawList = root.instructions;
  const normalized = rawList.map((item, index) =>
    normalizeInstruction(item, index + 1),
  );
  if (!normalized.every((item): item is RedlineInstruction => item !== null)) {
    return null;
  }
  const instructions = normalized
    // 番号でソート（AI が番号を飛ばしても表示は昇順に揃える）。
    .sort((a, b) => a.number - b.number);
  return {
    instructions,
    overallNote: optStr(root.overallNote),
  };
}
