import { convertFileSrc } from "@tauri-apps/api/core";

import type { GrabResult, MagicLayerResult, SegmentResult, TextRegion, WordsSegmentResult } from "../../../lib/edit/types";
import { createLayerId } from "./layerHelpers";

type FabricModule = Record<string, any>;
type FabricCanvas = any;
type FabricObject = any;

export async function applyMagicLayerToCanvas(
  canvas: FabricCanvas,
  result: MagicLayerResult,
) {
  // 高精度モード: 認識した人物パーツ群をレイヤー展開する別経路。
  // partLayers が入っているときは前景/マスクの単一切り抜きではなくパーツ集合で構成する。
  if (result.partLayers && result.partLayers.length > 0) {
    await applyPartLayersToCanvas(canvas, result);
    return;
  }

  const fabric = await importFabric();
  clearCanvas(canvas);
  canvas.backgroundColor = "#1a1a1a";

  const bgImg = await loadFabricImage(fabric, result.backgroundPath);
  bgImg.set({
    id: "bg",
    name: "背景",
    layerKind: "image",
    left: 0,
    top: 0,
    selectable: true,
  });
  canvas.add(bgImg);

  const fgImg = await loadFabricImage(fabric, result.foregroundPath);
  fgImg.set({
    id: "fg",
    name: "前景",
    layerKind: "image",
    left: 0,
    top: 0,
    selectable: true,
  });
  canvas.add(fgImg);

  // 主要物体レイヤー: 各物体を bbox 位置の可動レイヤーとして前景の上に積む。
  // 背景 (result.backgroundPath) は union マスクで穴埋め済みなので、物体を動かしても
  // 跡地に補完済み背景が見える。
  if (result.objectLayers && result.objectLayers.length > 0) {
    for (const object of result.objectLayers) {
      const objImg = await loadFabricImage(fabric, object.imagePath);
      const [ox, oy] = object.bbox;
      objImg.set({
        id: createLayerId(),
        name: object.label,
        layerKind: "image",
        // 分解直後は必ず元画像の中 (bbox 位置) に重ねて置く。bbox が万一負値・NaN で
        // 返ってきても画面外 (例: x=-878) に飛ばさないよう 0..画像内にクランプする。
        // なぜ: レイヤーが最初から画面外にあると、非エンジニアには「消えた」ように見える。
        left: clampPlacement(ox, result.width),
        top: clampPlacement(oy, result.height),
        selectable: true,
      });
      canvas.add(objImg);
    }
  }

  await addTextLayersToCanvas(canvas, fabric, result.textLayers, result.width, result.height);

  fitCanvasToImage(canvas, result.width, result.height);
  canvas.renderAll?.();
}

/**
 * 高精度モードの結果展開: 元画像を背景に置き、認識した人物パーツ (髪/上衣/パンツ等)
 * をそれぞれ独立レイヤーとして重ねる。背景は薄く敷いてパーツの位置確認用にする。
 */
async function applyPartLayersToCanvas(
  canvas: FabricCanvas,
  result: MagicLayerResult,
) {
  const fabric = await importFabric();
  clearCanvas(canvas);
  canvas.backgroundColor = "#1a1a1a";

  // 元画像を背景として薄く敷く (パーツ抜き後の下地確認 + 位置の手がかり)。
  if (result.backgroundPath) {
    const bgImg = await loadFabricImage(fabric, result.backgroundPath);
    bgImg.set({
      id: "bg",
      name: "元画像 (背景)",
      layerKind: "image",
      left: 0,
      top: 0,
      opacity: 0.25,
      selectable: true,
    });
    canvas.add(bgImg);
  }

  // 認識パーツを大きい順に積む (大きいパーツを下、小さいパーツを上にして選びやすく)。
  const ordered = [...result.partLayers].sort((a, b) => b.pixelCount - a.pixelCount);
  for (const part of ordered) {
    const img = await loadFabricImage(fabric, part.imagePath);
    img.set({
      id: createLayerId(),
      name: part.label,
      layerKind: "image",
      left: 0,
      top: 0,
      selectable: true,
    });
    canvas.add(img);
  }

  fitCanvasToImage(canvas, result.width, result.height);
  canvas.renderAll?.();
}

