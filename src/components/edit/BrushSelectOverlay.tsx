import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { readBaseSize, readViewport } from "./RegionSelectOverlay";

export type BrushSelectOverlayHandle = {
  /** 現在、白い塗りが1pxでも残っているか。 */
  readonly hasStrokes: boolean;
  /** 画像実寸の白黒マスク PNG。塗りが無ければ null。 */
  getMaskDataUrl: () => string | null;
  /** 塗りをすべて消す。 */
  clear: () => void;
};

type Props = {
  /** fabric.Canvas。viewportTransform と __ggBaseSize を読むだけで変更しない。 */
  canvas: unknown;
  /** 画面上で見えるブラシの直径 (px)。 */
  brushSize: number;
  erasing: boolean;
  disabled?: boolean;
  onHasStrokesChange?: (hasStrokes: boolean) => void;
};

type Point = { x: number; y: number };

/** 画面上のローカル座標を、元画像の実寸座標へ戻す。 */
export function brushScreenPointToImagePoint(
  point: Point,
  viewport: { zoom: number; offsetX: number; offsetY: number },
): Point {
  return {
    x: (point.x - viewport.offsetX) / viewport.zoom,
    y: (point.y - viewport.offsetY) / viewport.zoom,
  };
}

/** 「画面 px」指定のブラシ径を、現在倍率での画像実寸へ戻す。 */
export function brushScreenSizeToImageSize(screenSize: number, zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(1, screenSize / safeZoom);
}

function maskContainsPaint(mask: HTMLCanvasElement): boolean {
  const context = mask.getContext("2d", { willReadFrequently: true });
  if (!context) return false;
  const pixels = context.getImageData(0, 0, mask.width, mask.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) return true;
  }
  return false;
}

/**
 * 画像へ焼き込まれない「塗って選ぶ」オーバーレイ。
 *
 * 塗り本体は元画像と同じ大きさの透明 canvas に白で保持する。表示用 canvas は
 * requestAnimationFrame ごとに viewport を読み直すため、ズームやパンの後も画像と
 * 同じ位置へ戻る。実行時だけ黒背景へ合成し、白=変更・黒=維持の PNG を返す。
 */
