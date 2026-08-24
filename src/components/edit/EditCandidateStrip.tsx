import { convertFileSrc } from "@tauri-apps/api/core";

type EditCandidateStripProps = {
  basePath: string;
  candidates: string[];
  currentPath: string;
  onSelect: (path: string) => void;
  onDownload: () => void;
};

export function EditCandidateStrip({
  basePath,
  candidates,
  currentPath,
  onSelect,
  onDownload,
}: EditCandidateStripProps) {
  const paths = [basePath, ...candidates.filter((path) => path !== basePath)];

  return (
    <div
      data-edit-candidate-strip
      className="absolute bottom-6 left-6 z-20 flex items-center gap-2"
    >
      <div className="flex items-center gap-1.5 rounded-xl border border-[#2a2a2a] bg-[#1b1b1b]/95 p-1.5 shadow-2xl">
        {paths.map((path, index) => (
          <button
            key={path}
            type="button"
            onClick={() => onSelect(path)}
            title={index === 0 ? "オリジナル" : `編集候補 ${index}`}
            aria-label={index === 0 ? "オリジナル" : `編集候補 ${index}`}
            className={`h-12 w-12 overflow-hidden rounded-lg border bg-[#101010] ${
              currentPath === path
                ? "border-indigo-400 ring-1 ring-indigo-400"
                : "border-[#333] hover:border-neutral-500"
            }`}
          >
            <img src={convertFileSrc(path)} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      {candidates.length > 0 ? (
        <button
          type="button"
          onClick={onDownload}
          title="ダウンロード"
          aria-label="ダウンロード"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#1b1b1b] text-neutral-300 shadow-2xl hover:bg-[#262626] hover:text-white"
        >
          <DownloadIcon />
        </button>
      ) : null}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

export default EditCandidateStrip;

