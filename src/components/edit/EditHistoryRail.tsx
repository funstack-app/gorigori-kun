import { convertFileSrc } from "@tauri-apps/api/core";

import type { EditVersion } from "../../lib/store/editSession";

type EditHistoryRailProps = {
  basePath: string;
  versions: EditVersion[];
  currentPath: string;
  disabled: boolean;
  onSelect: (path: string) => void;
};

export function EditHistoryRail({
  basePath,
  versions,
  currentPath,
  disabled,
  onSelect,
}: EditHistoryRailProps) {
  const paths = [...versions].reverse().map((version) => version.path);

  return (
    <div
      data-edit-history-rail
      className="absolute bottom-4 right-2 top-16 z-20 flex w-[64px] flex-col gap-2 overflow-y-auto"
    >
      {[...paths, basePath].map((path, index) => (
        <button
          key={path}
          type="button"
          onClick={() => onSelect(path)}
          disabled={disabled}
          aria-label={index === paths.length ? "元画像" : `編集履歴 ${paths.length - index}`}
          className={`w-14 shrink-0 overflow-hidden rounded-lg border bg-[#101010] disabled:cursor-wait disabled:opacity-50 ${
            currentPath === path
              ? "border-indigo-400 ring-2 ring-indigo-400/70"
              : "border-[#333] hover:border-neutral-500"
          }`}
        >
          <img src={convertFileSrc(path)} alt="" className="aspect-square w-full object-cover" />
        </button>
      ))}
    </div>
  );
}

export default EditHistoryRail;
