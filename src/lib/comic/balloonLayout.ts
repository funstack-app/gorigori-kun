/**
 * 吹き出し・擬音の初期配置とフォントの決定論ルール（表示・書き出し共用）。
 *
 * 読み順（右上 → 左下）に沿い、絵の主要部（コマ中央）を避ける。
 * コマの実比率で wide / square / tall の3分岐にするのは、横長コマでは人物の頭が
 * 上帯に並ぶ / 縦長コマでは上下に分かれると読み順が保たれる、という漫画の文法による。
 */

import { slotAspectRatio, type ComicLayoutTemplate } from "./layoutTemplates";
import type { ComicBalloonKind, ComicSfxIntent } from "./types";

/** コマの形状クラス（初期配置スロットの分岐）。 */
export type SlotShapeClass = "wide" | "square" | "tall";

/**
 * コマ bbox の実比率から形状クラスを返す。
 * 閾値 1.4 / 0.72 は describeSlotShape と同一定数（同じ形状語彙で分岐する）。
 */
export function slotShapeClass(t: ComicLayoutTemplate, i: number): SlotShapeClass {
  const ratio = slotAspectRatio(t, i);
  if (ratio >= 1.4) return "wide";
  if (ratio <= 0.72) return "tall";
  return "square";
}

/** 自動初期配置の CSS（コマ div 内の絶対配置）。 */
export type BalloonAutoPlacement = {
  right?: string;
  left?: string;
  top?: string;
  bottom?: string;
  maxWidth: string;
  maxHeight: string;
};

/**
 * 吹き出しの自動初期配置（pos === null のとき）。
 * `order` は balloons 配列内の位置（0 = 先に話す = 右上）。
 */
export function balloonAutoPlacement(
  shape: SlotShapeClass,
  order: number,
): BalloonAutoPlacement {
  const first = order === 0;
  if (shape === "wide") {
    return {
      ...(first ? { right: "2%" } : { left: "2%" }),
      top: "4%",
      maxWidth: "28%",
      maxHeight: "90%",
    };
  }
  if (shape === "tall") {
    return first
      ? { right: "3%", top: "2%", maxWidth: "70%", maxHeight: "45%" }
      : { left: "3%", bottom: "2%", maxWidth: "70%", maxHeight: "45%" };
  }
  return first
    ? { right: "3%", top: "3%", maxWidth: "46%", maxHeight: "92%" }
    : { left: "3%", bottom: "3%", maxWidth: "46%", maxHeight: "92%" };
}

/** 吹き出しの文字数から段階的にフォントを縮める（決定論）。 */
export function balloonFontSize(text: string): string {
  const len = text.replace(/\n/g, "").length;
  if (len <= 20) return "12px";
  if (len <= 40) return "11px";
  return "9px";
}

export const SFX_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif';
/** セリフも同スタック（ウェイトのみ違う）。 */
export const BALLOON_FONT_FAMILY = SFX_FONT_FAMILY;

/** kind ごとの追加スタイル（叫びは太字）。 */
export const BALLOON_FONT_WEIGHT: Record<ComicBalloonKind, number> = {
  normal: 500,
  shout: 900,
  monologue: 500,
  narration: 500,
};

export const SFX_INTENT: Record<ComicSfxIntent, { rotation: number; scale: number }> = {
  impact: { rotation: -12, scale: 1.4 },
  motion: { rotation: -18, scale: 1.0 },
  quiet: { rotation: 0, scale: 0.8 },
  emotion: { rotation: 8, scale: 0.9 },
};

/** 擬音の表示フォント px（決定論）。基準26px×intent倍率、5文字以上で縮小、下限12。 */
export function sfxFontPx(text: string, scale: number): number {
  const len = Math.max(1, [...text].length);
  return Math.max(12, Math.round(26 * scale * Math.min(1, 4 / len)));
}

/** 自動初期配置（コマ bbox percent・左上）。吹き出しスロット（右上/左下）と重ねない。 */
export const SFX_AUTO_SLOTS: Array<{ x: number; y: number }> = [
  { x: 6, y: 40 }, // 1個目: 左中段（動きの起点側）
  { x: 56, y: 68 }, // 2個目: 右下段
];

/** 黒縁の太さ（フォント px に対する比率）。表示 SVG と書き出し Canvas で共用。 */
export const SFX_STROKE_RATIO = 0.16;

/**
 * 字間（em）。quiet だけ広げて「間」を表す。
 * 表示は `${値}em`、書き出しは fontPx を掛けて手送りに使う（同じ1つの定義）。
 */
export const SFX_LETTER_SPACING: Record<ComicSfxIntent, number> = {
  impact: 0.02,
  motion: 0.02,
  quiet: 0.35,
  emotion: 0.02,
};

/**
 * 擬音の描画ボックス（表示 px）。フォント px と文字数から決定論で出す。
 * 表示（SVG の width/height）と書き出し（rect が取れないときの保険）で同じ式を使う。
 * 縁取りが切れないよう左右上下にストローク分の余白を足す。
 */
export function sfxBoxSize(
  text: string,
  intent: ComicSfxIntent,
  fontPx: number,
): { w: number; h: number } {
  const len = Math.max(1, [...text].length);
  const margin = fontPx * SFX_STROKE_RATIO * 2;
  return {
    w: Math.round(fontPx * len * (1 + SFX_LETTER_SPACING[intent]) + margin),
    h: Math.round(fontPx + margin),
  };
}