export async function applySegmentResultToCanvas(
  canvas: FabricCanvas,
  result: SegmentResult,
) {
  const magicLike: MagicLayerResult = {
    backgroundPath: result.backgroundPath,
    foregroundPath: result.foregroundPath,
    maskPath: result.maskPath,
    textLayers: [],
    partLayers: [],
    objectLayers: [],
    width: result.width,
    height: result.height,
    runDir: "",
  };
  await applyMagicLayerToCanvas(canvas, magicLike);
}

/**
 * マジックグラブの結果をキャンバスへアトミックに反映する。
 *
 * 1. 背景レイヤー (id="bg") があれば、その画像を穴埋め済み背景 (filledBackground) に差し替える。
 *    背景レイヤーが無い (Magic Layer 未実行で素の画像を1枚置いただけ等) 場合は、最背面へ
 *    filledBackground を新規追加する。
 * 2. 掴んだオブジェクト (objectPng) を bbox 位置に新規レイヤーとして最前面に追加し、選択状態にする。
 *    → そのまま move / scale / rotate できる。
 *
 * アトミック性: 背景差し替えとオブジェクト追加のどちらかが失敗したら例外を投げ、呼び出し側
 * (useEditorActions) が「掴む前の状態」に戻す。ここでは throw することで中途半端な適用を防ぐ。
 */
export async function applyGrabResultToCanvas(
  canvas: FabricCanvas,
  result: GrabResult,
): Promise<void> {
  const fabric = await importFabric();

  // 1. 穴埋め背景を読み込む (これが失敗したら何も変えずに throw)。
  const filledBg = await loadFabricImage(fabric, result.filledBackground);
  // 2. 掴むオブジェクトを読み込む (これも先に読んでおき、両方成功してから canvas を変更する)。
  const objectImg = await loadFabricImage(fabric, result.objectPng);

  // ここから下は例外を投げない同期的な差し込みのみ。両画像のロードが済んでいるので
  // 途中で失敗して片方だけ反映される事態を避けられる。
  const objects: FabricObject[] = canvas.getObjects?.() ?? [];
  const bgLayer = objects.find((object: FabricObject) => object.get?.("id") === "bg");

  if (bgLayer && typeof bgLayer.setSrc === "function") {
    // 既存背景レイヤーの位置/変換を維持したまま画像だけ差し替える。
    const setSrc = bgLayer.setSrc(convertFileSrc(result.filledBackground), {
      crossOrigin: "anonymous",
    });
    if (typeof setSrc?.then === "function") {
      await setSrc;
    }
  } else {
    // 背景レイヤーが無い構成: 穴埋め背景を最背面に敷く。
    filledBg.set({
      id: "bg",
      name: "背景",
      layerKind: "image",
      left: 0,
      top: 0,
      selectable: true,
    });
    canvas.add(filledBg);
    if (typeof canvas.sendObjectToBack === "function") {
      canvas.sendObjectToBack(filledBg);
    } else if (typeof canvas.sendToBack === "function") {
      canvas.sendToBack(filledBg);
    }
  }

  const [bx, by] = result.bbox;
  objectImg.set({
    id: createLayerId(),
    name: "掴んだオブジェクト",
    layerKind: "image",
    left: bx,
    top: by,
    selectable: true,
  });
  canvas.add(objectImg);
  canvas.setActiveObject?.(objectImg);
  canvas.requestRenderAll?.();
}

const GRAB_PREVIEW_ID = "grab-preview";

/**
 * マジックグラブ確定前のプレビューマスクをキャンバスに重ねる (非選択・半透明ピンク寄せ)。
 * 既存プレビューがあれば置き換える。掴む/やり直す時に removeGrabPreviewOverlay で消す。
 */
export async function showGrabPreviewOverlay(canvas: FabricCanvas, maskBase64: string) {
  removeGrabPreviewOverlay(canvas);
  const fabric = await importFabric();
  const image = await loadFabricImageFromUrl(fabric, `data:image/png;base64,${maskBase64}`);
  image.set({
    id: GRAB_PREVIEW_ID,
    name: "掴む範囲プレビュー",
    layerKind: "mask",
    left: 0,
    top: 0,
    opacity: 0.45,
    selectable: false,
    evented: false,
  });
  canvas.add(image);
  canvas.requestRenderAll?.();
}

