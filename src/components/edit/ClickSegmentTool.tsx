import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState, type MouseEvent } from "react";

import { editSam2, images } from "../../lib/ipc";
import { useEditTab } from "../../lib/store/editTab";
import { EditModelGate } from "../EditModelGate";

export function ClickSegmentTool() {
  const inputPath = useEditTab((state) => state.selectedImagePath);
  const setMaskPath = useEditTab((state) => state.setMaskPath);
  const [embedded, setEmbedded] = useState(false);
  const [previewMaskBase64, setPreviewMaskBase64] = useState<string | null>(null);
  const [busy, setBusy] = useState<"embed" | "predict" | "confirm" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clickPoint, setClickPoint] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setEmbedded(false);
    setPreviewMaskBase64(null);
    setClickPoint(null);
    setMessage(null);
    setError(null);
  }, [inputPath]);

  const embed = async () => {
    if (!inputPath || busy) return;
    setBusy("embed");
    setError(null);
    setMessage("SAM2 encoder を実行中…");
    try {
      await editSam2.embed(inputPath);
      setEmbedded(true);
      setMessage("準備完了。切り抜きたい対象をクリックしてください。");
    } catch (caught) {
      setError(`SAM2 の準備に失敗しました: ${String(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const onClick = async (event: MouseEvent<HTMLImageElement>) => {
    if (!embedded || !inputPath || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    setClickPoint({ x: x * 100, y: y * 100 });
    setBusy("predict");
    setError(null);
    setMessage("マスク生成中…");
    try {
      const result = await editSam2.predict(x, y, true);
      setPreviewMaskBase64(result.maskBase64);
      setMessage(`マスク生成完了 (${result.width}×${result.height})`);
    } catch (caught) {
      setError(`マスク生成に失敗しました: ${String(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmMask = async () => {
    if (!inputPath || !previewMaskBase64 || busy) return;
    setBusy("confirm");
    setError(null);
    try {
      const savedMaskPath = await images.writeMask(
        inputPath,
        base64ToBytes(previewMaskBase64),
      );
      setMaskPath(savedMaskPath);
      setMessage("クリック切り抜きマスクを編集マスクに設定しました。");
    } catch (caught) {
      setError(`マスク保存に失敗しました: ${String(caught)}`);
    } finally {
      setBusy(null);
    }
  };

  const previewMaskSrc = previewMaskBase64
    ? `data:image/png;base64,${previewMaskBase64}`
    : null;

  return (
    <EditModelGate required={["samClick"]}>
      <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
        <h3 className="text-sm font-black text-white">クリック切り抜き</h3>
        <p className="mt-2 text-xs font-bold leading-5 text-neutral-500">
          SAM2 でクリックした対象だけをマスク化します。
        </p>

        <div className="mt-4 space-y-3">
          {!embedded ? (
            <button
              type="button"
              onClick={embed}
              disabled={!inputPath || busy !== null}
              className="w-full rounded-lg bg-amber-300 px-3 py-2 text-sm font-black text-black hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "embed" ? "準備中…" : "🎯 クリック切り抜きを準備"}
            </button>
          ) : null}

          {inputPath && embedded ? (
            <div className="rounded-lg border border-[#303030] bg-[#101010] p-2">
              <div className="relative inline-block max-h-[360px] max-w-full overflow-hidden rounded-md align-top">
                <img
                  src={convertFileSrc(inputPath)}
                  alt="クリック切り抜き対象"
                  onClick={onClick}
                  className="block max-h-[360px] max-w-full cursor-crosshair object-contain"
                />
                {previewMaskSrc ? (
                  <img
                    src={previewMaskSrc}
                    alt="生成マスク"
                    className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-60 mix-blend-screen"
                  />
                ) : null}
                {clickPoint ? (
                  <span
                    className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-pink-500 shadow"
                    style={{ left: `${clickPoint.x}%`, top: `${clickPoint.y}%` }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {previewMaskBase64 ? (
            <button
              type="button"
              onClick={confirmMask}
              disabled={busy !== null}
              className="w-full rounded-lg bg-pink-500 px-3 py-2 text-sm font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              {busy === "confirm" ? "設定中…" : "✅ この範囲をマスクに使う"}
            </button>
          ) : null}

          {busy === "predict" ? (
            <p className="text-xs font-bold text-amber-100">decoder 実行中…</p>
          ) : null}
          {message ? <p className="text-xs font-bold text-neutral-300">{message}</p> : null}
          {error ? <p className="text-xs font-bold text-red-300">{error}</p> : null}
        </div>
      </section>
    </EditModelGate>
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
