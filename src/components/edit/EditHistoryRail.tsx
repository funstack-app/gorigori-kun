import { convertFileSrc } from "@tauri-apps/api/core";

import type { EditVersion } from "../../lib/store/editSession";

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

/**
 * 右端のサムネ一覧。Magnific 同様、ラベルや区切りの無い1本の縦ストリップ
 * (2026-08-26 STΛCK実機FB「右上の履歴みたいなのはいらない」)。
 * 並び: 未確定の候補 (新しいものが上) → 版 (新しいものが上) → 元画像。
 * 候補と版の見分けは付けず、クリックで表示・選択できる同じサムネとして扱う。
 */
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
  const versionPaths = [...versions].reverse().map((version) => version.path);
  const known = new Set([...versionPaths, basePath]);
  const candidatePaths = candidates.filter((path) => !known.has(path));
  const paths = [...candidatePaths, ...versionPaths, ...(basePath ? [basePath] : [])];

  return (
    <aside
      data-edit-history-rail
      aria-label="画像一覧"
      className="flex w-[72px] shrink-0 flex-col overflow-hidden border-l border-[#2a2a2a] bg-[#171717]"
    >
      {candidatePaths.length > 0 && onDownload ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadDisabled}
            title="候補を書き出す"
            aria-label="候補を書き出す"
            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-[#2a2a2a] hover:text-white disabled:cursor-wait disabled:opacity-50"
          >
            <DownloadIcon />
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden px-2 pb-3 pt-3">
        {paths.map((path) => (
          <button
            key={path}
            data-edit-version-select
            type="button"
            onClick={() => onSelect(path)}
            disabled={disabled}
            aria-label={path === basePath ? "元画像" : "画像を表示"}
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
    </aside>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

export default EditHistoryRail;
