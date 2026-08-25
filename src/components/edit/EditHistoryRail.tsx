import { convertFileSrc } from "@tauri-apps/api/core";

import type { EditVersion } from "../../lib/store/editSession";
import { EditCandidateStrip } from "./EditCandidateStrip";

type EditHistoryRailProps = {
  basePath: string;
  versions: EditVersion[];
  currentPath: string;
  disabled?: boolean;
  candidates?: string[];
  downloadDisabled?: boolean;
  onSelect: (path: string) => void;
  onDownload?: () => void;
};

export function EditHistoryRail({
  basePath,
  versions,
  currentPath,
  disabled = false,
  candidates = [],
  downloadDisabled = false,
  onSelect,
  onDownload,
}: EditHistoryRailProps) {
  const paths = [...versions].reverse().map((version) => version.path);

  return (
    <aside
      data-edit-history-rail
      aria-label="候補と版"
      className="flex w-[72px] shrink-0 flex-col overflow-hidden border-l border-[#2a2a2a] bg-[#171717]"
    >
      {candidates.length > 0 ? (
        <EditCandidateStrip
          basePath={basePath}
          candidates={candidates}
          currentPath={currentPath}
          disabled={disabled}
          downloadDisabled={downloadDisabled}
          showBase={false}
          onSelect={onSelect}
          onDownload={onDownload}
        />
      ) : null}
      <section aria-label="版" className="flex min-h-0 flex-1 flex-col px-2 pb-3 pt-3">
        <span className="mb-2 px-0.5 text-[10px] font-black text-neutral-400">版</span>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden">
          {[...paths, basePath].map((path, index) => (
            <button
              key={path}
              data-edit-version-select
              type="button"
              onClick={() => onSelect(path)}
              disabled={disabled}
              aria-label={index === paths.length ? "元画像" : `編集履歴 ${paths.length - index}`}
              className={`pointer-events-auto w-14 shrink-0 overflow-hidden rounded-lg border bg-[#101010] disabled:cursor-wait disabled:opacity-50 ${
                currentPath === path
                  ? "border-pink-400 ring-2 ring-pink-400/70"
                  : "border-[#333] hover:border-neutral-500"
              }`}
            >
              <img src={convertFileSrc(path)} alt="" className="aspect-square w-full object-cover" />
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

export default EditHistoryRail;
