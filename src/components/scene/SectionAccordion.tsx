import { useState, type ReactNode } from "react";

type Props = {
  number: string;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function SectionAccordion({
  number,
  title,
  summary,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-lg border border-[#2a2a2a] bg-[#181818] shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-500">
            {number}
          </p>
          <h2 className="text-sm font-bold text-white">{title}</h2>
          {summary && (
            <p className="mt-0.5 truncate text-[11px] font-medium text-neutral-500">
              {summary}
            </p>
          )}
        </div>
        <span className="shrink-0 text-xs font-bold text-neutral-500">
          {open ? "−" : "+"}
        </span>
      </button>

      {open && <div className="border-t border-[#2a2a2a] p-4">{children}</div>}
    </section>
  );
}
