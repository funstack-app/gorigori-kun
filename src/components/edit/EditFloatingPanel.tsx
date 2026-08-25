import type { ReactNode } from "react";

type EditFloatingPanelProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: "normal" | "wide";
};

/** Magnific 型の、左上に浮く道具パネル共通枠。 */
export function EditFloatingPanel({
  title,
  onClose,
  children,
  width = "normal",
}: EditFloatingPanelProps) {
  return (
    <section
      data-edit-floating-panel
      className={`absolute left-6 top-6 z-30 flex max-h-[calc(100%-3rem)] flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] p-4 shadow-2xl ${
        width === "wide" ? "w-[390px] max-w-[calc(100%-3rem)]" : "w-[280px]"
      }`}
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
      <div className="-mx-4 mt-2 min-h-0 overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

export default EditFloatingPanel;
