/**
 * 完成ページの1枚画像書き出し（Canvas 手描画）。
 *
 * ## なぜ Canvas 手描画か（DOM キャプチャを使わない理由）
 *
 * html-to-image / html2canvas 等の DOM キャプチャは依存追加が必要で、Tauri の
 * WKWebView / WebView2 では SVG foreignObject のシリアライズと asset プロトコル画像の
 * 扱いが環境依存になる。一方 Canvas 合成は **この WebView で動作実証済み**:
 * `loadImage(convertFileSrc(path))` で読んだ画像を canvas に描き、
 * `canvas.toBlob` → `writeFile` で書き出せる。同じ経路をそのまま使う。
 *
 * ただし **画像の読み込みに `img.crossOrigin = "anonymous"` が必須**。asset:// は
 * cross-origin なので、CORS ロードでないと canvas が汚染され toBlob が
 * "The operation is insecure." で失敗する（registerCharacter.ts の toDataURL 実績と同方式）。
 *
 * ## 「見たとおりに出る」の担保
 *
 * 形（吹き出しの頂点・パディング・線幅）は balloonShapes.ts が単一の真実で、
 * 表示 SVG と本モジュールが同じ定数を読む。位置は **表示中の DOM の実測 rect** を
 * ページ div 相対で取り、EXPORT_SCALE 倍する。つまり自動配置でもドラッグ後でも、
 * 画面に出ている座標がそのまま拡大される。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import {
  BALLOON_PADDING,
  BALLOON_STROKE_PX,
  balloonPoints,
} from "./balloonShapes";
import {
  BALLOON_FONT_FAMILY,
  BALLOON_FONT_WEIGHT,
  SFX_FONT_FAMILY,
  SFX_LETTER_SPACING,
  SFX_STROKE_RATIO,
  sfxFontPx,
} from "./balloonLayout";
import type { ComicLayoutTemplate, ComicPanelSlot } from "./layoutTemplates";
import type {
  ComicBalloon,
  ComicPanel,
  ComicPanelResult,
  ComicSaveFormat,
  ComicSfx,
} from "./types";

/**
 * 書き出しの長辺（px）。B5 300dpi 相当以上の印刷品質。
 * 4096 超は WebView の canvas 上限リスクがあるため上げない。
 */
export const EXPORT_LONG_EDGE = 3200;

/** 未生成コマの塗り（表示の bg-neutral-200 と同値）。 */
const EMPTY_SLOT_FILL = "#e5e5e5";

/** 表示ページ幅 448px（max-w-md）での枠線 2px と同比率。 */
const FRAME_STROKE_BASE_PX = 2;
const FRAME_STROKE_BASE_WIDTH = 448;

/** 縦書きの列ピッチ（フォントサイズ倍率）。 */
const VERTICAL_LINE_PITCH = 1.4;

export type ExportComicPageResult = {
  blob: Blob;
  /** 画像を読み込めなかったコマ番号（空欄で描き進めた分）。 */
  failedPanels: number[];
};

export type ExportComicPageOptions = {
  /** スタジオの白地ページ div（オーバーレイ実測ジオメトリの正）。 */
  pageEl: HTMLElement;
  template: ComicLayoutTemplate;
  panels: ComicPanel[];
  results: ComicPanelResult[];
  /** 書き出し形式。既定 "png"。 */
  format?: ComicSaveFormat;
};

/** JPEG の再エンコード品質（設計値）。 */
const JPEG_QUALITY = 0.92;

/**
 * ページを1枚の Blob（PNG / JPEG）に合成する。
 *
 * 描画順はスロットごとに「画像 → 擬音 → 吹き出し」、最後にページ全体の枠線。
 * 読み順バッジ・選択リング・再生成ボタンは UI 専用なので描かない。
 */
