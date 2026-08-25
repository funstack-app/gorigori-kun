import { useEffect, useRef, useState } from "react";

import {
  readBaseSize,
  readViewport,
  type NormalizedBbox,
} from "./RegionSelectOverlay";

/**
 * リサイズツール用の「掴める外枠」(2026-08-26 STΛCK実機FB・Magnific 準拠)。
 *
 * - 切り抜き: 画像の内側に枠。四隅ブラケット/辺バーを掴んでリサイズ、
 *   中を掴んで移動。比率選択中はアスペクト固定。
 * - 画像拡張: 画像を含む外側に枠。掴んで広げると、その形に最も近い
 *   Magnific 対応比率へスナップし、選択中の比率チップも連動する
 *   (API は比率しか受けないため、枠は「何が生成されるか」を正確に見せる)。
 *
 * 枠と持ち手だけ pointer-events を持ち、外側は透過させる = 空きスペースの
 * 手のひらパンを殺さない。
 */

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type ScreenRect = { left: number; top: number; width: number; height: number };

type CropFrameOverlayProps = {
  canvas: unknown;
  mode: "crop" | "expand";
  /** 切り抜きの確定枠 (正規化)。expand では無視される。 */
  value: NormalizedBbox | null;
  onChange: (bbox: NormalizedBbox) => void;
  /** 切り抜きのアスペクト固定 (横÷縦)。null で自由。 */
  aspectRatio?: number | null;
  /** expand: 現在選択中の比率 (横÷縦) と、スナップ時の通知。 */
  expandAspect?: number;
  onExpandAspectSnap?: (ratio: number) => void;
  /** expand: スナップ候補の比率一覧 (横÷縦)。 */
  expandAspectChoices?: number[];
  disabled?: boolean;
};

function imageScreenRect(canvas: unknown): ScreenRect | null {
  const base = readBaseSize(canvas);
  if (!base) return null;
  const { zoom, offsetX, offsetY } = readViewport(canvas);
  return {
    left: offsetX,
    top: offsetY,
    width: base.width * zoom,
    height: base.height * zoom,
  };
}

function screenToNormalized(rect: ScreenRect, canvas: unknown): NormalizedBbox | null {
  const base = readBaseSize(canvas);
  if (!base) return null;
  const { zoom, offsetX, offsetY } = readViewport(canvas);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp01((rect.left - offsetX) / zoom / base.width);
  const y0 = clamp01((rect.top - offsetY) / zoom / base.height);
  const x1 = clamp01((rect.left + rect.width - offsetX) / zoom / base.width);
  const y1 = clamp01((rect.top + rect.height - offsetY) / zoom / base.height);
  return [x0, y0, Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0)];
}

function normalizedToScreen(bbox: NormalizedBbox, canvas: unknown): ScreenRect | null {
  const base = readBaseSize(canvas);
  if (!base) return null;
  const { zoom, offsetX, offsetY } = readViewport(canvas);
  return {
    left: bbox[0] * base.width * zoom + offsetX,
    top: bbox[1] * base.height * zoom + offsetY,
    width: bbox[2] * base.width * zoom,
    height: bbox[3] * base.height * zoom,
  };
}

/** 画像を丸ごと含む、比率 ratio の最小矩形 (中央寄せ)。expand の枠。 */
function containingRectForAspect(image: ScreenRect, ratio: number): ScreenRect {
  const imageRatio = image.width / image.height;
  let width: number;
  let height: number;
  if (ratio >= imageRatio) {
    height = image.height;
    width = height * ratio;
  } else {
    width = image.width;
    height = width / ratio;
  }
  return {
    left: image.left + (image.width - width) / 2,
    top: image.top + (image.height - height) / 2,
    width,
    height,
  };
}

const MIN_SIZE = 24;

