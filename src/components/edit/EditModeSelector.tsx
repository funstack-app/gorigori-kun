import { useEffect, useState } from "react";

import { editModels, type EditPlatformInfo } from "../../lib/ipc";
import { EDIT_MODES, type EditModeId } from "../../lib/edit/modes";
import { useEditModels } from "../../lib/store/editModels";

type EditModeSelectorProps = {
  activeMode: EditModeId;
  onSelectMode: (mode: EditModeId) => void;
};

/**
 * 編集タブのレイヤー分解モード選択 (STΛCK 指示 2026-06-17)。
 * - 高速・スタンダード (全OS) / 低速・高精度 (Apple Silicon 専用) を並べる。
 * - 各モードの必要スペックを明記し、対応環境でなければ選択不可 + 理由表示。
 * - 未DLのモデルがあれば「モデルを追加」ボタンで DL (既存 editModels.download を使う)。
 */
export function EditModeSelector({ activeMode, onSelectMode }: EditModeSelectorProps) {
  const [platform, setPlatform] = useState<EditPlatformInfo | null>(null);
  const models = useEditModels((s) => s.models);
  const downloading = useEditModels((s) => s.downloading);
  const load = useEditModels((s) => s.load);
  const download = useEditModels((s) => s.download);

  useEffect(() => {
    void editModels.platformInfo().then(setPlatform).catch(() => setPlatform(null));
    void load();
  }, [load]);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {EDIT_MODES.map((mode) => {
        // platform 解決前は availability を判定できない。standard は常に ok なので
        // 利用可、それ以外 (環境依存判定が必要なモード) はロード完了まで選択不可にする。
        // 「ロード中の一瞬だけ選べてしまう」チラつきを防ぐため。
        const availability = platform
          ? mode.availability(platform)
          : mode.id === "standard"
            ? { ok: true as const }
            : { ok: false as const, reason: "対応環境を確認中…" };
        const isActive = activeMode === mode.id;

        // このモードが要求するカテゴリのうち、未DLのモデル。
        const missing = models.filter(
          (m) => mode.requiredCategories.includes(m.category) && !m.downloaded,
        );
        const isDownloading = missing.some((m) => downloading.has(m.id));
        const needsDownload = missing.length > 0;

        const selectable = availability.ok;

        return (
          <button
            key={mode.id}
            type="button"
            disabled={!selectable}
            onClick={() => selectable && onSelectMode(mode.id)}
            className={[
              "flex flex-col gap-2 rounded-xl border p-3 text-left transition",
              isActive
                ? "border-pink-500 bg-pink-500/10"
                : selectable
                  ? "border-[#2a2a2a] bg-[#101010] hover:border-pink-400/60"
                  : "border-[#242424] bg-[#0d0d0d] opacity-60",
              !selectable ? "cursor-not-allowed" : "cursor-pointer",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-black text-neutral-100">{mode.label}</span>
              {isActive && (
                <span className="rounded bg-pink-500 px-1.5 py-0.5 text-[9px] font-black text-white">
                  選択中
                </span>
              )}
            </div>
            <p className="text-[10px] leading-4 text-neutral-400">{mode.tagline}</p>

            <ul className="space-y-0.5">
              {mode.requirements.map((req) => (
                <li key={req} className="flex items-start gap-1 text-[9px] text-neutral-500">
                  <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
                  <span>{req}</span>
                </li>
              ))}
            </ul>

            {!selectable && availability.reason && (
              <p className="rounded bg-[#1a1a1a] px-2 py-1 text-[9px] font-bold leading-3.5 text-amber-300/80">
                {availability.reason}
              </p>
            )}

            {selectable && needsDownload && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isDownloading) void download(missing.map((m) => m.id));
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !isDownloading) {
                    e.stopPropagation();
                    void download(missing.map((m) => m.id));
                  }
                }}
                className="mt-0.5 inline-flex w-fit items-center rounded-md bg-pink-500 px-2 py-1 text-[9px] font-black text-white hover:bg-pink-600"
              >
                {isDownloading
                  ? "モデルをDL中…"
                  : `モデルを追加 (約 ${formatGb(mode.approxDownloadMb)})`}
              </span>
            )}

            {selectable && !needsDownload && (
              <span className="mt-0.5 text-[9px] font-bold text-emerald-400/80">
                利用可能
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatGb(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${mb} MB`;
}