export async function exportComicPage(
  opts: ExportComicPageOptions,
): Promise<ExportComicPageResult> {
  const { pageEl, template, panels, results, format = "png" } = opts;

  // フォントが未ロードだと fillText が代替フォントで描かれ、表示と字幅がずれる。
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }

  const { w: exportW, h: exportH } = exportPageSize(template);
  const displayW = pageEl.clientWidth || FRAME_STROKE_BASE_WIDTH;
  // 表示 px 定数（枠線・フォント・パディング）をこの倍率で拡大 = 見たままが大きくなる。
  const scale = exportW / displayW;

  const canvas = document.createElement("canvas");
  canvas.width = exportW;
  canvas.height = exportH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas を初期化できませんでした。");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, exportW, exportH);

  const pageRect = pageEl.getBoundingClientRect();
  const failedPanels: number[] = [];

  for (let i = 0; i < template.slots.length; i += 1) {
    const slot = template.slots[i];
    const panel = panels[i];
    const result = panel
      ? results.find((r) => r.index === panel.index)
      : undefined;
    const box = slotBox(slot, exportW, exportH);

    ctx.save();
    // 多角形コマは頂点でクリップし、長方形コマは bbox でクリップする。
    // どちらも「はみ出しを切る」意味は同じなので、以降の描画は分岐しない。
    clipToSlot(ctx, slot, exportW, exportH);

    if (result?.imagePath) {
      let img: HTMLImageElement | null = null;
      try {
        img = await loadImage(convertFileSrc(result.imagePath));
      } catch {
        img = null;
      }
      if (img) {
        drawImageCover(ctx, img, box);
      } else {
        // 読めなかったコマは未生成扱いで描き進め、呼び出し側へ番号を返す（黙って落とさない）。
        ctx.fillStyle = EMPTY_SLOT_FILL;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        if (panel) failedPanels.push(panel.index);
      }
    } else {
      ctx.fillStyle = EMPTY_SLOT_FILL;
      ctx.fillRect(box.x, box.y, box.w, box.h);
    }

    // 吹き出し・擬音はコマの中に描く（クリップ内 = 「セリフは内枠内」の文法）。
    // 擬音を先に描き、吹き出しを上に重ねる（表示の重なり順と同じ）。
    if (panel) {
      for (const sfx of panel.sfx) {
        drawSfx(ctx, { sfx, pageEl, pageRect, scale });
      }
      for (const balloon of panel.balloons) {
        drawBalloon(ctx, { balloon, pageEl, pageRect, scale });
      }
    }
    ctx.restore();
  }

  drawFrames(ctx, template, exportW, exportH);

  // canvas は冒頭で白塗り済みのため JPEG でも透過部分が黒くならない。
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      format === "jpeg" ? "image/jpeg" : "image/png",
      format === "jpeg" ? JPEG_QUALITY : undefined,
    ),
  );
  if (!blob) throw new Error("Canvas の書き出しに失敗しました。");
  return { blob, failedPanels };
}

/** 長辺 3200px からページの実ピクセルサイズを出す。 */
export function exportPageSize(template: ComicLayoutTemplate): {
  w: number;
  h: number;
} {
  const { w: aw, h: ah } = template.pageAspect;
  if (aw >= ah) {
    return { w: EXPORT_LONG_EDGE, h: Math.round((EXPORT_LONG_EDGE * ah) / aw) };
  }
  return { w: Math.round((EXPORT_LONG_EDGE * aw) / ah), h: EXPORT_LONG_EDGE };
}

/** スロットの bbox を書き出し px へ変換する。 */
function slotBox(slot: ComicPanelSlot, exportW: number, exportH: number) {
  return {
    x: (slot.x / 100) * exportW,
    y: (slot.y / 100) * exportH,
    w: (slot.w / 100) * exportW,
    h: (slot.h / 100) * exportH,
  };
}

/**
 * スロット形状でクリップする。
 * points があれば多角形（ページ percent の頂点をそのまま px へ）、無ければ bbox 長方形。
 */