/** グラブプレビューのオーバーレイを取り除く。 */
export function removeGrabPreviewOverlay(canvas: FabricCanvas) {
  const objects: FabricObject[] = canvas.getObjects?.() ?? [];
  const existing = objects.find((object: FabricObject) => object.get?.("id") === GRAB_PREVIEW_ID);
  if (existing) {
    canvas.remove?.(existing);
    canvas.requestRenderAll?.();
  }
}

export async function addImageLayerToCanvas(
  canvas: FabricCanvas,
  imagePath: string,
  name = "画像",
  options: Record<string, unknown> = {},
) {
  const fabric = await importFabric();
  const image = await loadFabricImage(fabric, imagePath);
  image.set({
    id: createLayerId(),
    name,
    layerKind: "image",
    left: 80,
    top: 80,
    selectable: true,
    ...options,
  });
  canvas.add(image);
  canvas.setActiveObject?.(image);
  canvas.requestRenderAll?.();
  return image;
}

/** 分解前の元画像プレビューレイヤーの固定 id。分解ボタンの表示判定で除外するために使う。 */
export const SOURCE_PREVIEW_ID = "source-preview";

/**
 * 画像を開いた直後の「分解前プレビュー」をキャンバスに表示する。
 *
 * 2026-07-03 まで画像を開くと即 Magic Layer が走っていたが、「ことばで分離」の
 * 追加で分解方法が複数になったため、開いたら待機してユーザーに選ばせる。
 * このプレビューはレイヤーではない (選択不可・分解ボタンの数勘定から除外)。
 */
export async function showSourceImagePreview(
  canvas: FabricCanvas,
  imagePath: string,
): Promise<void> {
  const fabric = await importFabric();
  clearCanvas(canvas);
  canvas.backgroundColor = "#1a1a1a";
  const image = await loadFabricImage(fabric, imagePath);
  image.set({
    id: SOURCE_PREVIEW_ID,
    name: "元画像",
    layerKind: "image",
    left: 0,
    top: 0,
    selectable: false,
    evented: false,
  });
  canvas.add(image);
  fitCanvasToImage(canvas, image.width ?? 0, image.height ?? 0);
  canvas.requestRenderAll?.();
}

/**
 * テキストレイヤー群をキャンバスへ置く。
 * 既定は「元画素そのまま」の画像レイヤー (白い文字の見た目を100%維持)。認識済みの
 * 文字情報は textSpec としてレイヤーに保持し、プロパティパネルの「テキストとして編集」で
 * いつでも打ち替え可能な textbox に変換できる (2026-07-03 STΛCK「白い文字のまま」)。
 * 素材が無い region だけ従来どおり textbox で置く。
 */
async function addTextLayersToCanvas(
  canvas: FabricCanvas,
  fabric: FabricModule,
  textLayers: WordsSegmentResult["textLayers"],
  width: number,
  height: number,
): Promise<number> {
  let added = 0;
  for (const [index, text] of textLayers.entries()) {
    if (text.imagePath && text.imageBbox) {
      const image = await loadFabricImage(fabric, text.imagePath);
      const [x, y] = text.imageBbox;
      image.set({
        id: text.id ?? `text-${index + 1}`,
        name: text.name ?? `テキスト ${index + 1}`,
        layerKind: "image",
        left: clampPlacement(x, width),
        top: clampPlacement(y, height),
        selectable: true,
        sourcePath: text.imagePath,
        sourceBbox: text.imageBbox,
        // 打ち替え変換用に認識結果を保持する (JSON化しても残るプレーン値)。
        textSpec: {
          text: text.text,
          fontFamily: text.fontFamily,
          fontSize: text.fontSize,
          fontWeight: text.fontWeight,
          color: text.color,
          align: text.align,
          width: text.bbox?.[2] ?? 240,
        },
      });
      canvas.add(image);
      added += 1;
      continue;
    }
    const bbox = text.bbox;
    const textbox = new fabric.Textbox(text.text || "テキスト", {
      id: text.id ?? `text-${index + 1}`,
      name: text.name ?? `テキスト ${index + 1}`,
      layerKind: "text",
      left: clampPlacement(text.x ?? bbox?.[0] ?? 50, width),
      top: clampPlacement(text.y ?? bbox?.[1] ?? 50 + index * 52, height),
      width: bbox?.[2] ?? 240,
      fontSize: text.fontSize ?? 28,
      fill: text.color ?? "#ffffff",
      fontFamily: text.fontFamily ?? "Hiragino Sans",
      fontWeight: text.fontWeight ?? "normal",
      textAlign: text.align ?? "left",
      opacity: text.opacity ?? 1,
      angle: text.rotation ?? 0,
    });
    canvas.add(textbox);
    added += 1;
  }
  return added;
}