/** 持ち手ドラッグ後の矩形。アスペクト固定時は反対側を支点に比率を守る。 */
function resizeRect(
  start: ScreenRect,
  handle: Handle,
  dx: number,
  dy: number,
  aspect: number | null,
): ScreenRect {
  let { left, top, width, height } = start;
  const right = left + width;
  const bottom = top + height;

  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  if (east) width = Math.max(MIN_SIZE, width + dx);
  if (west) {
    width = Math.max(MIN_SIZE, width - dx);
    left = right - width;
  }
  if (south) height = Math.max(MIN_SIZE, height + dy);
  if (north) {
    height = Math.max(MIN_SIZE, height - dy);
    top = bottom - height;
  }

  if (aspect && Number.isFinite(aspect) && aspect > 0) {
    const horizontalOnly = (east || west) && !(north || south);
    const verticalOnly = (north || south) && !(east || west);
    if (horizontalOnly) {
      const newHeight = width / aspect;
      top += (height - newHeight) / 2;
      height = newHeight;
    } else if (verticalOnly) {
      const newWidth = height * aspect;
      left += (width - newWidth) / 2;
      width = newWidth;
    } else {
      // 角: ドラッグ量の大きい軸を主にして比率を合わせる。支点は反対側の角。
      if (Math.abs(dx) >= Math.abs(dy)) height = width / aspect;
      else width = height * aspect;
      if (west) left = right - width;
      if (north) top = bottom - height;
    }
  }
  return { left, top, width, height };
}

/** 矩形を境界内へ押し込む (サイズは維持し、はみ出しは縮める)。 */
function clampRectInto(rect: ScreenRect, bounds: ScreenRect): ScreenRect {
  let { left, top, width, height } = rect;
  width = Math.min(width, bounds.width);
  height = Math.min(height, bounds.height);
  left = Math.min(Math.max(left, bounds.left), bounds.left + bounds.width - width);
  top = Math.min(Math.max(top, bounds.top), bounds.top + bounds.height - height);
  return { left, top, width, height };
}

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  w: "ew-resize",
  e: "ew-resize",
};

