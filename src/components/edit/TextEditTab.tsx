import { useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { editInpaint, editOcr, images as imagesIpc } from "../../lib/ipc";
import type { TextRegion } from "../../lib/edit/types";
import { EditModelGate } from "../EditModelGate";

type TextEditTabProps = {
  inputPath: string | null;
  projectName?: string | null;
  onResult?: (path: string) => void;
};

export function TextEditTab({ inputPath, projectName, onResult }: TextEditTabProps) {
  const [regions, setRegions] = useState<TextRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"detect" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => regions.find((region) => region.id === selectedId) ?? null,
    [regions, selectedId],
  );

  const detect = async () => {
    if (!inputPath || busy) return;
    setBusy("detect");
    setError(null);
    try {
      const detected = await editOcr.detect(inputPath);
      setRegions(detected);
      setSelectedId(detected[0]?.id ?? null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(null);
    }
  };

  const removeText = async (region: TextRegion) => {
    if (!inputPath || busy) return;
    setBusy("remove");
    setError(null);
    try {
      const bytes = await generateMaskFromBBox(inputPath, region.bbox);
      const maskPath = await imagesIpc.writeMask(inputPath, bytes);
      const result = await editInpaint.run(inputPath, maskPath, projectName ?? undefined);
      onResult?.(result);
      setRegions([]);
      setSelectedId(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <EditModelGate required={["ocr", "inpaint"]}>
      <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-black text-white">テキスト検出</h3>
            <p className="mt-1 text-[10px] font-bold text-neutral-500">
              OCR → 選択領域をLaMaで削除
            </p>
          </div>
          <button
            type="button"
            onClick={detect}
            disabled={!inputPath || busy !== null}
            className="rounded-lg bg-sky-500 px-2.5 py-1.5 text-[11px] font-black text-white hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy === "detect" ? "検出中…" : "検出"}
          </button>
        </div>

        {inputPath && selected ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-sky-400/30 bg-[#101010]">
            <img src={convertFileSrc(inputPath)} alt="" className="h-24 w-full object-contain" />
          </div>
        ) : null}

        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto pr-1">
          {regions.map((region) => (
            <button
              key={region.id}
              type="button"
              onClick={() => setSelectedId(region.id)}
              className={[
                "w-full rounded-lg border p-2 text-left transition",
                region.id === selectedId
                  ? "border-sky-400 bg-sky-500/10"
                  : "border-[#303030] bg-[#101010] hover:border-sky-400/60",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-black text-neutral-100">
                  {region.text || "（文字候補）"}
                </span>
                <span className="text-[10px] font-bold text-neutral-500">
                  {Math.round(region.confidence * 100)}%
                </span>
              </div>
              <div className="mt-1 text-[10px] font-bold text-neutral-600">
                x:{region.bbox[0]} y:{region.bbox[1]} w:{region.bbox[2]} h:{region.bbox[3]}
              </div>
            </button>
          ))}
          {regions.length === 0 && (
            <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-5 text-center text-[11px] font-bold text-neutral-600">
              まだ検出していません
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => selected && void removeText(selected)}
          disabled={!selected || busy !== null}
          className="mt-3 w-full rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {busy === "remove" ? "削除中…" : "選択テキストを消す"}
        </button>

        {error && (
          <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-200">
            {error}
          </p>
        )}
      </section>
    </EditModelGate>
  );
}

async function generateMaskFromBBox(inputPath: string, bbox: [number, number, number, number]) {
  const img = await loadImage(inputPath);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context unavailable");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const pad = 6;
  const x = Math.max(0, bbox[0] - pad);
  const y = Math.max(0, bbox[1] - pad);
  const w = Math.min(canvas.width - x, bbox[2] + pad * 2);
  const h = Math.min(canvas.height - y, bbox[3] + pad * 2);
  ctx.fillStyle = "white";
  ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("mask encode failed"))), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function loadImage(path: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像サイズを読めませんでした"));
    img.src = convertFileSrc(path);
  });
}
