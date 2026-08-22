import { useEffect, useRef, useState } from "react";

export function HelpButton({
  hasCurrentTour,
  onStartCurrent,
  onStartWelcome,
}: {
  hasCurrentTour: boolean;
  onStartCurrent: () => void;
  onStartWelcome: () => void;
}) {
  const [noticeOpen, setNoticeOpen] = useState(false);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!noticeOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNoticeOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (noticeRef.current && !noticeRef.current.contains(event.target as Node)) {
        setNoticeOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [noticeOpen]);

  return (
    <div className="group fixed bottom-4 left-4 z-[120]" ref={noticeRef}>
      {noticeOpen ? (
        <div
          className="absolute bottom-14 left-0 w-72 rounded-xl border border-[#343434] bg-[#181818] p-4 text-neutral-100 shadow-2xl"
          role="dialog"
          aria-label="画面ガイド"
        >
          <h2 className="text-sm font-black">この画面のガイドは準備中です</h2>
          <p className="mt-2 text-xs leading-5 text-neutral-400">
            詳しい使い方は公式ガイドをご覧ください。最初の使い方は、はじめてガイドでも確認できます。
          </p>
          <button
            type="button"
            onClick={() => {
              setNoticeOpen(false);
              onStartWelcome();
            }}
            className="mt-3 h-8 rounded-md bg-pink-500 px-3 text-xs font-bold text-white hover:bg-pink-400"
          >
            はじめてガイドを開く
          </button>
        </div>
      ) : null}

      <button
        type="button"
        data-tour="help-button"
        onClick={() => {
          if (hasCurrentTour) onStartCurrent();
          else setNoticeOpen(true);
        }}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-pink-400/60 bg-[#181818] text-lg font-black text-pink-200 shadow-xl transition hover:border-pink-300 hover:bg-pink-500/15 hover:text-white focus:outline-none focus:ring-2 focus:ring-pink-400/70"
        title="この画面のガイド"
        aria-label="この画面のガイドを開く"
      >
        ?
      </button>
      <button
        type="button"
        onClick={onStartWelcome}
        className="pointer-events-none absolute bottom-1.5 left-12 ml-2 h-8 whitespace-nowrap rounded-full border border-[#343434] bg-[#181818] px-3 text-[11px] font-bold text-neutral-300 opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:border-pink-400 hover:text-white"
      >
        はじめてガイド
      </button>
    </div>
  );
}
