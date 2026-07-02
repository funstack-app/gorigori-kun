import { useEffect } from "react";

import { editMagic } from "../../lib/ipc";
import { listenEditMagicProgress } from "../../lib/edit/events";
import type { MagicLayerProgress } from "../../lib/edit/types";
import { useEditMagic } from "../../lib/store/editMagic";
import { EditModelGate } from "../EditModelGate";

const PROGRESS_LABELS: Record<string, string> = {
  started: "開始しました…",
  detectingText: "テキストを検出中…",
  removingText: "テキストを消去中…",
  segmenting: "人物を切り抜き中…",
  inpaintingBackground: "背景を補完中…",
  buildingTextLayers: "編集可能レイヤーを構築中…",
  completed: "完了しました",
  failed: "失敗しました",
};

type MagicLayerPanelProps = {
  inputPath: string | null;
  projectName?: string | null;
};

export function MagicLayerPanel({ inputPath, projectName }: MagicLayerPanelProps) {
  const progress = useEditMagic((s) => s.progress);
  const result = useEditMagic((s) => s.result);
  const running = useEditMagic((s) => s.running);
  const error = useEditMagic((s) => s.error);
  const setProgress = useEditMagic((s) => s.setProgress);
  const setResult = useEditMagic((s) => s.setResult);
  const setRunning = useEditMagic((s) => s.setRunning);
  const setError = useEditMagic((s) => s.setError);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenEditMagicProgress((payload: MagicLayerProgress) => {
      setProgress(payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [setProgress]);

  const run = async () => {
    if (!inputPath || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setProgress({ kind: "started" });
    try {
      const r = await editMagic.run(inputPath, projectName);
      setResult(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  const label = progress ? PROGRESS_LABELS[progress.kind] ?? progress.kind : "";

  return (
    <EditModelGate required={["ocr", "inpaint", "segment"]}>
      <section className="space-y-3 rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-neutral-100">
              Magic Layer
            </h3>
            <p className="mt-1 text-[11px] text-neutral-500">
              テキスト検出 → 消去 → 切り抜き → 背景補完 を1クリックで自動実行
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={!inputPath || running}
            className="rounded-lg bg-pink-500 px-4 py-2 text-sm font-black text-white shadow hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {running ? "実行中…" : "Magic Layer 実行"}
          </button>
        </div>

        {progress && (
          <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-xs font-bold text-neutral-200">
            {label}
            {progress.kind === "failed" && (
              <div className="mt-1 text-[11px] text-red-300">
                {progress.reason}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2 rounded-lg border border-pink-400/40 bg-pink-500/5 p-3">
            <p className="text-xs font-bold text-pink-100">
              分解完了 ({result.textLayers.length}件のテキスト検出)
            </p>
            <div className="grid grid-cols-3 gap-2 text-[10px] text-neutral-300">
              <div>
                <span className="font-bold">背景:</span>
                <p className="truncate text-neutral-500">{result.backgroundPath}</p>
              </div>
              <div>
                <span className="font-bold">前景:</span>
                <p className="truncate text-neutral-500">{result.foregroundPath}</p>
              </div>
              <div>
                <span className="font-bold">マスク:</span>
                <p className="truncate text-neutral-500">{result.maskPath}</p>
              </div>
            </div>
          </div>
        )}
      </section>
    </EditModelGate>
  );
}
