import { useEffect, useState } from "react";
import type { SceneOption } from "../../lib/scene/catalog";
import { CinePlaceholder } from "./CinePlaceholder";

type Props = {
  open: boolean;
  title: string;
  options: SceneOption[];
  selectedValue: string;
  onPick: (value: string) => void;
  onClose: () => void;
};

/**
 * Full-screen modal for picking a SceneOption from a grid of large
 * thumbnail cards. Modeled after RenderZero / Magnific style pickers.
 * If `option.thumbnail` is set, shows the image. Otherwise shows a
 * placeholder cinematic gradient with the label centered.
 */
export function OptionPickerModal({
  open,
  title,
  options,
  selectedValue,
  onPick,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filtered =
    filter.trim().length === 0
      ? options
      : options.filter((option) => {
          const target = `${option.value} ${option.hint ?? ""}`.toLowerCase();
          return target.includes(filter.trim().toLowerCase());
        });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-y-auto rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">
              Select
            </p>
            <h2 className="text-lg font-black text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#343434] bg-[#181818] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            ✕ 閉じる
          </button>
        </div>

        <div className="border-b border-[#262626] px-6 py-3">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="フィルター…"
            className="w-full rounded-md border border-[#343434] bg-[#181818] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-pink-500"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {filtered.length === 0 ? (
            <p className="text-center text-sm text-neutral-500">
              該当する選択肢はありません
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {filtered.map((option) => (
                <PickerCard
                  key={option.value}
                  option={option}
                  selected={option.value === selectedValue}
                  onSelect={() => {
                    onPick(option.value);
                    onClose();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PickerCard({
  option,
  selected,
  onSelect,
}: {
  option: SceneOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "group relative flex flex-col overflow-hidden rounded-lg border-2 text-left transition",
        selected
          ? "border-pink-400 bg-[#1a1a1a] shadow-lg"
          : "border-[#262626] bg-[#181818] hover:border-pink-500/50",
      ].join(" ")}
    >
      <div className="aspect-video w-full overflow-hidden bg-gradient-to-br from-neutral-700 to-neutral-900">
        {option.thumbnail ? (
          <img
            src={option.thumbnail.src}
            alt={option.thumbnail.alt}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <PlaceholderArt label={option.value} />
        )}
      </div>
      <div className="border-t border-[#262626] p-3">
        <div className="text-sm font-bold text-white">{option.value}</div>
        {option.hint && (
          <div className="mt-0.5 text-[11px] text-neutral-500">{option.hint}</div>
        )}
      </div>
      {selected && (
        <span className="absolute right-2 top-2 rounded-full bg-pink-500 px-2 py-0.5 text-[10px] font-bold text-white">
          選択中
        </span>
      )}
    </button>
  );
}

function PlaceholderArt({ label }: { label: string }) {
  return <CinePlaceholder label={label} size="lg" />;
}
