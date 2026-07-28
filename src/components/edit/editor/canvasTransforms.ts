/**
 * 切り抜き・回転・反転 (AI 不使用・数学的処理のみ)。
 *
 * ## 全レイヤーの相対位置がなぜ保たれるのか (設計の核)
 *
 * どの操作も「**キャンバスを元画像の実寸で1枚に焼いてから**、その1枚に対して
 * 切る/回す/反す」という手順で統一している。焼いた時点でベース画像・AI パッチ・
 * 置いた文字・下地はすべて同じ1枚の画素になっているので、そのあとの矩形クロップや
 * 90°回転は**画像全体に一様にかかる幾何変換**でしかない。レイヤーごとに座標を
 * 計算し直す経路が存在しないため、ズレようがない。
 *
 * fabric のオブジェクトを個別に動かす実装 (各レイヤーの left/top/angle を回す) は
 * 選ばなかった。理由は3つ:
 *   - 回転の中心・scaleX/scaleY・originX/originY の組み合わせで座標がずれる罠が多い
 *   - Textbox は回転すると折り返し幅の意味が変わり、見た目が変わってしまう
 *   - 90°回転でキャンバスの縦横が入れ替わるため、__ggBaseSize と各レイヤー座標を
 *     同時に整合させる必要があり、失敗したときに静かに壊れる
 * 「1枚に焼く」なら、この3つがすべて消える。
 *
 * ## 代償と、それを引き受ける理由
 *
 * 焼いた後はレイヤーが1枚に統合される (個別に動かせなくなる)。ただし
 * 切り抜き・回転は「ここから先はこの絵で作業する」という節目の操作であり、
 * Photoshop の「画像を統合」と同じ位置づけ。**undo で焼く前の状態に戻せる**ので、
 * 取り返しはつく (履歴はリセットしない)。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  exportCanvasPngBase64,
  fitCanvasToImage,
  getCanvasBaseSize,
  SOURCE_PREVIEW_ID,
} from "./magicLayerToFabric";

export type FlattenedImage = {
  /** data URL (image/png)。 */
  dataUrl: string;
  width: number;
  height: number;
};

/** 90°単位の回転方向と反転種別。 */
export type TransformKind = "rotate-left" | "rotate-right" | "flip-h" | "flip-v";

/** dataURL を HTMLImageElement として読む。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めません。"));
    image.src = src;
  });
}

/**
 * キャンバス全体を元画像の実寸で1枚の PNG に焼く。
 *
 * `exportCanvasPngBase64` は「書き出し」「作品にする」と同じ関数で、
 * ビューポート (ズーム/パン) を等倍に戻してから元画像寸法で切り出す。
 * つまり **画面の表示倍率に依存しない**。調整フィルタもここで焼き込まれる
 * (fabric の toDataURL は filters 適用後の画素を描くため)。
 */
export function flattenCanvas(canvas: unknown): FlattenedImage | null {
  const base64 = exportCanvasPngBase64(canvas);
  if (!base64) return null;
  const base = getCanvasBaseSize(canvas);
  if (!base) return null;
  return {
    dataUrl: `data:image/png;base64,${base64}`,
    width: base.width,
    height: base.height,
  };
}

/**
 * 焼いた1枚をキャンバスへ置き直す (既存レイヤーは全部消える)。
 *
 * 履歴はここでは触らない。呼び出し側が操作の確定として1回だけ pushHistory する
 * (「切り抜き」も「回転」も、ユーザーの体感は1操作 = 1回の『戻す』)。
 */
async function replaceCanvasWithImage(
  canvas: unknown,
  dataUrl: string,
  width: number,
  height: number,
  name: string,
): Promise<void> {
  // @ts-ignore fabric is installed at runtime via package dependency
  const fabric = (await import("fabric")) as any;
  const ImageClass = fabric.FabricImage ?? fabric.Image;
  if (!ImageClass?.fromURL) throw new Error("Fabric.js Image.fromURL が見つかりません");
  const loaded = ImageClass.fromURL(dataUrl, { crossOrigin: "anonymous" });
  const image = typeof loaded?.then === "function" ? await loaded : loaded;

  const target = canvas as {
    discardActiveObject?: () => void;
    clear?: () => void;
    setViewportTransform?: (transform: number[]) => void;
    backgroundColor?: string;
    add?: (object: unknown) => void;
    requestRenderAll?: () => void;
  };
  target.discardActiveObject?.();
  target.clear?.();
  target.setViewportTransform?.([1, 0, 0, 1, 0, 0]);
  target.backgroundColor = "#1a1a1a";
  image.set({
    // 焼き直した1枚は「元画像プレビュー」と同じ立ち位置に置く。これで
    // 「調整」チップは引き続きこのレイヤーを掴めるし、範囲指定・書き出しの
    // 基準 (__ggBaseSize) とも一致する。
    id: SOURCE_PREVIEW_ID,
    name,
    layerKind: "image",
    genre: "background",
    left: 0,
    top: 0,
    selectable: false,
    evented: false,
  });
  target.add?.(image);
  fitCanvasToImage(canvas as never, width, height);
  target.requestRenderAll?.();
}

