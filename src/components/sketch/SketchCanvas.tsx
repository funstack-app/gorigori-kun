import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  isSketchEmpty,
  renderStrokes,
  type PenType,
  type SketchStroke,
} from "./sketchModel";

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
  /** Intrinsic canvas size in px. Export resolution + brush size reference. */
  width: number;
  height: number;
  color: string;
  brushSize: number;
  mode: SketchMode;
  /** Pen type (affects opacity). Ignored while erasing. */
  pen: PenType;
  /** Notified after each stroke ends + after clear/undo so the toolbar can refresh. */
  onChange?: () => void;
};

const HISTORY_LIMIT = 50;

/**
 * ベクター方式のスケッチキャンバス。
 *
 * 元は `MaskCanvas.tsx` フォークのビットマップ実装だったが、描画レイヤーの内部解像度が
 * 1024 長辺固定 → CSS で約1.8倍に拡大表示 + Retina で更に2倍、という二重の拡大コピーで
 * 線が滲んでいた。ストロークを線の記録として持ち、**表示は画面の実解像度
 * (CSS サイズ × devicePixelRatio) で描き直す**ことで滲みを構造的に消している。
 *
 * - 表示レイヤー: fit.w×dpr / fit.h×dpr の backing store。リサイズ・DPR 変化で張り直し、
 *   ストロークから全再描画する (ベクターなので描いた内容は消えない)
 * - 書き出し (`toBlob`): props の width×height (1024 長辺・従来と同値) で紙色 + ストローク。
 *   生成パイプラインが受け取る PNG の契約は変えない
 * - undo: ImageData のスナップショットではなくストローク配列の履歴
 */
