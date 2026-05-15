import { useState } from "react";
import type { SceneOption } from "../../lib/scene/catalog";
import { CinePlaceholder } from "./CinePlaceholder";
import { OptionPickerModal } from "./OptionPickerModal";

type Props = {
  label: string;
  options: SceneOption[];
  value: string;
  onPick: (value: string) => void;
  modalTitle?: string;
};

/**
 * Compact selector for the left panel. Shows only the currently picked
 * option as a single card. Clicking opens a full picker modal where
 * users can browse all options visually (RenderZero pattern).
 */
export function OptionPickerButton({
  label,
  options,
  value,
  onPick,
  modalTitle,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value) ?? null;

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-neutral-300">{label}</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-[#343434] bg-[#101010] p-2 text-left transition hover:border-pink-400 hover:bg-[#1f1f1f]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="aspect-video h-10 shrink-0 overflow-hidden rounded bg-gradient-to-br from-neutral-700 to-neutral-900">
            {current?.thumbnail ? (
              <img
                src={current.thumbnail.src}
                alt={current.thumbnail.alt}
                className="h-full w-full object-cover"
              />
            ) : (
              <CinePlaceholder label={current?.value ?? label} size="sm" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-bold text-neutral-100">
              {current?.value ?? "選択する"}
            </div>
            {current?.hint && (
              <div className="truncate text-[10px] text-neutral-500">
                {current.hint}
              </div>
            )}
          </div>
        </div>
        <span className="shrink-0 text-xs font-bold text-neutral-500">
          変更
        </span>
      </button>

      <OptionPickerModal
        open={open}
        title={modalTitle ?? label}
        options={options}
        selectedValue={value}
        onPick={onPick}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
