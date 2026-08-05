import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type SketchMode = "draw" | "erase";

/**
 * 用紙の色。**表示と書き出しで必ず同じ値を使う**唯一の正本。
 *
 * 白だと白ペンで描いた線が書き出し PNG で消える (見た目と成果物が食い違う)。
 * 明るいグレーにして、白ペン・黒ペンのどちらも残るようにする。
 * ブロックアウト生成 (presets.ts) はプロンプト側で背景色を指定していないため、
 * 用紙がグレーでも参照として問題ない。
 */
export const SKETCH_PAPER_COLOR = "#d9d9d9";

export type SketchCanvasHandle = {
  /** Snapshot the sketch as a flattened PNG blob (paper background + strokes). */
  toBlob: () => Promise<Blob>;
  undo: () => void;
  clear: () => void;
  /** True when there is at least one stroke that can be undone. */
  canUndo: () => boolean;
  /** True when nothing has been drawn yet (all-transparent stroke layer). */
  isEmpty: () => boolean;
};

type Props = {
  /** Intrinsic canvas size in px. Strokes are drawn at this resolution. */
  width: number;
  height: number;
  color: string;
  brushSize: number;
  mode: SketchMode;
  /** Notified after each stroke ends + after clear/undo so the toolbar can refresh. */
  onChange?: () => void;
};

const UNDO_STACK_LIMIT = 20;

/**
 * Two-canvas painter forked from `MaskCanvas.tsx` (mask semantics removed).
 *
 * Differences from MaskCanvas:
 * - the background layer is a flat paper fill (no source image to load)
 * - strokes use the caller's colour instead of a fixed white mask
 * - the intrinsic size comes from props (canvas aspect follows the composer)
 * - `toBlob` flattens background + strokes offscreen so the export is a normal
 *   opaque PNG that the generator can take as an i2i reference
 */
export const SketchCanvas = forwardRef<SketchCanvasHandle, Props>(
  function SketchCanvas(
    { width, height, color, brushSize, mode, onChange },
    ref,
  ) {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const bgRef = useRef<HTMLCanvasElement | null>(null);
    const strokeRef = useRef<HTMLCanvasElement | null>(null);
    const undoStack = useRef<ImageData[]>([]);
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
    const isDrawing = useRef(false);
    const last = useRef<{ x: number; y: number } | null>(null);

    // Track wrapper size — we compute the fitted display box in JS
    // (object-fit: contain semantics) and pin the canvases to it.
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

    // Size both layers and paint the paper background. Re-runs when the
    // requested canvas size changes (aspect switch) — which also resets the
    // drawing, so the user is warned about that in the modal.
    useEffect(() => {
      const bg = bgRef.current;
      const stroke = strokeRef.current;
      if (!bg || !stroke) return;
      bg.width = stroke.width = width;
      bg.height = stroke.height = height;
      const g = bg.getContext("2d");
      if (g) {
        g.fillStyle = SKETCH_PAPER_COLOR;
        g.fillRect(0, 0, width, height);
      }
      stroke.getContext("2d")?.clearRect(0, 0, width, height);
      undoStack.current = [];
      onChange?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [width, height]);

    const ctx = () => strokeRef.current?.getContext("2d") ?? null;

    const pushHistory = () => {
      const c = strokeRef.current;
      const g = ctx();
      if (!c || !g) return;
      const snap = g.getImageData(0, 0, c.width, c.height);
      undoStack.current.push(snap);
      if (undoStack.current.length > UNDO_STACK_LIMIT) {
        undoStack.current.shift();
      }
    };

    const eventToCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = strokeRef.current;
      if (!c) return null;
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
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
      g.fillStyle = color;
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
      g.strokeStyle = color;
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
        const bg = bgRef.current;
        const stroke = strokeRef.current;
        if (!bg || !stroke) throw new Error("sketch canvas not mounted");
        // Flatten offscreen: the exported PNG must be an opaque picture, not a
        // transparent stroke layer (the generator takes it as an i2i reference).
        const out = document.createElement("canvas");
        out.width = stroke.width;
        out.height = stroke.height;
        const g = out.getContext("2d");
        if (!g) throw new Error("2d context unavailable");
        g.drawImage(bg, 0, 0);
        g.drawImage(stroke, 0, 0);
        return await new Promise<Blob>((resolve, reject) => {
          out.toBlob(
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
        const c = strokeRef.current;
        const g = ctx();
        if (!c || !g) return;
        pushHistory();
        g.clearRect(0, 0, c.width, c.height);
        onChange?.();
      },
      canUndo: () => undoStack.current.length > 0,
      isEmpty: () => {
        const c = strokeRef.current;
        const g = ctx();
        if (!c || !g) return true;
        const { data } = g.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 0) return false;
        }
        return true;
      },
    }));

    // Object-fit: contain — pick the smaller of the two scale factors.
    const fit = (() => {
      if (containerSize.w === 0 || containerSize.h === 0) return { w: 0, h: 0 };
      const scale = Math.min(containerSize.w / width, containerSize.h / height);
      return {
        w: Math.max(1, Math.floor(width * scale)),
        h: Math.max(1, Math.floor(height * scale)),
      };
    })();

    return (
      <div
        ref={wrapperRef}
        className="relative flex h-full w-full items-center justify-center rounded-lg bg-[#0d0d0d]"
      >
        {fit.w > 0 && (
          <div
            className="relative shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_8px_24px_rgba(0,0,0,0.6)]"
            style={{ width: fit.w, height: fit.h }}
          >
            <canvas
              ref={bgRef}
              className="absolute inset-0 select-none"
              style={{ width: fit.w, height: fit.h, pointerEvents: "none" }}
            />
            <canvas
              ref={strokeRef}
              className="absolute inset-0 touch-none cursor-crosshair"
              style={{ width: fit.w, height: fit.h }}
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
  },
);
