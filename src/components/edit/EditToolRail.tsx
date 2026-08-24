import type { ReactNode } from "react";

export type EditToolId =
  | "ai"
  | "region"
  | "crop"
  | "adjust";

type EditToolRailProps = {
  activeTool: EditToolId;
  disabled: boolean;
  removingBackground: boolean;
  onSelect: (tool: EditToolId) => void;
  onRemoveBackground: () => void;
};

type OneShotToolId = "background";

const TOOLS: ReadonlyArray<{
  id: EditToolId | OneShotToolId;
  label: string;
  icon: ReactNode;
}> = [
  { id: "ai", label: "ことばで直す", icon: <SparklesIcon /> },
  { id: "region", label: "囲んで直す", icon: <FrameIcon /> },
  { id: "crop", label: "切り抜き", icon: <CropIcon /> },
  { id: "adjust", label: "調整", icon: <AdjustIcon /> },
  { id: "background", label: "背景透過", icon: <BackgroundIcon /> },
];

export function EditToolRail({
  activeTool,
  disabled,
  removingBackground,
  onSelect,
  onRemoveBackground,
}: EditToolRailProps) {
  return (
    <div
      data-edit-tool-rail
      className="flex items-center rounded-xl border border-[#2a2a2a] bg-[#1b1b1b] px-2 py-1.5 shadow-2xl"
    >
      {TOOLS.map((item) => {
        const oneShot = item.id === "background";
        const active = !oneShot && activeTool === item.id;
        const busy = item.id === "background" && removingBackground;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            disabled={disabled || busy}
            onClick={() => {
              if (item.id === "background") onRemoveBackground();
              else onSelect(item.id);
            }}
            className={`group relative flex h-9 w-9 items-center justify-center rounded-lg transition ${
              active
                ? "bg-indigo-500/90 text-white"
                : "text-neutral-300 hover:bg-[#262626]"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {busy ? <Spinner /> : item.icon}
            <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-2 py-1 text-[10px] font-medium text-white shadow-lg group-hover:block">
              {item.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function SparklesIcon() {
  return <Icon><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z" /><path d="m18.5 13 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3ZM5 13l.8 2.2L8 16l-2.2.8L5 19l-.8-2.2L2 16l2.2-.8L5 13Z" /></Icon>;
}

function FrameIcon() {
  return <Icon><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /></Icon>;
}

function CropIcon() {
  return <Icon><path d="M6 3v13a2 2 0 0 0 2 2h13M3 6h13a2 2 0 0 1 2 2v13" /></Icon>;
}

function AdjustIcon() {
  return <Icon><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Icon>;
}

function BackgroundIcon() {
  return <Icon><path d="M12 3s5 5.3 5 9a5 5 0 0 1-10 0c0-3.7 5-9 5-9Z" /><path d="M9 15c.8.8 1.7 1.2 3 1.2" /></Icon>;
}

function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export default EditToolRail;
