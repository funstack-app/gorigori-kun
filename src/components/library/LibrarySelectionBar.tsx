import type { ReactNode } from "react";

export function LibrarySelectionBar({
  count,
  children,
  onClear,
}: {
  count: number;
  children: ReactNode;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/15 bg-[#171717]/85 px-3 py-2 shadow-2xl shadow-black/40 backdrop-blur-2xl">
        <span className="shrink-0 border-r border-white/10 pr-3 text-[11px] font-bold text-pink-200">
          {count}件選択
        </span>
        {children}
        <button
          type="button"
          onClick={onClear}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-white/10 hover:text-white"
          title="選択を解除"
          aria-label="選択を解除"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
