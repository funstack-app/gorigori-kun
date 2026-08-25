import { convertFileSrc } from "@tauri-apps/api/core";

type EditCandidateStripProps = {
  basePath?: string;
  candidates: string[];
  currentPath: string;
  disabled?: boolean;
  downloadDisabled?: boolean;
  showBase?: boolean;
  onSelect: (path: string) => void;
  onDownload?: () => void;
};

type VersionSelectState = {
  generationBusy: boolean;
  toolBusy: boolean;
  versionInFlight: boolean;
  versionRecoveryRequired: boolean;
};

/** 復旧に必要な版選択は、復元不能状態だけでは止めない。 */
export function isVersionSelectDisabled({
  generationBusy,
  toolBusy,
  versionInFlight,
}: VersionSelectState): boolean {
  return generationBusy || toolBusy || versionInFlight;
}

export function EditCandidateStrip({
  basePath,
  candidates,
  currentPath,
  disabled = false,
  downloadDisabled = false,
  showBase = true,
  onSelect,
  onDownload,
}: EditCandidateStripProps) {
  const paths = [
    ...(showBase && basePath ? [basePath] : []),
    ...candidates.filter((path) => path !== basePath),
  ];

  return (
    <section
      data-edit-candidate-strip
      aria-label="候補"
      className="flex max-h-[45%] shrink-0 flex-col border-b border-[#2a2a2a] px-2 pb-2 pt-3"
    >
      <div className="mb-2 flex items-center justify-between gap-1 px-0.5">
        <span className="text-[10px] font-black text-neutral-400">候補</span>
        {candidates.length > 0 && onDownload ? (
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
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col items-center gap-2 overflow-y-auto">
        {paths.map((path, index) => (
          <button
            key={path}
            data-edit-version-select
            type="button"
            onClick={() => onSelect(path)}
            disabled={disabled}
            title={showBase && index === 0 ? "オリジナル" : `編集候補 ${showBase ? index : index + 1}`}
            aria-label={showBase && index === 0 ? "オリジナル" : `編集候補 ${showBase ? index : index + 1}`}
            className={`pointer-events-auto h-12 w-12 shrink-0 overflow-hidden rounded-lg border bg-[#101010] disabled:cursor-wait disabled:opacity-50 ${
              currentPath === path
                ? "border-pink-400 ring-2 ring-pink-400/70"
                : "border-[#333] hover:border-neutral-500"
            }`}
          >
            <img src={convertFileSrc(path)} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </section>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

export default EditCandidateStrip;
