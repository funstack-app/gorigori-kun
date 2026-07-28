import { useMemo, useState } from "react";

import {
  EXPORT_SIZE_PRESETS,
  supportsWebp,
  type ExportFormat,
  type ExportSize,
} from "./editor/exportImage";

type Props = {
  onExport: (format: ExportFormat, size: ExportSize) => void;
  onClose: () => void;
  busy?: boolean;
};

type SizeMode = "original" | "longEdge" | "preset";

/**
 * 書き出しダイアログ (形式 + サイズ)。
 *
 * WebP はエンジンが対応しているときだけ選択肢に出す。`canvas.toBlob` は
 * 非対応の MIME を渡されると**黙って PNG を返す**ため、選べるのに PNG が
 * 出てくる嘘のUIになりうる (exportImage.ts の supportsWebp コメント参照)。
 */
export function ExportDialog({ onExport, onClose, busy }: Props) {
  const webpAvailable = useMemo(() => supportsWebp(), []);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [sizeMode, setSizeMode] = useState<SizeMode>("original");
  const [longEdge, setLongEdge] = useState(2048);
  const [presetId, setPresetId] = useState<string>(EXPORT_SIZE_PRESETS[0].id);

  const formats: ReadonlyArray<{ id: ExportFormat; label: string }> = [
    { id: "png", label: "PNG" },
    { id: "jpeg", label: "JPEG" },
    ...(webpAvailable ? [{ id: "webp" as const, label: "WebP" }] : []),
  ];

  const buildSize = (): ExportSize => {
    if (sizeMode === "longEdge") {
      return { kind: "longEdge", px: Math.max(1, Math.round(longEdge)) };
    }
    if (sizeMode === "preset") {
      const preset =
        EXPORT_SIZE_PRESETS.find((item) => item.id === presetId) ?? EXPORT_SIZE_PRESETS[0];
      return { kind: "preset", width: preset.width, height: preset.height };
    }
    return { kind: "original" };
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-sm rounded-xl border border-[#343434] bg-[#1e1e1e] p-4 shadow-2xl">
        <h3 className="text-sm font-black text-white">書き出し</h3>

        <p className="mt-3 text-[10px] font-black text-neutral-400">形式</p>
        <div className="mt-1.5 flex gap-1.5">
          {formats.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFormat(item.id)}
              className={[
                "flex-1 rounded-md border px-2 py-2 text-[11px] font-black",
                format === item.id
                  ? "border-pink-400 bg-pink-500/20 text-pink-100"
                  : "border-[#3a3a3a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </div>

        <p className="mt-3.5 text-[10px] font-black text-neutral-400">サイズ</p>
        <div className="mt-1.5 space-y-1.5">
          {(
            [
              { id: "original", label: "元のまま" },
              { id: "longEdge", label: "長辺指定px" },
              { id: "preset", label: "SNSプリセット" },
            ] as const
          ).map((item) => (
            <label
              key={item.id}
              className="flex items-center gap-2 rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-2.5 py-2"
            >
              <input
                type="radio"
                name="export-size"
                checked={sizeMode === item.id}
                onChange={() => setSizeMode(item.id)}
                className="accent-pink-500"
              />
              <span className="text-[11px] font-bold text-neutral-200">{item.label}</span>
            </label>
          ))}
        </div>

        {sizeMode === "longEdge" ? (
          <input
            type="number"
            min={1}
            value={longEdge}
            onChange={(event) => setLongEdge(Number(event.target.value))}
            className="mt-2 w-full rounded-md border border-[#343434] bg-[#101010] px-2.5 py-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        ) : null}

        {sizeMode === "preset" ? (
          <div className="mt-2 space-y-1.5">
            {EXPORT_SIZE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPresetId(preset.id)}
                className={[
                  "w-full rounded-md border px-2.5 py-2 text-left text-[11px] font-bold",
                  presetId === preset.id
                    ? "border-pink-400 bg-pink-500/20 text-pink-100"
                    : "border-[#3a3a3a] bg-[#1a1a1a] text-neutral-300 hover:border-pink-400 hover:text-white",
                ].join(" ")}
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-2 text-xs font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            やめる
          </button>
          <button
            type="button"
            onClick={() => onExport(format, buildSize())}
            disabled={busy}
            className="flex-1 rounded-lg bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            書き出す
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;
