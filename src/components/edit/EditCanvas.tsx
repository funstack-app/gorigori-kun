import { useMemo, useState } from "react";

import type { EditLayer } from "../../lib/edit/types";
import { SafeImage } from "../SafeImage";

type EditCanvasProps = {
  sourceImagePath: string | null;
  layers: EditLayer[];
  selectedLayerId: string | null;
  loading: boolean;
  message: string | null;
  error: string | null;
  onChooseImage: () => void;
};

export function EditCanvas({
  sourceImagePath,
  layers,
  selectedLayerId,
  loading,
  message,
  error,
  onChooseImage,
}: EditCanvasProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const visibleLayers = useMemo(
    () => layers.filter((layer) => layer.visible),
    [layers],
  );
  const selectedLayer = useMemo(
    () => layers.find((layer) => layer.id === selectedLayerId) ?? null,
    [layers, selectedLayerId],
  );

  if (!sourceImagePath) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center bg-[#121212] p-8">
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragOver(false);
          }}
          className={[
            "flex h-full min-h-80 w-full max-w-2xl flex-col items-center justify-center rounded-xl border border-dashed px-8 text-center transition",
            isDragOver
              ? "border-pink-400 bg-pink-500/10"
              : "border-[#3a3a3a] bg-[#101010]",
          ].join(" ")}
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[#343434] bg-[#181818] text-neutral-400">
            <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          </div>
          <h3 className="mt-5 text-xl font-black text-white">
            画像を選んで編集を始める
          </h3>
          <p className="mt-2 text-sm font-bold text-neutral-500">
            ドラッグ&ドロップ または
          </p>
          <button
            type="button"
            onClick={onChooseImage}
            disabled={loading}
            className="mt-5 h-12 rounded-lg bg-pink-500 px-8 text-base font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            画像を選ぶ
          </button>
          <p className="mt-4 text-xs font-bold text-neutral-600">
            対応形式: PNG / JPG / WEBP
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-white">編集キャンバス</h3>
          <p className="mt-1 truncate text-xs font-medium text-neutral-500">
            {selectedLayer ? `${selectedLayer.name} を選択中` : sourceImagePath}
          </p>
        </div>
        <button
          type="button"
          onClick={onChooseImage}
          disabled={loading}
          className="shrink-0 rounded-lg bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          画像を選ぶ
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        <div className="relative h-full max-h-full w-full max-w-full overflow-hidden rounded-lg border border-[#303030] bg-[#0b0b0b]">
          {visibleLayers.length > 0 ? (
            visibleLayers.map((layer, index) => (
              <SafeImage
                key={layer.id}
                path={layer.imagePath}
                alt=""
                style={{ zIndex: visibleLayers.length - index }}
                className={[
                  "absolute inset-0 h-full w-full object-contain",
                  layer.id === selectedLayerId
                    ? "outline outline-2 outline-offset-[-2px] outline-pink-400"
                    : "",
                ].join(" ")}
              />
            ))
          ) : (
            <SafeImage
              path={sourceImagePath}
              alt=""
              className="absolute inset-0 h-full w-full object-contain"
            />
          )}

          {loading ? (
            <div className="absolute inset-x-4 bottom-4 z-20 rounded-lg border border-pink-400/40 bg-[#101010]/90 px-3 py-2 text-xs font-black text-pink-200">
              処理中...
            </div>
          ) : null}
        </div>
      </div>

      {(message || error) && (
        <div
          className={[
            "mx-5 mb-4 rounded-lg border px-3 py-2 text-xs font-bold",
            error
              ? "border-red-500/40 bg-red-500/10 text-red-200"
              : "border-[#343434] bg-[#101010] text-neutral-300",
          ].join(" ")}
        >
          {error ?? message}
        </div>
      )}
    </section>
  );
}
