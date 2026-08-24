import type { ReactNode } from "react";

type EditFloatingPanelProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/** Magnific 型の、左上に浮く道具パネル共通枠。 */
export function EditFloatingPanel({ title, onClose, children }: EditFloatingPanelProps) {
  return (
    <section
      data-edit-floating-panel
      className="absolute left-6 top-6 z-30 flex max-h-[calc(100%-3rem)] w-[280px] flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] p-4 shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`${title}を閉じる`}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:bg-[#262626] hover:text-white"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div className="-mx-4 mt-2 min-h-0 overflow-y-auto [&_.accent-pink-500]:accent-indigo-500 [&_.bg-pink-500]:!bg-indigo-500 [&_.bg-pink-500\/10]:!bg-indigo-500/10 [&_.bg-pink-500\/15]:!bg-indigo-500/15 [&_.bg-pink-500\/20]:!bg-indigo-500/20 [&_.border-pink-400]:!border-indigo-400 [&_.border-pink-400\/50]:!border-indigo-400/50 [&_.border-pink-400\/60]:!border-indigo-400/60 [&_.border-pink-500]:!border-indigo-500 [&_.focus\:border-pink-400:focus]:!border-indigo-400 [&_.hover\:border-pink-400:hover]:!border-indigo-400 [&_.hover\:bg-pink-600:hover]:!bg-indigo-600 [&_.shadow-pink-500\/20]:!shadow-indigo-500/20 [&_.text-pink-100]:!text-indigo-100 [&_.text-pink-200]:!text-indigo-200 [&_.text-pink-300]:!text-indigo-300 [&_.text-pink-400]:!text-indigo-400">
        {children}
      </div>
    </section>
  );
}

export default EditFloatingPanel;