/**
 * 囲んだ範囲でキャンバスを切り抜く。
 *
 * bboxNorm は RegionSelectOverlay が返す 0..1 の正規化値。焼いた1枚に対して
 * 実寸へ戻してから切るので、**全レイヤーの相対位置はそのまま**残る
 * (焼いた時点で1枚になっているため、位置関係を再計算する処理が存在しない)。
 */
export async function cropCanvasToRegion(
  canvas: unknown,
  bboxNorm: [number, number, number, number],
): Promise<boolean> {
  const flat = flattenCanvas(canvas);
  if (!flat) return false;
  const [nx, ny, nw, nh] = bboxNorm;
  // 実寸へ戻す。切り上げ/切り捨ての差で 0px にならないよう最低 1px を保証する。
  const left = Math.max(0, Math.floor(nx * flat.width));
  const top = Math.max(0, Math.floor(ny * flat.height));
  const width = Math.max(1, Math.min(flat.width - left, Math.round(nw * flat.width)));
  const height = Math.max(1, Math.min(flat.height - top, Math.round(nh * flat.height)));

  const image = await loadImage(flat.dataUrl);
  const work = document.createElement("canvas");
  work.width = width;
  work.height = height;
  const context = work.getContext("2d");
  if (!context) throw new Error("canvas context を取得できません。");
  context.drawImage(image, left, top, width, height, 0, 0, width, height);
  await replaceCanvasWithImage(canvas, work.toDataURL("image/png"), width, height, "切り抜いた画像");
  return true;
}

/**
 * キャンバス全体を90°回転 / 反転する。
 *
 * 90°回転では出力の縦横が入れ替わる。`fitCanvasToImage` に新しい寸法を渡すので、
 * 以降の範囲指定・書き出しも新しい寸法を基準に動く (基準がズレたまま残らない)。
 */
export async function transformCanvas(
  canvas: unknown,
  kind: TransformKind,
): Promise<boolean> {
  const flat = flattenCanvas(canvas);
  if (!flat) return false;
  const image = await loadImage(flat.dataUrl);
  const rotated = kind === "rotate-left" || kind === "rotate-right";
  const outWidth = rotated ? flat.height : flat.width;
  const outHeight = rotated ? flat.width : flat.height;

  const work = document.createElement("canvas");
  work.width = outWidth;
  work.height = outHeight;
  const context = work.getContext("2d");
  if (!context) throw new Error("canvas context を取得できません。");

  // 出力の中心を原点にしてから変換をかける。90°回転で縦横が入れ替わっても、
  // 中心合わせなら位置合わせの計算が1本で済む。
  context.translate(outWidth / 2, outHeight / 2);
  if (kind === "rotate-right") context.rotate(Math.PI / 2);
  if (kind === "rotate-left") context.rotate(-Math.PI / 2);
  if (kind === "flip-h") context.scale(-1, 1);
  if (kind === "flip-v") context.scale(1, -1);
  context.drawImage(image, -flat.width / 2, -flat.height / 2);

  await replaceCanvasWithImage(
    canvas,
    work.toDataURL("image/png"),
    outWidth,
    outHeight,
    "元画像",
  );
  return true;
}

/**
 * ディスク上の画像ファイルでキャンバスを丸ごと置き換える (背景透過の結果を受ける口)。
 *
 * 切り抜き・回転が dataURL を渡すのに対し、こちらは Rust コマンドが返した path を
 * 受ける。中身は同じ `replaceCanvasWithImage` なので、
 *   - 置き換え前の状態は履歴に残る (呼び出し側が push するので『戻す』1手で戻る)
 *   - 新しい1枚は SOURCE_PREVIEW_ID を持つ = 以後「調整」「切り抜き」の対象になる
 *   - __ggBaseSize が新寸法に揃う = 範囲指定・書き出しの基準もズレない
 * という性質をそのまま引き継ぐ。
 *
 * width/height は呼び出し元が知っている想定寸法 (焼いた元の寸法)。透過処理は
 * 寸法を変えない前提だが、実際に読み込んだ画像の寸法があればそちらを優先する
 * (**「その時の値」を信じない**。将来 padding や余白トリムが入っても壊れないようにする)。
 */
export async function replaceCanvasWithImagePath(
  canvas: unknown,
  imagePath: string,
  width: number,
  height: number,
  name = "元画像",
): Promise<void> {
  const url = convertFileSrc(imagePath);
  const loaded = await loadImage(url);
  const actualWidth = loaded.naturalWidth || loaded.width || width;
  const actualHeight = loaded.naturalHeight || loaded.height || height;
  await replaceCanvasWithImage(canvas, url, actualWidth, actualHeight, name);
}
