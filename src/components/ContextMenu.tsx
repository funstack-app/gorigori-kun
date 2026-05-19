import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextMenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { kind: "separator" };

type Props = {
  /** Cursor position in viewport coordinates. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

/**
 * Floating context menu anchored at (x, y). Auto-flips inside the viewport
 * on the right/bottom edges, dismisses on outside-click / Escape / scroll,
 * and traps focus in a lightweight way (initial focus on the first item,
 * Esc closes — Tab still cycles natively).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - 4) nx = Math.max(4, vw - rect.width - 4);
    if (ny + rect.height > vh - 4) ny = Math.max(4, vh - rect.height - 4);
    setPos({ x: nx, y: ny });
    el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDocPointer = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    // mousedown to dismiss before the click lands on whatever is underneath.
    document.addEventListener("mousedown", onDocPointer, true);
    document.addEventListener("contextmenu", onDocPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDocPointer, true);
      document.removeEventListener("contextmenu", onDocPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="画像メニュー"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] min-w-[190px] rounded-md border border-neutral-200 bg-white py-1 text-xs text-neutral-700 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div key={`sep-${i}`} className="my-1 border-t border-neutral-100" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={(event) => {
              if (it.disabled) return;
              // STΛCK 報告 (2026-05-19): プレビューモーダル内で
              // 「プリセットに登録…」を押すと、click が親モーダルへ
              // バブリングして onClick={close} が走り、prefsetTarget セット
              // 直後にモーダルが閉じる → ダイアログが出ない問題があった。
              // stopPropagation で根治。
              event.stopPropagation();
              it.onClick();
              onClose();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition ${
              it.disabled
                ? "cursor-not-allowed text-neutral-300"
                : it.danger
                  ? "hover:bg-rose-50 hover:text-rose-700"
                  : "hover:bg-neutral-100 hover:text-neutral-950"
            }`}
          >
            {it.icon && (
              <span className="flex h-4 w-4 items-center justify-center rounded border border-neutral-200 bg-neutral-50 text-[9px] font-semibold text-neutral-500">
                {it.icon}
              </span>
            )}
            <span className="flex-1">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