export const BrushSelectOverlay = forwardRef<BrushSelectOverlayHandle, Props>(
  function BrushSelectOverlay(
    { canvas, brushSize, erasing, disabled, onHasStrokesChange },
    forwardedRef,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef<HTMLCanvasElement | null>(null);
    const lastPointRef = useRef<Point | null>(null);
    const activePointerRef = useRef<number | null>(null);
    const hasStrokesRef = useRef(false);
    const paintRevisionRef = useRef(0);
    const lastPreviewSignatureRef = useRef("");
    const [cursorPoint, setCursorPoint] = useState<Point | null>(null);
    const [hasStrokes, setHasStrokes] = useState(false);

    const base = readBaseSize(canvas);
    const baseWidth = base ? Math.max(1, Math.round(base.width)) : 0;
    const baseHeight = base ? Math.max(1, Math.round(base.height)) : 0;
    const ready = baseWidth > 0 && baseHeight > 0 && !disabled;

    const updateHasStrokes = useCallback(
      (next: boolean, notifyEvenIfUnchanged = false) => {
        const changed = hasStrokesRef.current !== next;
        hasStrokesRef.current = next;
        if (changed) setHasStrokes(next);
        if (changed || notifyEvenIfUnchanged) onHasStrokesChange?.(next);
      },
      [onHasStrokesChange],
    );

    const ensureMask = useCallback((): HTMLCanvasElement | null => {
      if (baseWidth <= 0 || baseHeight <= 0) return null;
      const current = maskRef.current;
      if (current && current.width === baseWidth && current.height === baseHeight) {
        return current;
      }
      const next = document.createElement("canvas");
      next.width = baseWidth;
      next.height = baseHeight;
      maskRef.current = next;
      paintRevisionRef.current += 1;
      lastPreviewSignatureRef.current = "";
      updateHasStrokes(false, true);
      return next;
    }, [baseHeight, baseWidth, updateHasStrokes]);

    const clear = useCallback(() => {
      const mask = ensureMask();
      const context = mask?.getContext("2d");
      if (mask && context) context.clearRect(0, 0, mask.width, mask.height);
      paintRevisionRef.current += 1;
      lastPreviewSignatureRef.current = "";
      updateHasStrokes(false);
    }, [ensureMask, updateHasStrokes]);

    const getMaskDataUrl = useCallback((): string | null => {
      const mask = ensureMask();
      if (!mask || !hasStrokesRef.current) return null;
      const output = document.createElement("canvas");
      output.width = mask.width;
      output.height = mask.height;
      const context = output.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#000";
      context.fillRect(0, 0, output.width, output.height);
      context.drawImage(mask, 0, 0);
      return output.toDataURL("image/png");
    }, [ensureMask]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        get hasStrokes() {
          return hasStrokesRef.current;
        },
        getMaskDataUrl,
        clear,
      }),
      [clear, getMaskDataUrl],
    );

    // 元画像の寸法が決まった時点で実寸マスクを用意する。別画像・別寸法なら白紙に戻す。
    useEffect(() => {
      ensureMask();
    }, [ensureMask]);

    const renderPreview = useCallback(() => {
      const host = hostRef.current;
      const preview = previewRef.current;
      const mask = maskRef.current;
      if (!host || !preview || !mask) return;

      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const { zoom, offsetX, offsetY } = readViewport(canvas);
      const signature = [
        width,
        height,
        dpr,
        zoom,
        offsetX,
        offsetY,
        paintRevisionRef.current,
      ].join(":");
      if (lastPreviewSignatureRef.current === signature) return;
      lastPreviewSignatureRef.current = signature;

      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (preview.width !== pixelWidth || preview.height !== pixelHeight) {
        preview.width = pixelWidth;
        preview.height = pixelHeight;
      }
      const context = preview.getContext("2d");
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, preview.width, preview.height);
      context.save();
      context.setTransform(
        dpr * zoom,
        0,
        0,
        dpr * zoom,
        dpr * offsetX,
        dpr * offsetY,
      );
      context.drawImage(mask, 0, 0);
      context.globalCompositeOperation = "source-in";
      context.fillStyle = "rgba(244, 114, 182, 0.48)";
      context.fillRect(0, 0, mask.width, mask.height);
      context.restore();
    }, [canvas]);

    useEffect(() => {
      let frame = 0;
      const tick = () => {
        renderPreview();
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
      return () => window.cancelAnimationFrame(frame);
    }, [renderPreview]);

    const localPoint = (event: React.PointerEvent<HTMLDivElement>): Point | null => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const drawSegment = (from: Point, to: Point) => {
      const mask = ensureMask();
      const context = mask?.getContext("2d");
      if (!mask || !context) return;
      const viewport = readViewport(canvas);
      const imageFrom = brushScreenPointToImagePoint(from, viewport);
      const imageTo = brushScreenPointToImagePoint(to, viewport);
      const diameter = brushScreenSizeToImageSize(brushSize, viewport.zoom);

      context.save();
      context.globalCompositeOperation = erasing ? "destination-out" : "source-over";
      context.strokeStyle = "#fff";
      context.fillStyle = "#fff";
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = diameter;
      const distance = Math.hypot(imageTo.x - imageFrom.x, imageTo.y - imageFrom.y);
      if (distance < 0.01) {
        context.beginPath();
        context.arc(imageTo.x, imageTo.y, diameter / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(imageFrom.x, imageFrom.y);
        context.lineTo(imageTo.x, imageTo.y);
        context.stroke();
      }
      context.restore();

      if (!erasing) updateHasStrokes(true);
      paintRevisionRef.current += 1;
      lastPreviewSignatureRef.current = "";
      renderPreview();
    };

    const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!ready || event.button !== 0) return;
      const point = localPoint(event);
      if (!point) return;
      activePointerRef.current = event.pointerId;
      lastPointRef.current = point;
      setCursorPoint(point);
      event.currentTarget.setPointerCapture(event.pointerId);
      drawSegment(point, point);
      event.preventDefault();
    };

    const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const point = localPoint(event);
      if (!point) return;
      setCursorPoint(point);
      if (activePointerRef.current !== event.pointerId || !lastPointRef.current) return;
      drawSegment(lastPointRef.current, point);
      lastPointRef.current = point;
      event.preventDefault();
    };

    const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      activePointerRef.current = null;
      lastPointRef.current = null;
      // 画像外だけを塗った場合や、消しゴムで全部消した場合も正しく未選択へ戻す。
      const mask = maskRef.current;
      updateHasStrokes(Boolean(mask && maskContainsPaint(mask)));
      event.preventDefault();
    };

    return (
      <div
        ref={hostRef}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onPointerEnter={(event) => {
          const point = localPoint(event);
          if (point) setCursorPoint(point);
        }}
        onPointerLeave={() => {
          if (activePointerRef.current === null) setCursorPoint(null);
        }}
        className={`absolute inset-0 z-10 ${ready ? "cursor-none" : "pointer-events-none"}`}
        style={{ touchAction: "none" }}
        role="presentation"
      >
        <canvas ref={previewRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        {ready && cursorPoint ? (
          <span
            className={`pointer-events-none absolute rounded-full border ${
              erasing
                ? "border-white/90 bg-black/20"
                : "border-pink-200 bg-pink-400/15"
            } shadow-[0_0_0_1px_rgba(0,0,0,0.55)]`}
            style={{
              left: cursorPoint.x - brushSize / 2,
              top: cursorPoint.y - brushSize / 2,
              width: brushSize,
              height: brushSize,
            }}
          />
        ) : null}
        {ready && !hasStrokes ? (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-pink-400/60 bg-[#101010]/95 px-3 py-1.5 text-[11px] font-bold text-pink-100 shadow-xl">
            直したいところをブラシで塗る
          </div>
        ) : null}
      </div>
    );
  },
);

export default BrushSelectOverlay;
