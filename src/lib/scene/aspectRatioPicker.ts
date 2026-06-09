import { aspectRatioOptions } from "./catalog";
import type { SceneOption } from "./catalog";
import type { SceneAspectRatio } from "./types";

/**
 * アスペクト比ポップアップの共通定義。
 *
 * 通常制作画面 (ConstructedPromptPanel) とマルチアングル (AngleSettingsPanel) の
 * 両方が同じ OptionPickerModal でアスペクト比を選べるよう、ヒント文・サムネ生成・
 * SceneOption 配列を1か所に集約する。比率を増減するときは scene/catalog.ts の
 * aspectRatioOptions と scene/types.ts の SceneAspectRatio、そして本ファイルの
 * ASPECT_RATIO_HINTS を同じ並びで揃える (3箇所)。
 *
 * GPT Image 2 公式制約 (1:3〜3:1, 両辺16の倍数) 内の比率のみを扱う。詳細は
 * scene/types.ts のコメント参照。
 */
export const ASPECT_RATIO_HINTS: Record<SceneAspectRatio, string> = {
  "21:9": "シネマスコープ・超横長",
  "16:9": "動画/YouTube・標準横長",
  "3:2": "写真標準・カメラ初期値",
  "4:3": "クラシック・印刷/プレゼン",
  "5:4": "ほぼ正方の横・物撮り",
  "1:1": "正方形・Instagram投稿",
  "4:5": "縦長・Instagram投稿",
  "3:4": "ポートレート・A判縦",
  "2:3": "ポートレート・ポスター",
  "9:16": "Reels/TikTok/Stories",
};

/**
 * アスペクト比のサムネ SVG を data URI で生成する。
 *
 * STΛCK 指示 (2026-05-19, 修正版):
 * - 数字は白で統一 (ピンクはやめる)
 * - フォントサイズは固定値 (全カードで同じ)
 * - サムネ枠の中に必ず収まる (max-side を 70% に制限)
 * - 背景にグラデ、内側カードに薄ストロークでアスペクト比を視覚化
 */
export function aspectThumbnail(ratio: string): { src: string; alt: string } {
  const [wStr, hStr] = ratio.split(":");
  const w = parseInt(wStr, 10) || 1;
  const h = parseInt(hStr, 10) || 1;
  // canvas は 16:9 想定 (PickerCard が aspect-video のため)
  const canvasW = 320;
  const canvasH = 180;
  // 内側 rect は canvas の 70% を上限に、アスペクト比に応じて自動調整
  const maxW = canvasW * 0.7;
  const maxH = canvasH * 0.7;
  const ratioWH = w / h;
  let rectW: number;
  let rectH: number;
  if (ratioWH >= maxW / maxH) {
    // 横長 → 幅で制約
    rectW = maxW;
    rectH = rectW / ratioWH;
  } else {
    // 縦長 → 高さで制約
    rectH = maxH;
    rectW = rectH * ratioWH;
  }
  const x = (canvasW - rectW) / 2;
  const y = (canvasH - rectH) / 2;
  // 文字サイズは全カード固定 (28px)。色は白。
  const fontSize = 28;
  const gradId = `bg-${ratio.replace(":", "x")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1a1a1a"/>
        <stop offset="100%" stop-color="#0a0a0a"/>
      </linearGradient>
    </defs>
    <rect width="${canvasW}" height="${canvasH}" fill="url(#${gradId})"/>
    <rect x="${x}" y="${y}" width="${rectW}" height="${rectH}" rx="4" fill="#202020" stroke="#3a3a3a" stroke-width="1"/>
    <text x="${canvasW / 2}" y="${canvasH / 2 + fontSize * 0.34}" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="${fontSize}" font-weight="800" fill="#ffffff" letter-spacing="-1">${ratio}</text>
  </svg>`;
  return {
    src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    alt: ratio,
  };
}

/** OptionPickerModal にそのまま渡せるアスペクト比カード一覧。 */
export const ASPECT_RATIO_PICKER_OPTIONS: SceneOption[] = aspectRatioOptions.map(
  (value) => ({
    value,
    hint: ASPECT_RATIO_HINTS[value],
    visual: "aspect",
    thumbnail: aspectThumbnail(value),
  }),
);
