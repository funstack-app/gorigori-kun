import { useEffect, useRef, useState } from "react";

/**
 * 「直したい場所」を四角で囲むための選択オーバーレイ (2026-07-26 STΛCK 指示)。
 *
 * ## なぜ fabric ではなく素の DOM オーバーレイなのか
 *
 * 範囲選択は「元画像のどこか」を決める操作であって、キャンバスに物を足す操作ではない。
 * fabric のオブジェクトとして矩形を足すと、
 *   - レイヤーとして数えられてしまう (書き出し・履歴・レイヤー数勘定に混ざる)
 *   - 消し忘れると書き出した PNG に選択枠が焼き込まれる
 * という事故が起きる。選択枠は**成果物に一切残ってはいけない**ので、
 * キャンバスの上に重ねた透明な div の中だけで完結させる。
 *
 * ## 座標系 (ここが唯一むずかしい所)
 *
 * 3つの座標系がある:
 *   1. 画面座標 (マウスの clientX/clientY)
 *   2. キャンバス座標 (fabric の viewportTransform でズーム/オフセットされた後)
 *   3. 元画像の実寸 (2400x1600 等。マスク PNG はこの寸法で作る)
 *
 * viewportTransform = [zoom, 0, 0, zoom, offsetX, offsetY] なので、
 *   画像上の点 = (画面上の点 - オフセット) / zoom
 * で 3 に変換できる。最後に画像幅・高さで割って 0..1 の正規化 bbox にする
 * (applyRedlineFix が正規化 bbox を受け取るため。実寸への再変換は
 *  buildFullSizeMaskFromNormalizedBbox が画像の naturalWidth を見て行う)。
 *
 * **実行時の表示サイズを一切ハードコードしない**。zoom もオフセットも
 * ウィンドウリサイズで変わるため、ドラッグのたびに canvas から読み直す。
 */

export type NormalizedBbox = [number, number, number, number];

type Props = {
  /** fabric.Canvas。viewportTransform と __ggBaseSize を読むためだけに使う (変更しない)。 */
  canvas: unknown;
  /** 確定済みの選択範囲 (正規化)。null なら未選択 = 画像全体が対象。 */
  value: NormalizedBbox | null;
  onChange: (bbox: NormalizedBbox | null) => void;
  /** 実行中は選択を触らせない。 */
  disabled?: boolean;
  /** 切り抜き時だけ指定。画面上の枠をこの横÷縦へ固定する。 */
  aspectRatio?: number | null;
  /**
   * 未選択時に出す案内文。用途で意味が変わる (AI に直させる範囲 / 塗りつぶす範囲)
   * ため、呼び出し側が指定できるようにする。未指定なら AI 修正向けの既定文。
   */
  hint?: string;
};

/** ドラッグ中の画面座標での矩形 (オーバーレイ div のローカル座標)。 */
type ScreenRect = { left: number; top: number; width: number; height: number };

function constrainedScreenRect(
  start: { x: number; y: number },
  x: number,
  y: number,
  aspectRatio?: number | null,
): ScreenRect {
  const dx = x - start.x;
  const dy = y - start.y;
  let width = Math.abs(dx);
  let height = Math.abs(dy);
  if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    if (height === 0 || width / height > aspectRatio) height = width / aspectRatio;
    else width = height * aspectRatio;
  }
  return {
    left: dx < 0 ? start.x - width : start.x,
    top: dy < 0 ? start.y - height : start.y,
    width,
    height,
  };
}

/** キャンバスの現在のズームと平行移動を読む。無ければ等倍。 */
export function readViewport(canvas: unknown): { zoom: number; offsetX: number; offsetY: number } {
  const vpt = (canvas as { viewportTransform?: number[] } | null)?.viewportTransform;
  const zoom = vpt?.[0];
  return {
    zoom: typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    offsetX: typeof vpt?.[4] === "number" && Number.isFinite(vpt[4]) ? vpt[4] : 0,
    offsetY: typeof vpt?.[5] === "number" && Number.isFinite(vpt[5]) ? vpt[5] : 0,
  };
}

