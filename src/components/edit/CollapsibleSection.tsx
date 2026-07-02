import { useState, type ReactNode } from "react";

/**
 * 右パネル内の折りたたみセクション (Photoshop 風 UI 再構成 2026-07-02)。
 *
 * レイヤースプリッターや分解モード切替など、常時は開かない補助機能を格納する。
 * Photoshop のパネルの「セクションを畳める」挙動を踏襲し、キャンバスを主役にする。
 */
export function CollapsibleSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-[#2a2a2a]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#1e1e1e]"
      >
        <span className="flex items-center gap-2">
          <ChevronIcon open={open} />
          <span className="text-xs font-black text-neutral-100">{title}</span>
        </span>
        {badge}
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </section>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export default CollapsibleSection;