function clipToSlot(
  ctx: CanvasRenderingContext2D,
  slot: ComicPanelSlot,
  exportW: number,
  exportH: number,
) {
  ctx.beginPath();
  if (slot.points) {
    slot.points.forEach(([px, py], idx) => {
      const x = (px / 100) * exportW;
      const y = (py / 100) * exportH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  } else {
    const box = slotBox(slot, exportW, exportH);
    ctx.rect(box.x, box.y, box.w, box.h);
  }
  ctx.clip();
}

/** CSS の object-cover と同じ数式で中央クロップして描く。 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  box: { x: number; y: number; w: number; h: number },
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw <= 0 || ih <= 0) return;
  const s = Math.max(box.w / iw, box.h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
}

/**
 * 吹き出し1個を描く。
 *
 * 位置・サイズは表示中の DOM（`[data-balloon-id]`）の実測 rect をページ相対で取り、
 * scale 倍する。DOM に無い（visible: false / 空テキスト）ものは描かない。
 */
function drawBalloon(
  ctx: CanvasRenderingContext2D,
  args: {
    balloon: ComicBalloon;
    pageEl: HTMLElement;
    pageRect: DOMRect;
    scale: number;
  },
) {
  const { balloon, pageEl, pageRect, scale } = args;
  const el = pageEl.querySelector<HTMLElement>(
    `[data-balloon-id="${cssEscape(balloon.id)}"]`,
  );
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const x = (rect.left - pageRect.left) * scale;
  const y = (rect.top - pageRect.top) * scale;
  const w = rect.width * scale;
  const h = rect.height * scale;

  // 背景シェイプ: 表示 SVG と同じ頂点（viewBox 0-100）を rect へ引き伸ばす。
  const points = balloonPoints(balloon.kind);
  ctx.save();
  ctx.beginPath();
  if (points) {
    points.forEach(([px, py], idx) => {
      const cx = x + (px / 100) * w;
      const cy = y + (py / 100) * h;
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.closePath();
  } else {
    // normal は楕円（<ellipse cx=50 cy=50 rx=49 ry=49> と同値）。
    ctx.ellipse(x + w / 2, y + h / 2, (w * 49) / 100, (h * 49) / 100, 0, 0, Math.PI * 2);
  }
  // 書き出しは不透明（表示の /95 は画面確認用）。
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = BALLOON_STROKE_PX * scale;
  ctx.stroke();
  ctx.restore();

  drawVerticalText(ctx, {
    text: balloon.text,
    kind: balloon.kind,
    box: { x, y, w, h },
    // 表示の実効フォントサイズ（balloonFontSize が付けた値）を実測して使う。
    fontPx: readFontSizePx(el) * scale,
    scale,
  });
}

/**
 * 擬音1個を描く。
 *
 * 位置は表示中の DOM（`[data-sfx-id]`）の実測 rect の **中心** を使う。
 * 要素には rotate が掛かっており getBoundingClientRect は回転後の外接矩形を返すため、
 * 幅・高さをそのまま使うと二重に傾いた分だけ太る。中心は回転で不変なので中心だけ借り、
 * 文字サイズ・字間・縁の太さは表示と同じ balloonLayout.ts の定数から導く
 * （= 表示 SVG と同じ材料。見たとおりの大きさで出る）。
 */
function drawSfx(
  ctx: CanvasRenderingContext2D,
  args: {
    sfx: ComicSfx;
    pageEl: HTMLElement;
    pageRect: DOMRect;
    scale: number;
  },
) {
  const { sfx, pageEl, pageRect, scale } = args;
  const body = sfx.text.trim();
  if (!body) return;

  const el = pageEl.querySelector<HTMLElement>(
    `[data-sfx-id="${cssEscape(sfx.id)}"]`,
  );
  if (!el) return; // visible: false / 空テキストは DOM に無い＝描かない
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  // 回転で動かない点＝中心。ここを基準に translate → rotate する。
  const cx = (rect.left + rect.width / 2 - pageRect.left) * scale;
  const cy = (rect.top + rect.height / 2 - pageRect.top) * scale;
  const fontPx = sfxFontPx(sfx.text, sfx.scale) * scale;
  const spacing = fontPx * SFX_LETTER_SPACING[sfx.intent];

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((sfx.rotation * Math.PI) / 180);
  ctx.font = `900 ${fontPx}px ${SFX_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = fontPx * SFX_STROKE_RATIO;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#ffffff";

  // Canvas の letterSpacing は WebView 差があるため、1文字ずつ手で送る。
  const chars = [...body];
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total =
    widths.reduce((sum, w) => sum + w, 0) + spacing * Math.max(0, chars.length - 1);
  let x = -total / 2;
  for (let i = 0; i < chars.length; i += 1) {
    const center = x + widths[i] / 2;
    // 縁 → 塗りの順で描くのが paint-order: stroke と同じ見え方（縁が内側へ食い込まない）。
    ctx.strokeText(chars[i], center, 0);
    ctx.fillText(chars[i], center, 0);
    x += widths[i] + spacing;
  }
  ctx.restore();
}

/**
 * 縦書きテキストを手組みする（CSS writing-mode は canvas に無い）。
 *
 * `\n` で列を区切り、列内は上→下へ1文字ずつ、列は右→左へ進む
 * （日本語縦書きの読み方向）。字送り・約物の見た目は CSS プレビューと完全一致しない
 * （書き出しが成果物の正・プレビューは目安）。
 */
function drawVerticalText(
  ctx: CanvasRenderingContext2D,
  args: {
    text: string;
    kind: ComicBalloon["kind"];
    box: { x: number; y: number; w: number; h: number };
    fontPx: number;
    scale: number;
  },
) {
  const { text, kind, box, fontPx } = args;
  const body = text.trim();
  if (!body || fontPx <= 0) return;

  const pad = BALLOON_PADDING[kind];
  const padX = pad.x * args.scale;
  const padY = pad.y * args.scale;
  const innerX = box.x + padX;
  const innerY = box.y + padY;
  const innerW = Math.max(0, box.w - padX * 2);
  const innerH = Math.max(0, box.h - padY * 2);
  if (innerW <= 0 || innerH <= 0) return;

  // 1列に入る文字数（CSS の overflow-hidden と同じく、入らない分は溢れさせない）。
  const perColumn = Math.max(1, Math.floor(innerH / fontPx));
  const pitch = fontPx * VERTICAL_LINE_PITCH;

  // 明示改行で列を割り、さらに列の高さで折り返す。
  const columns: string[] = [];
  for (const line of body.split("\n")) {
    const chars = [...line];
    if (chars.length === 0) {
      columns.push("");
      continue;
    }
    for (let i = 0; i < chars.length; i += perColumn) {
      columns.push(chars.slice(i, i + perColumn).join(""));
    }
  }

  ctx.save();
  ctx.font = `${BALLOON_FONT_WEIGHT[kind]} ${fontPx}px ${BALLOON_FONT_FAMILY}`;
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // 列は右から左へ。1列目の中心を右端から半ピッチ内側に置く。
  const rightEdge = innerX + innerW;
  for (let c = 0; c < columns.length; c += 1) {
    const cx = rightEdge - pitch * (c + 0.5);
    if (cx < innerX - pitch) break; // 左へ溢れた列は描かない（overflow-hidden 相当）
    const chars = [...columns[c]];
    for (let r = 0; r < chars.length; r += 1) {
      ctx.fillText(chars[r], cx, innerY + r * fontPx);
    }
  }
  ctx.restore();
}

/** コマの黒枠線。多角形は頂点の Path、長方形は strokeRect。 */
function drawFrames(
  ctx: CanvasRenderingContext2D,
  template: ComicLayoutTemplate,
  exportW: number,
  exportH: number,
) {
  const lineWidth = Math.max(
    2,
    Math.round((exportW * FRAME_STROKE_BASE_PX) / FRAME_STROKE_BASE_WIDTH),
  );
  ctx.save();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "miter";
  for (const slot of template.slots) {
    ctx.beginPath();
    if (slot.points) {
      slot.points.forEach(([px, py], idx) => {
        const x = (px / 100) * exportW;
        const y = (py / 100) * exportH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    } else {
      const box = slotBox(slot, exportW, exportH);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
  }
  ctx.restore();
}

/** 表示中の要素の実効フォントサイズ px（balloonFontSize の結果を実測で拾う）。 */
function readFontSizePx(balloonEl: HTMLElement): number {
  // テキスト層は SVG の次の子（BalloonView の構造）。無ければ親から読む。
  const textEl = balloonEl.querySelector<HTMLElement>(":scope > div") ?? balloonEl;
  const px = Number.parseFloat(window.getComputedStyle(textEl).fontSize);
  return Number.isFinite(px) && px > 0 ? px : 12;
}

/** querySelector の属性値に使うためのエスケープ（UUID 以外が来ても壊れないように）。 */
function cssEscape(value: string): string {
  const escaper = (window as unknown as { CSS?: { escape?: (v: string) => string } })
    .CSS?.escape;
  return escaper ? escaper(value) : value.replace(/["\\]/g, "\\$&");
}

/** 画像を1枚読む（LayerComposer と同じ実装）。 */
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // asset:// は cross-origin。crossOrigin を付けた CORS ロードでないと canvas が
    // 汚染され toBlob が "The operation is insecure." で死ぬ（Tauri asset protocol は
    // CORS ヘッダを返すため anonymous で成立。registerCharacter.ts の toDataURL 実績と同方式）。
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${src}`));
    img.src = src;
  });
}