/** 元画像の実寸 (fitCanvasToImage が __ggBaseSize に記録している)。 */
export function readBaseSize(canvas: unknown): { width: number; height: number } | null {
  const size = (canvas as { __ggBaseSize?: { width: number; height: number } } | null)
    ?.__ggBaseSize;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** 正規化 bbox → オーバーレイ上の表示矩形。zoom/offset が変わるたび再計算する。 */
function bboxToScreen(
  bbox: NormalizedBbox,
  canvas: unknown,
): ScreenRect | null {
  const base = readBaseSize(canvas);
  if (!base) return null;
  const { zoom, offsetX, offsetY } = readViewport(canvas);
  const [x, y, w, h] = bbox;
  return {
    left: x * base.width * zoom + offsetX,
    top: y * base.height * zoom + offsetY,
    width: w * base.width * zoom,
    height: h * base.height * zoom,
  };
}

export function RegionSelectOverlay({
  canvas,
  value,
  onChange,
  disabled,
  aspectRatio,
  hint,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const dragRectRef = useRef<ScreenRect | null>(null);
  const [dragRect, setDragRect] = useState<ScreenRect | null>(null);
  // viewportTransform は fabric が内部で書き換えるので React は再描画のきっかけを持たない。
  // ウィンドウリサイズ時に選択枠がズレたまま残らないよう、リサイズで強制再計算する。
  const [viewportTick, setViewportTick] = useState(0);

  useEffect(() => {
    const onResize = () => setViewportTick((tick) => tick + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const base = readBaseSize(canvas);
  const ready = Boolean(base) && !disabled;

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    const host = hostRef.current;
    if (!host) return;
    // 左ボタンだけ。右クリックは既存のコンテキストメニューに譲る。
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    startRef.current = { x, y };
    const next = { left: x, top: y, width: 0, height: 0 };
    dragRectRef.current = next;
    setDragRect(next);
    host.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    const host = hostRef.current;
    if (!start || !host) return;
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const next = constrainedScreenRect(start, x, y, aspectRatio);
    dragRectRef.current = next;
    setDragRect(next);
  };

  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    startRef.current = null;
    const host = hostRef.current;
    if (host?.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
    const rect = dragRectRef.current;
    dragRectRef.current = null;
    setDragRect(null);
    if (!start || !rect || !base) return;

    // クリックだけ (ドラッグしていない) は「選択を消す」操作にする。
    // 6px 未満は手ブレとみなす (境界に余白を取る: ちょうどの値を信じない)。
    if (rect.width < 6 || rect.height < 6) {
      onChange(null);
      return;
    }

    const { zoom, offsetX, offsetY } = readViewport(canvas);
    // 画面 → 画像実寸 → 正規化。画像の外にはみ出した分は 0..1 に切り詰める。
    const imageLeft = (rect.left - offsetX) / zoom;
    const imageTop = (rect.top - offsetY) / zoom;
    const imageRight = imageLeft + rect.width / zoom;
    const imageBottom = imageTop + rect.height / zoom;

    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    const x0 = clamp01(imageLeft / base.width);
    const y0 = clamp01(imageTop / base.height);
    const x1 = clamp01(imageRight / base.width);
    const y1 = clamp01(imageBottom / base.height);
    const width = x1 - x0;
    const height = y1 - y0;

    // 画像の外だけをドラッグした場合は幅か高さが 0 になる。効かない選択は作らない。
    if (width <= 0.002 || height <= 0.002) {
      onChange(null);
      return;
    }
    onChange([x0, y0, width, height]);
  };

  // viewportTick を参照して、リサイズ後に確定枠の位置を引き直す。
  void viewportTick;
  const committed = value ? bboxToScreen(value, canvas) : null;
  const shown = dragRect ?? committed;

  return (
    <div
      ref={hostRef}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      className={[
        "absolute inset-0 z-10",
        ready ? "cursor-crosshair" : "pointer-events-none",
      ].join(" ")}
      role="presentation"
    >
      {shown ? (
        <>
          {/* 選択外を軽く暗くして「ここだけ直る」を目で分かるようにする。 */}
          <div
            className="pointer-events-none absolute inset-0 bg-black/45"
            style={{
              clipPath: `polygon(0% 0%, 0% 100%, ${shown.left}px 100%, ${shown.left}px ${shown.top}px, ${shown.left + shown.width}px ${shown.top}px, ${shown.left + shown.width}px ${shown.top + shown.height}px, ${shown.left}px ${shown.top + shown.height}px, ${shown.left}px 100%, 100% 100%, 100% 0%)`,
            }}
          />
          <div
            className="pointer-events-none absolute border-2 border-pink-400"
            style={{
              left: shown.left,
              top: shown.top,
              width: shown.width,
              height: shown.height,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            }}
          >
            {/* 四隅のつまみ (見た目だけ。掴めるわけではないので小さく控えめに置く)。 */}
            {[
              { left: -3, top: -3 },
              { right: -3, top: -3 },
              { left: -3, bottom: -3 },
              { right: -3, bottom: -3 },
            ].map((pos, index) => (
              <span
                key={index}
                className="absolute h-1.5 w-1.5 rounded-full bg-pink-400"
                style={pos}
              />
            ))}
          </div>
        </>
      ) : null}

      {ready && !shown ? (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-pink-400/60 bg-[#101010]/95 px-3 py-1.5 text-[11px] font-bold text-pink-100 shadow-xl">
          {hint ?? "直したいところをドラッグで囲む"}
        </div>
      ) : null}
    </div>
  );
}

export default RegionSelectOverlay;
