import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type MaskMode = "paint" | "erase";

export type MaskCanvasHandle = {
  /** Snapshot the mask layer as a PNG blob (white-on-transparent). */
  toBlob: () => Promise<Blob>;
  undo: () => void;
  clear: () => void;
  /** True when there is at least one stroke that can be undone. */
  canUndo: () => boolean;
};

type Props = {
  /** Source image URL (already converted via convertFileSrc). */
  src: string;
  brushSize: number;
  mode: MaskMode;
  /** 0..1 visual overlay opacity (does NOT affect exported mask). */
  opacity: number;
  /** Notified after each stroke ends + after clear/undo so the toolbar can refresh. */
  onChange?: () => void;
};

const UNDO_STACK_LIMIT = 20;

/**
 * Two-canvas painter: a static background layer renders the source image,
 * and an overlay layer holds the mask strokes. Strokes are drawn at the
 * source image's intrinsic resolution so the exported PNG always matches
 * the original dimensions exactly — required for inpainting semantics.
 */
export const MaskCanvas = forwardRef<MaskCanvasHandle, Props>(function MaskCanvas(
  { src, brushSize, mode, opacity, onChange },
  ref,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const undoStack = useRef<ImageData[]>([]);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const imgSize = loadedImage
    ? {
        w: loadedImage.naturalWidth || loadedImage.width,
        h: loadedImage.naturalHeight || loadedImage.height,
      }
    : null;
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const isDrawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  // Track wrapper size — needed because aspect-ratio + max-* alone won't size
  // the inner element when both axes can flex. We compute the fitted display
  // box in JS (object-fit: contain semantics) and pin the canvases to it.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Stage 1: load the source image into memory. We don't touch the canvas
  // here because the canvas may not be mounted yet (we gate it on
  // imgSize + containerSize) — that's stage 2.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setLoadedImage(img);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Stage 2: once both the image and the canvas refs are alive, paint
  // the background and reset the mask. Re-runs if the image swaps; the
  // canvas refs themselves are stable while the modal is open.
  useEffect(() => {
    if (!loadedImage) return;
    const bg = bgRef.current;
    const mask = maskRef.current;
    if (!bg || !mask) return;
    const w = loadedImage.naturalWidth || loadedImage.width;
    const h = loadedImage.naturalHeight || loadedImage.height;
    bg.width = mask.width = w;
    bg.height = mask.height = h;
    bg.getContext("2d")?.drawImage(loadedImage, 0, 0, w, h);
    mask.getContext("2d")?.clearRect(0, 0, w, h);
    undoStack.current = [];
    onChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedImage, containerSize.w, containerSize.h]);

  const ctx = () => maskRef.current?.getContext("2d") ?? null;

  const pushHistory = () => {
    const c = maskRef.current;
    const g = ctx();
    if (!c || !g) return;
    const snap = g.getImageData(0, 0, c.width, c.height);
    undoStack.current.push(snap);
    if (undoStack.current.length > UNDO_STACK_LIMIT) {
      undoStack.current.shift();
    }
  };

  const eventToCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = maskRef.current;
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    const sx = c.width / rect.width;
    const sy = c.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  };

  const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = ctx();
    if (!g) return;
    pushHistory();
    isDrawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = eventToCanvas(e);
    if (!p) return;
    last.current = p;
    g.globalCompositeOperation =
      mode === "erase" ? "destination-out" : "source-over";
    g.fillStyle = "rgba(255,255,255,1)";
    g.beginPath();
    g.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
    g.fill();
  };

  const moveStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    const g = ctx();
    if (!g || !last.current) return;
    const p = eventToCanvas(e);
    if (!p) return;
    g.globalCompositeOperation =
      mode === "erase" ? "destination-out" : "source-over";
    g.strokeStyle = "rgba(255,255,255,1)";
    g.lineWidth = brushSize;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    last.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may have been auto-released already */
    }
    onChange?.();
  };

  useImperativeHandle(ref, () => ({
    toBlob: async () => {
      const c = maskRef.current;
      if (!c) throw new Error("mask canvas not mounted");
      return await new Promise<Blob>((resolve, reject) => {
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
          "image/png",
        );
      });
    },
    undo: () => {
      const g = ctx();
      const snap = undoStack.current.pop();
      if (!g || !snap) return;
      g.putImageData(snap, 0, 0);
      onChange?.();
    },
    clear: () => {
      const c = maskRef.current;
      const g = ctx();
      if (!c || !g) return;
      pushHistory();
      g.clearRect(0, 0, c.width, c.height);
      onChange?.();
    },
    canUndo: () => undoStack.current.length > 0,
  }));

  // Object-fit: contain — pick the smaller of the two scale factors.
  const fit = (() => {
    if (!imgSize || containerSize.w === 0 || containerSize.h === 0) {
      return { w: 0, h: 0 };
    }
    const scale = Math.min(
      containerSize.w / imgSize.w,
      containerSize.h / imgSize.h,
    );
    return {
      w: Math.max(1, Math.floor(imgSize.w * scale)),
      h: Math.max(1, Math.floor(imgSize.h * scale)),
    };
  })();

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full w-full items-center justify-center bg-neutral-950"
    >
      {imgSize && fit.w > 0 && (
        <div
          className="relative"
          style={{ width: fit.w, height: fit.h }}
        >
          <canvas
            ref={bgRef}
            className="absolute inset-0 select-none"
            style={{
              width: fit.w,
              height: fit.h,
              pointerEvents: "none",
            }}
          />
          <canvas
            ref={maskRef}
            className="absolute inset-0 touch-none cursor-crosshair"
            style={{ width: fit.w, height: fit.h, opacity }}
            onPointerDown={startStroke}
            onPointerMove={moveStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={endStroke}
          />
        </div>
      )}
    </div>
  );
});