/**
 * 「元画素そのまま」のテキスト画像レイヤーを、打ち替え可能な textbox へ変換する。
 * textSpec を持つ画像レイヤーだけが対象。成功で true。
 */
export async function convertTextImageToTextbox(
  canvas: FabricCanvas,
  object: FabricObject,
): Promise<boolean> {
  const spec = object.get?.("textSpec") as
    | {
        text?: string;
        fontFamily?: string;
        fontSize?: number;
        fontWeight?: string;
        color?: string;
        align?: string;
        width?: number;
      }
    | undefined;
  if (!spec) return false;
  const fabric = await importFabric();
  const left = object.left ?? 0;
  const top = object.top ?? 0;
  const name = (object.get?.("name") as string) ?? "テキスト";
  const id = (object.get?.("id") as string) ?? createLayerId();
  canvas.remove(object);
  const textbox = new fabric.Textbox(spec.text || "テキスト", {
    id,
    name,
    layerKind: "text",
    left,
    top,
    width: spec.width ?? 240,
    fontSize: spec.fontSize ?? 28,
    fill: spec.color ?? "#ffffff",
    fontFamily: spec.fontFamily ?? "Hiragino Sans",
    fontWeight: spec.fontWeight ?? "normal",
    textAlign: spec.align ?? "left",
  });
  canvas.add(textbox);
  canvas.setActiveObject?.(textbox);
  canvas.requestRenderAll?.();
  return true;
}

/**
 * ことばで分離 (full モード) の結果でキャンバスを構成し直す。
 * Magic Layer と同じ層構造: 補完済み背景 → 物体レイヤー (語がレイヤー名) →
 * 編集可能テキストレイヤー。追加したレイヤー数 (背景含む) を返す。
 */
export async function applyWordsResultToCanvas(
  canvas: FabricCanvas,
  result: WordsSegmentResult,
): Promise<number> {
  const fabric = await importFabric();
  clearCanvas(canvas);
  canvas.backgroundColor = "#1a1a1a";
  let added = 0;

  if (result.backgroundPath) {
    const bgImg = await loadFabricImage(fabric, result.backgroundPath);
    bgImg.set({
      id: "bg",
      name: "背景",
      layerKind: "image",
      left: 0,
      top: 0,
      selectable: true,
    });
    canvas.add(bgImg);
    added += 1;
  }

  for (const layer of result.layers) {
    const image = await loadFabricImage(fabric, layer.imagePath);
    const [x, y] = layer.bbox;
    image.set({
      id: createLayerId(),
      name: layer.label,
      layerKind: "image",
      left: clampPlacement(x, result.width),
      top: clampPlacement(y, result.height),
      selectable: true,
      // AI再生成 (同じ雰囲気で差し替え) 用に切り出し元の情報を保持する。
      sourcePath: layer.imagePath,
      sourceBbox: layer.bbox,
    });
    canvas.add(image);
    added += 1;
  }

  added += await addTextLayersToCanvas(canvas, fabric, result.textLayers, result.width, result.height);

  fitCanvasToImage(canvas, result.width, result.height);
  canvas.renderAll?.();
  return added;
}

/**
 * ことばで分離 (SAM3) の検出レイヤーを bbox 位置の可動レイヤーとしてキャンバスへ積む。
 * Magic Layer の objectLayers と同じ流儀 (bbox クランプ + label がレイヤー名)。
 * 追加したレイヤー数を返す。
 */
export async function addWordLayersToCanvas(
  canvas: FabricCanvas,
  result: WordsSegmentResult,
): Promise<number> {
  const fabric = await importFabric();
  let added = 0;
  let last: FabricObject | null = null;
  for (const layer of result.layers) {
    const image = await loadFabricImage(fabric, layer.imagePath);
    const [x, y] = layer.bbox;
    image.set({
      id: createLayerId(),
      name: layer.label,
      layerKind: "image",
      left: clampPlacement(x, result.width),
      top: clampPlacement(y, result.height),
      selectable: true,
      sourcePath: layer.imagePath,
      sourceBbox: layer.bbox,
    });
    canvas.add(image);
    last = image;
    added += 1;
  }
  if (last) canvas.setActiveObject?.(last);
  canvas.requestRenderAll?.();
  return added;
}

