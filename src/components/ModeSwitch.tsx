import { useWorkflow, type PrimaryMode } from "../lib/store/workflow";

export function ModeSwitch() {
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const setPrimaryMode = useWorkflow((s) => s.setPrimaryMode);

  return (
    <div className="flex rounded-md border border-neutral-800 bg-neutral-950 p-0.5 text-xs">
      <ModeButton
        active={primaryMode === "video"}
        label="動画"
        onClick={() => setPrimaryMode("video")}
      />
      <ModeButton
        active={primaryMode === "image"}
        label="画像"
        onClick={() => setPrimaryMode("image")}
      />
    </div>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-3 py-1 transition ${
        active
          ? "bg-lime-400 text-neutral-950"
          : "text-neutral-400 hover:text-neutral-100"
      }`}
    >
      {label}
    </button>
  );
}

export function modeLabel(mode: PrimaryMode): string {
  return mode === "video" ? "動画モード" : "画像モード";
}
