import {
  isWorkspacePurpose,
  useWorkspace,
  type WorkspacePurpose,
} from "../lib/store/workspace";

type PurposeOption = {
  value: WorkspacePurpose | "lpFuture" | "carouselFuture";
  label: string;
  disabled?: boolean;
};

const PURPOSE_OPTIONS: PurposeOption[] = [
  { value: "artwork", label: "作品" },
  { value: "ad", label: "広告" },
  { value: "videoStory", label: "ストーリーカット" },
  { value: "lpFuture", label: "LP（α以降）", disabled: true },
  { value: "carouselFuture", label: "カルーセル（α以降）", disabled: true },
];

export function PurposeSelector() {
  const purpose = useWorkspace((s) => s.purpose);
  const setPurpose = useWorkspace((s) => s.setPurpose);

  return (
    <label className="flex items-center gap-2 text-xs font-bold text-neutral-400">
      用途
      <select
        value={purpose}
        onChange={(e) => {
          const next = e.target.value;
          if (isWorkspacePurpose(next)) setPurpose(next);
        }}
        className="h-9 min-w-[180px] rounded-lg border border-[#303030] bg-[#181818] px-3 text-sm font-black text-white outline-none hover:border-[#444] focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20"
      >
        {PURPOSE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
