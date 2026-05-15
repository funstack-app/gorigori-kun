import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { EditModelCategory } from "../lib/edit/types";
import { onEditModelProgress } from "../lib/edit/events";
import { useEditModels } from "../lib/store/editModels";

type EditModelGateProps = {
  required: EditModelCategory[];
  children: ReactNode;
};

const CATEGORY_LABELS: Record<EditModelCategory, string> = {
  ocr: "OCR",
  inpaint: "背景補完",
  segment: "切り抜き",
  samClick: "クリック切り抜き",
};

function formatMb(bytes: number) {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}

export function EditModelGate({ required, children }: EditModelGateProps) {
  const models = useEditModels((state) => state.models);
  const downloading = useEditModels((state) => state.downloading);
  const loading = useEditModels((state) => state.loading);
  const error = useEditModels((state) => state.error);
  const load = useEditModels((state) => state.load);
  const download = useEditModels((state) => state.download);
  const applyProgress = useEditModels((state) => state.applyProgress);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEditModelProgress((progress) => {
      if (!disposed) applyProgress(progress);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyProgress]);

  const missingModels = useMemo(
    () =>
      models.filter(
        (model) => required.includes(model.category) && !model.downloaded,
      ),
    [models, required],
  );

  const isReady = models.length > 0 && missingModels.length === 0 && required.length > 0;
  const isDownloading = missingModels.some((model) => downloading.has(model.id));
  const totalBytes = missingModels.reduce((sum, model) => sum + model.sizeBytes, 0);
  const downloadedBytes = missingModels.reduce((sum, model) => {
    const progress = downloading.get(model.id);
    return sum + (progress?.downloaded ?? 0);
  }, 0);
  const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
  const requiredLabels = required.map((category) => CATEGORY_LABELS[category]).join(" / ");

  if (required.length === 0 || isReady || dismissed) {
    return <>{children}</>;
  }

  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
      <h3 className="text-sm font-black text-amber-100">AIモデルの準備が必要です</h3>
      <p className="mt-2 text-xs font-bold leading-5 text-amber-50/80">
        この機能を使うには {requiredLabels} モデル（合計 {formatMb(totalBytes)}）が必要です。
      </p>

      {loading ? (
        <p className="mt-3 text-xs font-bold text-neutral-400">モデル状態を確認中…</p>
      ) : (
        <div className="mt-3 space-y-2">
          {missingModels.map((model) => {
            const progress = downloading.get(model.id);
            const modelPercent = progress?.total
              ? Math.round((progress.downloaded / progress.total) * 100)
              : 0;
            return (
              <div key={model.id} className="rounded-lg border border-[#343434] bg-[#101010] p-2">
                <div className="flex justify-between gap-3 text-[11px] font-bold text-neutral-300">
                  <span>{model.displayName}</span>
                  <span>{progress ? `${modelPercent}%` : formatMb(model.sizeBytes)}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-amber-300 transition-all"
                    style={{ width: `${progress ? modelPercent : 0}%` }}
                  />
                </div>
                {progress?.error && (
                  <p className="mt-2 text-[11px] font-bold text-red-300">{progress.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isDownloading && (
        <p className="mt-3 text-xs font-bold text-amber-100">全体進捗: {percent}%</p>
      )}
      {error && <p className="mt-3 text-xs font-bold text-red-300">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => void download(missingModels.map((model) => model.id))}
          disabled={missingModels.length === 0 || isDownloading}
          className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-black text-black hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDownloading ? "DL中…" : "いまDL"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-xs font-bold text-neutral-200 hover:border-amber-300"
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}