export function CropFrameOverlay({
  canvas,
  mode,
  value,
  onChange,
  aspectRatio = null,
  expandAspect = 16 / 9,
  onExpandAspectSnap,
  expandAspectChoices = [],
  disabled,
}: CropFrameOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    handle: Handle | "move";
    startX: number;
    startY: number;
    startRect: ScreenRect;
  } | null>(null);
  const [liveRect, setLiveRect] = useState<ScreenRect | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  void tick;

  const image = imageScreenRect(canvas);
  if (!image) return null;

  const committed =
    mode === "expand"
      ? containingRectForAspect(image, expandAspect)
      : value
        ? normalizedToScreen(value, canvas)
        : image;
  const rect = liveRect ?? committed;
  if (!rect) return null;

  const beginDrag = (handle: Handle | "move") => (event: React.PointerEvent) => {
    if (disabled) return;
    if (event.button !== 0) return;
    if (mode === "expand" && handle === "move") return; // 拡張は中央固定 (API仕様)
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startRect: rect,
    };
    setLiveRect(rect);
  };

  const moveDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    let next: ScreenRect;
    if (drag.handle === "move") {
      next = clampRectInto(
        { ...drag.startRect, left: drag.startRect.left + dx, top: drag.startRect.top + dy },
        image,
      );
    } else if (mode === "crop") {
      next = clampRectInto(resizeRect(drag.startRect, drag.handle, dx, dy, aspectRatio), image);
    } else {
      // 拡張: 枠は自由に伸ばして見せ、離した時に対応比率へスナップする。
      const stretched = resizeRect(drag.startRect, drag.handle, dx, dy, null);
      // 画像より小さくはしない (拡張枠は常に画像を含む)。
      const minRect = containingRectForAspect(image, stretched.width / stretched.height);
      next = minRect.width >= image.width && minRect.height >= image.height ? minRect : image;
    }
    setLiveRect(next);
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const finalRect = liveRect ?? drag.startRect;
    setLiveRect(null);
    if ((event.currentTarget as Element).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    }
    if (mode === "crop") {
      const normalized = screenToNormalized(finalRect, canvas);
      if (normalized) onChange(normalized);
      return;
    }
    // 拡張: 最も近い対応比率へスナップして親のチップ選択を連動させる。
    if (!onExpandAspectSnap || expandAspectChoices.length === 0) return;
    const dragged = finalRect.width / finalRect.height;
    let best = expandAspectChoices[0];
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const choice of expandAspectChoices) {
      const diff = Math.abs(Math.log(dragged / choice));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = choice;
      }
    }
    onExpandAspectSnap(best);
  };

  // Magnific と同じ見た目: 白い四隅ブラケット + 白い辺バーのみ。色付きの塗り・
  // 枠線は使わない (2026-08-26 STΛCK実機FB: ピンクの塗りが画像に被って見えた)。
  const bracket = "absolute h-5 w-5 border-white drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]";
  const bar =
    "absolute rounded-full bg-white shadow-[0_0_2px_rgba(0,0,0,0.9)]";
  const hit = disabled ? "pointer-events-none" : "pointer-events-auto";
  const frameHole = `polygon(0% 0%, 0% 100%, ${rect.left}px 100%, ${rect.left}px ${rect.top}px, ${rect.left + rect.width}px ${rect.top}px, ${rect.left + rect.width}px ${rect.top + rect.height}px, ${rect.left}px ${rect.top + rect.height}px, ${rect.left}px 100%, 100% 100%, 100% 0%)`;

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-10" role="presentation">
      {mode === "crop" ? (
        // 枠の外 = 切り落とされる範囲。暗くして「残る範囲」を見せる。
        <div
          className="pointer-events-none absolute inset-0 bg-black/45"
          style={{ clipPath: frameHole }}
        />
      ) : (
        // 拡張: 画像と枠の間 = これから生成される領域。画像には一切色を被せず、
        // 枠内から画像を抜いた部分だけをごく薄く見せる。
        <div
          className="pointer-events-none absolute bg-white/[0.06]"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            clipPath: `polygon(0% 0%, 0% 100%, ${image.left - rect.left}px 100%, ${image.left - rect.left}px ${image.top - rect.top}px, ${image.left - rect.left + image.width}px ${image.top - rect.top}px, ${image.left - rect.left + image.width}px ${image.top - rect.top + image.height}px, ${image.left - rect.left}px ${image.top - rect.top + image.height}px, ${image.left - rect.left}px 100%, 100% 100%, 100% 0%)`,
          }}
        />
      )}

      {/* 枠本体 (掴んで移動・切り抜きのみ)。線は引かず、境界は暗転とブラケットで見せる。 */}
      <div
        data-editor-overlay-grab
        onPointerDown={beginDrag("move")}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`absolute ${mode === "crop" ? `${hit} cursor-move` : "pointer-events-none"} border border-white/25`}
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }}
      />

      {/* 四隅ブラケット + 辺バー (Magnific と同じ白の持ち手)。 */}
      {(
        [
          ["nw", { left: rect.left - 4, top: rect.top - 4 }, `${bracket} border-l-[3px] border-t-[3px]`],
          ["ne", { left: rect.left + rect.width - 16, top: rect.top - 4 }, `${bracket} border-r-[3px] border-t-[3px]`],
          ["sw", { left: rect.left - 4, top: rect.top + rect.height - 16 }, `${bracket} border-b-[3px] border-l-[3px]`],
          ["se", { left: rect.left + rect.width - 16, top: rect.top + rect.height - 16 }, `${bracket} border-b-[3px] border-r-[3px]`],
          ["n", { left: rect.left + rect.width / 2 - 14, top: rect.top - 2, width: 28, height: 4 }, bar],
          ["s", { left: rect.left + rect.width / 2 - 14, top: rect.top + rect.height - 2, width: 28, height: 4 }, bar],
          ["w", { left: rect.left - 2, top: rect.top + rect.height / 2 - 14, width: 4, height: 28 }, bar],
          ["e", { left: rect.left + rect.width - 2, top: rect.top + rect.height / 2 - 14, width: 4, height: 28 }, bar],
        ] as const
      ).map(([handle, style, className]) => (
        <div
          key={handle}
          data-editor-overlay-grab
          onPointerDown={beginDrag(handle)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={`${className} ${hit}`}
          style={{ ...style, cursor: HANDLE_CURSOR[handle], touchAction: "none" }}
          role="presentation"
        >
          {/* 当たり判定を広げる透明ゾーン (細い持ち手は掴みにくい)。 */}
          <span className="absolute -inset-2" />
        </div>
      ))}
    </div>
  );
}

export default CropFrameOverlay;