export async function addMaskLayerFromBase64(
  canvas: FabricCanvas,
  base64: string,
  name = "クリック切り抜きマスク",
) {
  const fabric = await importFabric();
  const image = await loadFabricImageFromUrl(fabric, `data:image/png;base64,${base64}`);
  image.set({
    id: createLayerId(),
    name,
    layerKind: "mask",
    left: 0,
    top: 0,
    opacity: 0.55,
    selectable: true,
  });
  canvas.add(image);
  canvas.setActiveObject?.(image);
  canvas.requestRenderAll?.();
  return image;
}

export async function addTextRegionsToCanvas(canvas: FabricCanvas, regions: TextRegion[]) {
  const fabric = await importFabric();
  regions.forEach((region, index) => {
    const textbox = new fabric.Textbox(region.text || "テキスト", {
      id: region.id || createLayerId(),
      name: `検出テキスト ${index + 1}`,
      layerKind: "text",
      left: region.bbox[0],
      top: region.bbox[1],
      width: Math.max(120, region.bbox[2]),
      fontSize: 28,
      fill: "#ffffff",
      fontFamily: "Hiragino Sans",
      backgroundColor: "rgba(0,0,0,0.18)",
    });
    canvas.add(textbox);
  });
  canvas.requestRenderAll?.();
}

export async function addTextLayer(canvas: FabricCanvas) {
  const fabric = await importFabric();
  const center = canvas.getCenter?.() ?? { left: 240, top: 180 };
  const textbox = new fabric.Textbox("新しいテキスト", {
    id: createLayerId(),
    name: "テキスト",
    layerKind: "text",
    left: center.left - 120,
    top: center.top - 24,
    width: 240,
    fontSize: 32,
    fill: "#ffffff",
    fontFamily: "Hiragino Sans",
    fontWeight: "normal",
  });
  canvas.add(textbox);
  canvas.setActiveObject?.(textbox);
  canvas.requestRenderAll?.();
  return textbox;
}

/**
 * 分解直後のレイヤー初期座標を画像内 (0..limit) に収める安全弁。
 * bbox が負値・NaN・画像外を返しても、レイヤーを画面外に飛ばさない。
 * limit (= 画像幅/高さ) が不明なときは 0 以上にだけ丸める。
 */
function clampPlacement(value: number | undefined, limit: number | undefined): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (n < 0) return 0;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0 && n > limit) {
    return limit;
  }
  return n;
}

export function fitCanvasToImage(canvas: FabricCanvas, imageWidth: number, imageHeight: number) {
  // PNG書き出し・整列の基準になる「元画像の寸法」をキャンバスに記録する。
  (canvas as { __ggBaseSize?: { width: number; height: number } }).__ggBaseSize = {
    width: imageWidth,
    height: imageHeight,
  };
  const width = canvas.getWidth?.() ?? 1;
  const height = canvas.getHeight?.() ?? 1;
  if (!imageWidth || !imageHeight || !width || !height) return;
  const zoom = Math.min((width - 80) / imageWidth, (height - 80) / imageHeight, 1);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = (width - imageWidth * safeZoom) / 2;
  const y = (height - imageHeight * safeZoom) / 2;
  canvas.setViewportTransform?.([safeZoom, 0, 0, safeZoom, x, y]);
}

/**
 * AI再生成の結果 (dataURL) で既存レイヤーを同位置に置き換える。
 * textSpec 等の引き継ぎプロパティは extraProps で渡す。
 */
export async function replaceLayerWithDataUrl(
  canvas: FabricCanvas,
  target: FabricObject,
  dataUrl: string,
  extraProps: Record<string, unknown> = {},
): Promise<FabricObject> {
  const fabric = await importFabric();
  const left = target.left ?? 0;
  const top = target.top ?? 0;
  const name = (target.get?.("name") as string) ?? "レイヤー";
  canvas.remove(target);
  const image = await loadFabricImageFromUrl(fabric, dataUrl);
  image.set({
    id: createLayerId(),
    name,
    layerKind: "image",
    left,
    top,
    selectable: true,
    ...extraProps,
  });
  canvas.add(image);
  canvas.setActiveObject?.(image);
  canvas.requestRenderAll?.();
  return image;
}

