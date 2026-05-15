import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { editInpaint, images as imagesIpc } from "../../lib/ipc";
import { MaskCanvas, type MaskCanvasHandle, type MaskMode } from "../MaskCanvas";
import { EditModelGate } from "../EditModelGate";

type InpaintToolProps = {
  inputPath: string | null;
  projectName?: string | null;
  onResult?: (path: string) => void;
};

export function InpaintTool({ inputPath, projectName, onResult }: InpaintToolProps) {
  const canvasRef = useRef<MaskCanvasHandle | null>(null);
  const [brushSize, setBrushSize] = useState(36);
  const [mode, setMode] = useState<MaskMode>("paint");
  const [opacity, setOpacity] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!inputPath || !canvasRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await canvasRef.current.toBlob();
      const maskBytes = new Uint8Array(await blob.arrayBuffer());
      const maskPath = await imagesIpc.writeMask(inputPath, maskBytes);
      const result = await editInpaint.run(inputPath, maskPath, projectName ?? undefined);
      onResult?.(result);
      canvasRef.current.clear();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const canUndo = canvasRef.current?.canUndo() ?? false;
  void version;

  return (
    <EditModelGate required={["inpaint"]}>
      <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-black text-white">背景補完</h3>
            <p className="mt-1 text-[10px] font-bold text-neutral-500">
              白く塗った場所を消す
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={!inputPath || busy}
            className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-black text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy ? "補完中…" : "消す"}
          </button>
        </div>

        <div className="mt-3 h-56 overflow-hidden rounded-lg border border-[#303030] bg-[#101010]">
          {inputPath ? (
            <MaskCanvas
              ref={canvasRef}
              src={convertFileSrc(inputPath)}
              brushSize={brushSize}
              mode={mode}
              opacity={opacity}
              onChange={() => setVersion((value) => value + 1)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] font-bold text-neutral-600">
              画像を選んでください
            </div>
          )}
        </div>

        <div className="mt-3 space-y-2 text-[11px] font-bold text-neutral-300">
          <div className="flex rounded-lg border border-[#343434] p-0.5">
            <ToolToggle active={mode === "paint"} onClick={() => setMode("paint")} label="塗る" />
            <ToolToggle active={mode === "erase"} onClick={() => setMode("erase")} label="消す" />
          </div>
          <label className="flex items-center gap-2">
            ブラシ
            <input
              type="range"
              min={4}
              max={160}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.currentTarget.value))}
              className="min-w-0 flex-1"
            />
            <span className="w-7 text-right text-neutral-500">{brushSize}</span>
          </label>
          <label className="flex items-center gap-2">
            透過
            <input
              type="range"
              min={20}
              max={90}
              value={Math.round(opacity * 100)}
              onChange={(event) => setOpacity(Number(event.currentTarget.value) / 100)}
              className="min-w-0 flex-1"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                canvasRef.current?.undo();
                setVersion((value) => value + 1);
              }}
              disabled={!canUndo}
              className="rounded-lg border border-[#343434] px-2 py-1.5 text-neutral-200 hover:border-emerald-400 disabled:opacity-40"
            >
              元に戻す
            </button>
            <button
              type="button"
              onClick={() => {
                canvasRef.current?.clear();
                setVersion((value) => value + 1);
              }}
              className="rounded-lg border border-[#343434] px-2 py-1.5 text-neutral-200 hover:border-rose-400"
            >
              全クリア
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-200">
            {error}
          </p>
        )}
      </section>
    </EditModelGate>
  );
}

function ToolToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex-1 rounded-md px-2 py-1 text-[11px] font-black",
        active ? "bg-emerald-600 text-white" : "text-neutral-500 hover:text-neutral-200",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
