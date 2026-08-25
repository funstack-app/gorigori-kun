import { useEffect, useRef, useState } from "react";

import {
  FOCUS_DEFAULT,
  FOCUS_ZOOM_MAX,
  FOCUS_ZOOM_MIN,
  normalizeFocus,
  type ThumbnailFocus,
} from "../lib/store/presets";
import { ModalPortal } from "./ModalPortal";

/**
 * サムネ focal point + zoom を編集する 16:9 プレビュー領域。
 *
 * - サムネ枠を基準に画像をズーム (ホイール / + / -)
 * - ドラッグで focal point 移動
 * - 確定 / キャンセルは外側のモーダル / フォームが制御する
 *
 * value / onChange の controlled component として使う。
 */
export function PresetThumbnailFocusEditor({
  src,
  value,
  onChange,
  className,
}: {
  src: string;
  value: ThumbnailFocus | undefined;
  onChange: (focus: ThumbnailFocus) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean }>({ active: false });
  const focus = normalizeFocus(value ?? FOCUS_DEFAULT);

  const setFocus = (next: ThumbnailFocus) => {
    const n = normalizeFocus(next);
    if (n.x === focus.x && n.y === focus.y && n.zoom === focus.zoom) return;
    onChange(n);
  };

  const updateFromPointer = (event: { clientX: number; clientY: number }) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    setFocus({ x, y, zoom: focus.zoom });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current.active = true;
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    event.preventDefault();
    updateFromPointer(event);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    try {
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    } catch {
      /* noop */
    }
  };

  // ホイールで zoom 微調整
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.4 : 0.1;
    const delta = event.deltaY < 0 ? step : -step;
    setFocus({ ...focus, zoom: focus.zoom + delta });
  };

  // キーボード: + / - で zoom（focal モーダル使用時の補助）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // input/textarea にフォーカスがある時は無視
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setFocus({ ...focus, zoom: focus.zoom + 0.2 });
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setFocus({ ...focus, zoom: focus.zoom - 0.2 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // focus を依存に入れると毎更新でlistener張替え。setFocus は最新を参照するよう closure で持つ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.x, focus.y, focus.zoom]);

  const xPct = `${(focus.x * 100).toFixed(2)}%`;
  const yPct = `${(focus.y * 100).toFixed(2)}%`;

  return (
    <div
      className={[
        "relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-[#3a3a3a] bg-[#0d0d0d]",
        className ?? "",
      ].join(" ")}
    >
      <img
        src={src}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        style={{
          objectPosition: `${xPct} ${yPct}`,
          transform: focus.zoom !== 1 ? `scale(${focus.zoom})` : "none",
          transformOrigin: `${xPct} ${yPct}`,
        }}
        draggable={false}
      />
      {/* ピンクのオーバーレイで「編集中」を示す */}
      <div className="pointer-events-none absolute inset-0 bg-pink-500/8 ring-2 ring-inset ring-pink-400/70" />

      {/* ドラッグキャプチャ層 */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        title="ドラッグで位置調整、ホイールで拡大縮小"
      />

      {/* 中央 focal point インジケータ */}
      <div
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: xPct, top: yPct }}
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-pink-500/80 shadow-[0_0_0_2px_rgba(0,0,0,0.55)]">
          <div className="h-1.5 w-1.5 rounded-full bg-white" />
        </div>
      </div>

      {/* zoom コントロール */}
      <div className="absolute bottom-1.5 left-1.5 z-20 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-1 text-[10px] font-black text-neutral-100 shadow-lg">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setFocus({ ...focus, zoom: focus.zoom - 0.2 });
          }}
          disabled={focus.zoom <= FOCUS_ZOOM_MIN}
          className="h-5 w-5 rounded text-sm hover:bg-pink-500 disabled:cursor-not-allowed disabled:opacity-30"
          title="ズームアウト"
        >
          −
        </button>
        <span className="min-w-[34px] text-center tabular-nums">
          ×{focus.zoom.toFixed(1)}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setFocus({ ...focus, zoom: focus.zoom + 0.2 });
          }}
          disabled={focus.zoom >= FOCUS_ZOOM_MAX}
          className="h-5 w-5 rounded text-sm hover:bg-pink-500 disabled:cursor-not-allowed disabled:opacity-30"
          title="ズームイン"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onChange({ ...FOCUS_DEFAULT });
          }}
          className="ml-1 h-5 rounded px-1.5 text-[9px] font-bold text-neutral-300 hover:bg-neutral-700"
          title="リセット（中央 / 等倍）"
        >
          リセット
        </button>
      </div>
    </div>
  );
}

/**
 * focal point 編集を独立モーダルで出すラッパ。
 * サムネ新規登録直後に「位置を調整しますか？」のフローで使う。
 *
 * 操作:
 * - 「保存」ボタン or Enter → onSave(現在値) で確定
 * - 「キャンセル」ボタン or Escape → onCancel() で破棄（initialFocus に戻す）
 * - 背景クリックは閉じない（編集途中のミス防止）
 */
export function PresetThumbnailFocusModal({
  src,
  initialFocus,
  onSave,
  onCancel,
}: {
  src: string;
  initialFocus: ThumbnailFocus | undefined;
  onSave: (focus: ThumbnailFocus) => void;
  onCancel: () => void;
}) {
  const [focus, setFocus] = useState<ThumbnailFocus>(() =>
    normalizeFocus(initialFocus ?? FOCUS_DEFAULT),
  );

  // body スクロール抑止
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc / Enter
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter") {
        // input/textarea にフォーカス時は無視
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        event.preventDefault();
        onSave(focus);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, onSave, onCancel]);

  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          // 背景クリックは「編集を確定する意図」と取りづらいので破棄ではなく無視
          event.stopPropagation();
        }
      }}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[#2a2a2a] bg-[#161616] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="サムネイル位置調整"
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">サムネイル位置調整</h3>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-base text-neutral-400 hover:bg-neutral-800 hover:text-white"
            title="キャンセル（Escape）"
          >
            ×
          </button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-[11px] text-neutral-400">
            ドラッグで中心位置、ホイール / ＋−ボタンでズーム。プリセット一覧やピッカーでこの見え方になります。
          </p>
          <PresetThumbnailFocusEditor src={src} value={focus} onChange={setFocus} />
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 rounded-md border border-[#343434] bg-[#0b0b0b] px-3 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => onSave(focus)}
              className="h-8 rounded-md bg-pink-500 px-4 text-xs font-bold text-white hover:bg-pink-400"
            >
              この位置で保存
            </button>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