/** キャンバスに記録した元画像寸法 (無ければ null)。 */
export function getCanvasBaseSize(
  canvas: FabricCanvas,
): { width: number; height: number } | null {
  const size = (canvas as { __ggBaseSize?: { width: number; height: number } }).__ggBaseSize;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** ビューポート中心のシーン座標 (図形・画像の初期配置用)。 */
function sceneCenter(canvas: FabricCanvas): { x: number; y: number } {
  const vpt: number[] = (canvas as { viewportTransform?: number[] }).viewportTransform ?? [
    1, 0, 0, 1, 0, 0,
  ];
  const w = canvas.getWidth?.() ?? 800;
  const h = canvas.getHeight?.() ?? 600;
  const zoom = vpt[0] || 1;
  return { x: (w / 2 - vpt[4]) / zoom, y: (h / 2 - vpt[5]) / zoom };
}

export type ShapeKind = "rect" | "circle" | "line" | "arrow";

/** 図形をビューポート中心に追加する (基本の画像編集: 座布団・帯・線・矢印)。 */
export async function addShapeToCanvas(
  canvas: FabricCanvas,
  kind: ShapeKind,
  color: string,
): Promise<void> {
  const fabric = await importFabric();
  const center = sceneCenter(canvas);
  let object: FabricObject;
  let name = "図形";
  if (kind === "rect") {
    object = new fabric.Rect({ width: 260, height: 150, fill: color });
    name = "四角";
  } else if (kind === "circle") {
    object = new fabric.Circle({ radius: 90, fill: color });
    name = "丸";
  } else if (kind === "line") {
    object = new fabric.Line([0, 0, 260, 0], { stroke: color, strokeWidth: 6 });
    name = "線";
  } else {
    object = new fabric.Path("M 0 0 L 200 0 M 200 0 L 164 -22 M 200 0 L 164 22", {
      stroke: color,
      strokeWidth: 8,
      fill: "",
      strokeLineCap: "round",
    });
    name = "矢印";
  }
  object.set({
    id: createLayerId(),
    name,
    layerKind: "image",
    left: center.x - ((object.width ?? 100) * (object.scaleX ?? 1)) / 2,
    top: center.y - ((object.height ?? 100) * (object.scaleY ?? 1)) / 2,
    selectable: true,
  });
  canvas.add(object);
  canvas.setActiveObject?.(object);
  canvas.requestRenderAll?.();
}

/** キャンバスを元画像解像度の統合PNG (dataURL の base64 本体) に書き出す。 */
export function exportCanvasPngBase64(canvas: FabricCanvas): string | null {
  const base = getCanvasBaseSize(canvas);
  const vpt: number[] | undefined = (canvas as { viewportTransform?: number[] })
    .viewportTransform;
  const saved = vpt ? [...vpt] : null;
  try {
    canvas.discardActiveObject?.();
    canvas.setViewportTransform?.([1, 0, 0, 1, 0, 0]);
    const dataUrl: string | undefined = (canvas as {
      toDataURL?: (options?: Record<string, unknown>) => string;
    }).toDataURL?.({
      format: "png",
      left: 0,
      top: 0,
      width: base?.width ?? canvas.getWidth?.() ?? 0,
      height: base?.height ?? canvas.getHeight?.() ?? 0,
      multiplier: 1,
    });
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  } finally {
    if (saved) canvas.setViewportTransform?.(saved);
    canvas.requestRenderAll?.();
  }
}

async function importFabric(): Promise<FabricModule> {
  // @ts-ignore fabric is installed at runtime via package dependency
  return import("fabric") as Promise<FabricModule>;
}

async function loadFabricImage(fabric: FabricModule, path: string): Promise<FabricObject> {
  return loadFabricImageFromUrl(fabric, convertFileSrc(path));
}

async function loadFabricImageFromUrl(fabric: FabricModule, url: string): Promise<FabricObject> {
  const ImageClass = fabric.FabricImage ?? fabric.Image;
  if (!ImageClass?.fromURL) {
    throw new Error("Fabric.js Image.fromURL が見つかりません");
  }
  const loaded = ImageClass.fromURL(url, { crossOrigin: "anonymous" });
  return typeof loaded?.then === "function" ? await loaded : loaded;
}

function clearCanvas(canvas: FabricCanvas) {
  canvas.discardActiveObject?.();
  canvas.clear?.();
  canvas.setViewportTransform?.([1, 0, 0, 1, 0, 0]);
}
