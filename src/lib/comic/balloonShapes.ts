/**
 * 吹き出しのジオメトリ定数（単一の真実）。
 *
 * 表示（SVG）と書き出し（Canvas）が同じ頂点・同じパディング・同じ線幅を使うため、
 * 「画面で見たとおりに書き出される」が構造的に保証される。
 * 座標は viewBox 0-100 のローカル percent（preserveAspectRatio="none" で要素へ引き伸ばす）。
 */

import type { ComicBalloonKind } from "./types";

/** 叫び（スパイク）: 24頂点。偶数=外周50、奇数=内周36。-90°起点で時計回り。 */
export const SHOUT_POINTS: [number, number][] = Array.from({ length: 24 }, (_, i) => {
  const a = ((i * 15 - 90) * Math.PI) / 180;
  const r = i % 2 === 0 ? 50 : 36;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
});

/** 心の声（六角形）。 */
export const MONOLOGUE_POINTS: [number, number][] = [
  [26, 2],
  [74, 2],
  [98, 50],
  [74, 98],
  [26, 98],
  [2, 50],
];

/** ナレーション（長方形。ストローク分を 2 内側へ）。 */
export const NARRATION_POINTS: [number, number][] = [
  [2, 2],
  [98, 2],
  [98, 98],
  [2, 98],
];

/**
 * kind → 多角形の頂点。normal は多角形でなく楕円
 * （<ellipse cx=50 cy=50 rx=49 ry=49>。stretch で楕円化）なので undefined。
 */
export function balloonPoints(kind: ComicBalloonKind): [number, number][] | undefined {
  if (kind === "shout") return SHOUT_POINTS;
  if (kind === "monologue") return MONOLOGUE_POINTS;
  if (kind === "narration") return NARRATION_POINTS;
  return undefined;
}

/** テキストの内側余白（表示 px。書き出しは EXPORT_SCALE 倍）。 */
export const BALLOON_PADDING: Record<ComicBalloonKind, { x: number; y: number }> = {
  normal: { x: 12, y: 14 },
  shout: { x: 16, y: 18 },
  monologue: { x: 10, y: 12 },
  narration: { x: 6, y: 8 },
};

/** 枠線の表示 px（書き出しは同比率でスケール）。 */
export const BALLOON_STROKE_PX = 1.5;