export const SketchCanvas = forwardRef<SketchCanvasHandle, Props>(
  function SketchCanvas(
    { width, height, color, brushSize, mode, pen, onChange },
    ref,
  ) {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const bgRef = useRef<HTMLCanvasElement | null>(null);
    const strokeRef = useRef<HTMLCanvasElement | null>(null);
    /** 確定済みストローク (これが唯一の正本。表示も書き出しもここから描く)。 */
    const strokes = useRef<SketchStroke[]>([]);
    /**
     * 確定済みストロークを焼いたオフスクリーン (表示と同解像度)。
     * 描画中のプレビューを「committed を戻す → 活性ストロークを1パス」で作るための土台。
     */
    const committed = useRef<HTMLCanvasElement | null>(null);
    /** undo 用のストローク配列スナップショット。 */
    const history = useRef<SketchStroke[][]>([]);
    /** 描画中のストローク (pointerUp で strokes へ確定)。 */
    const current = useRef<SketchStroke | null>(null);
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
    const [dpr, setDpr] = useState(() =>
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    );
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

    // ディスプレイ間の移動・OS のスケール変更で DPR が変わる。追従しないと
    // 別モニタへ持っていった瞬間だけ滲む。
    useEffect(() => {
      if (typeof window === "undefined" || !window.matchMedia) return;
      let media: MediaQueryList | null = null;
      let cancelled = false;
      const sync = () => {
        if (cancelled) return;
        const next = window.devicePixelRatio || 1;
        setDpr((prev) => (prev === next ? prev : next));
        media?.removeEventListener("change", sync);
        media = window.matchMedia(`(resolution: ${next}dppx)`);
        media.addEventListener("change", sync);
      };
      sync();
      return () => {
        cancelled = true;
        media?.removeEventListener("change", sync);
      };
    }, []);

    // Object-fit: contain — pick the smaller of the two scale factors.
    const fit = (() => {
      if (containerSize.w === 0 || containerSize.h === 0) return { w: 0, h: 0 };
      const scale = Math.min(containerSize.w / width, containerSize.h / height);
      return {
        w: Math.max(1, Math.floor(width * scale)),
        h: Math.max(1, Math.floor(height * scale)),
      };
    })();

    /**
     * committed をベクターから作り直し、表示レイヤーへ反映する。
     * リサイズ・DPR 変化・undo・clear・比率変更の共通経路。
     */
    const repaint = useCallback(() => {
      const bg = bgRef.current;
      const stroke = strokeRef.current;
      if (!bg || !stroke) return;
      const bgCtx = bg.getContext("2d");
      if (bgCtx) {
        bgCtx.setTransform(1, 0, 0, 1, 0, 0);
        bgCtx.fillStyle = SKETCH_PAPER_COLOR;
        bgCtx.fillRect(0, 0, bg.width, bg.height);
      }

      const c = committed.current ?? document.createElement("canvas");
      committed.current = c;
      if (c.width !== stroke.width || c.height !== stroke.height) {
        c.width = stroke.width;
        c.height = stroke.height;
      }
      const cg = c.getContext("2d");
      if (cg) {
        cg.setTransform(1, 0, 0, 1, 0, 0);
        cg.clearRect(0, 0, c.width, c.height);
        renderStrokes(cg, strokes.current, c.width, c.height);
      }
      presentCommitted();
    }, []);

    /** committed の内容をそのまま表示レイヤーへ写す (活性ストロークなし)。 */
    const presentCommitted = () => {
      const stroke = strokeRef.current;
      const c = committed.current;
      if (!stroke) return;
      const g = stroke.getContext("2d");
      if (!g) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, stroke.width, stroke.height);
      if (c && c.width > 0 && c.height > 0) g.drawImage(c, 0, 0);
    };

    /**
     * 描画中のプレビュー: 表示を committed で戻してから、活性ストロークを
     * **1パスで1回だけ** 描く。
     *
     * 線分を1本ずつ stroke すると、半透明ペン (鉛筆・マーカー) の重なった
     * つなぎ目だけが二重合成で濃くなり、確定後の全再描画 (1パス) と見た目が
     * 変わる。renderStrokes に活性ストロークを丸ごと渡すことで、描画中と
     * 確定後がまったく同じ経路になる。
     */
    const previewLive = () => {
      const stroke = strokeRef.current;
      const active = current.current;
      if (!stroke) return;
      presentCommitted();
      if (!active) return;
      const g = stroke.getContext("2d");
      if (!g) return;
      renderStrokes(g, [active], stroke.width, stroke.height);
    };

    // backing store を実解像度 (CSS サイズ × DPR) に張り直して全再描画。
    // ストロークはベクターで保持しているので、リサイズしても描いた内容は消えない。
    useEffect(() => {
      const bg = bgRef.current;
      const stroke = strokeRef.current;
      if (!bg || !stroke || fit.w === 0 || fit.h === 0) return;
      const pxW = Math.max(1, Math.round(fit.w * dpr));
      const pxH = Math.max(1, Math.round(fit.h * dpr));
      if (bg.width !== pxW || bg.height !== pxH) {
        bg.width = pxW;
        bg.height = pxH;
      }
      if (stroke.width !== pxW || stroke.height !== pxH) {
        stroke.width = pxW;
        stroke.height = pxH;
      }
      repaint();
    }, [fit.w, fit.h, dpr, repaint]);

    // 比率 (props の width/height) を変えたら描画をリセットする。
    // 従来の挙動どおりで、モーダル側でもユーザーに警告している。
    useEffect(() => {
      strokes.current = [];
      history.current = [];
      current.current = null;
      repaint();
      onChange?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [width, height]);

    const pushHistory = () => {
      history.current.push(strokes.current.slice());
      if (history.current.length > HISTORY_LIMIT) history.current.shift();
    };

    /** ポインタ位置を正規化座標 (0-1) にする。backing の解像度に依存しない。 */
    const eventToNorm = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = strokeRef.current;
      if (!c) return null;
      const rect = c.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    };

    const startStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const c = strokeRef.current;
      if (!c) return;
      const p = eventToNorm(e);
      if (!p) return;
      pushHistory();
      isDrawing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = p;
      current.current = {
        pen,
        mode,
        color,
        size: brushSize,
        points: [p],
      };
      // 点1個のストロークは renderStrokes 側が arc+fill の点として描く
      previewLive();
    };

    const moveStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current) return;
      const stroke = current.current;
      if (!stroke || !last.current) return;
      const p = eventToNorm(e);
      if (!p) return;
      stroke.points.push(p);
      last.current = p;
      previewLive();
    };

    const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      last.current = null;
      const stroke = current.current;
      current.current = null;
      if (stroke) {
        strokes.current.push(stroke);
        // 確定分を committed へ焼き込む (次のプレビューの土台になる)
        const c = committed.current;
        const cg = c?.getContext("2d") ?? null;
        if (c && cg) renderStrokes(cg, [stroke], c.width, c.height);
        presentCommitted();
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer may have been auto-released already */
      }
      onChange?.();
    };

    useImperativeHandle(ref, () => ({
      toBlob: async () => {
        // 書き出しは props の width×height (1024 長辺) 固定。表示解像度が変わっても
        // 生成パイプラインが受け取る PNG のサイズは従来どおり。
        //
        // 紙とストロークは**必ず別レイヤー**にする。同じキャンバスに直接描くと
        // 消しゴム (destination-out) が紙まで削り、書き出し PNG に透明画素が空く
        // (生成側は不透明 PNG を受け取る契約)。表示側と同じ二層構造。
        const layer = document.createElement("canvas");
        layer.width = width;
        layer.height = height;
        const lg = layer.getContext("2d");
        if (!lg) throw new Error("2d context unavailable");
        renderStrokes(lg, strokes.current, width, height);

        const out = document.createElement("canvas");
        out.width = width;
        out.height = height;
        const g = out.getContext("2d");
        if (!g) throw new Error("2d context unavailable");
        g.fillStyle = SKETCH_PAPER_COLOR;
        g.fillRect(0, 0, width, height);
        g.drawImage(layer, 0, 0);
        return await new Promise<Blob>((resolve, reject) => {
          out.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
            "image/png",
          );
        });
      },
      undo: () => {
        const prev = history.current.pop();
        if (!prev) return;
        strokes.current = prev;
        repaint();
        onChange?.();
      },
      clear: () => {
        pushHistory();
        strokes.current = [];
        repaint();
        onChange?.();
      },
      canUndo: () => history.current.length > 0,
      isEmpty: () => isSketchEmpty(strokes.current),
    }));

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
