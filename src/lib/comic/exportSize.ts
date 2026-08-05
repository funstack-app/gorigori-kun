/**
 * 漫画ページ書き出しの規格寸法（SNS 最適サイズ）と contain 計算。
 *
 * Tauri API を import しない純ロジックに保つ（テストから直接読める）。
 * savePage.ts は module top で convertFileSrc を import しており DOM/Tauri なしでは
 * 読み込めないため、計算だけをこちらへ分離している。
 */

/** 書き出し規格の形（将来の SNS 別プリセット拡張の受け皿。v1 は先頭1件だけ使う）。 */
export type ComicExportTarget = {
  width: number;
  height: number;
  /** contain = 切らずに収める（余白帯が出る）。cover は v1 では使わない。 */
  mode: "contain";
  /** contain で生じる帯の色。 */
  pad: string;
};

/**
 * 漫画ページの書き出し規格: 4:5（1080×1350）・contain・白帯。
 *
 * 4:5 は Instagram フィードで縦の上限（無加工で全表示）かつ X でも全表示される
 * 唯一の縦長比率。生成側は 3:4 を指定しているのにモデル出力が 2:3 と 3:4 に
 * スナップして混在するため（同一作品内でページの形が揃わない）、書き出しの瞬間に
 * ここへ固定する。contain なのはコマ・フキダシが四辺ぎりぎりまである漫画で
 * クロップが原理的に不可なため（情報を1画素も捨てない）。
 * 帯が白なのは漫画ページが「白い紙」の比喩で生成され、白帯が紙の余白に見えるため。
 */
export const COMIC_EXPORT_TARGET: ComicExportTarget = {
  width: 1080,
  height: 1350,
  mode: "contain",
  pad: "#ffffff",
};

/**
 * contain の描画矩形（中央配置）。
 *
 * 縮小のみ（scale は 1 を超えない）。小さい入力を引き伸ばすと粗さが目立つだけで
 * 情報は増えないため、規格寸法より小さいページは原寸のまま中央に置く。
 * 端数は round（切り捨てだと 1px の隙間が帯側に寄って左右非対称になる）。
 */
export function containRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(dstW / srcW, dstH / srcH, 1);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h };
}
