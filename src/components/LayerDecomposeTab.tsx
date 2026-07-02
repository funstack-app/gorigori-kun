import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";

import { editSegment } from "../lib/ipc";
import type { SegmentResult } from "../lib/edit/types";
import { useActiveProject } from "../lib/store/activeProject";
import { useProjects } from "../lib/store/projects";
import { useToasts } from "../lib/store/toasts";
import { EditModelGate } from "./EditModelGate";
import { LayerPanel } from "./edit/LayerPanel";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

function imageSrc(path: string): string {
  return convertFileSrc(path);
}

export function LayerDecomposeTab() {
  const [imagePath, setImagePath] = useState("");
  const [result, setResult] = useState<SegmentResult | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeProjectId = useActiveProject((state) => state.activeProjectId);
  const projects = useProjects((state) => state.projects);
  const pushToast = useToasts((state) => state.push);

  const activeProjectName = useMemo(
    () =>
      activeProjectId
        ? projects.find((project) => project.id === activeProjectId)?.name ?? null
        : null,
    [activeProjectId, projects],
  );

  async function handleChooseImage() {
    setMessage(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (typeof selected !== "string") return;
      setImagePath(selected);
      setResult(null);
    } catch (error) {
      const text = `画像選択に失敗しました: ${String(error)}`;
      setMessage(text);
      pushToast({ kind: "error", text });
    }
  }

  async function run() {
    const inputPath = imagePath.trim();
    if (!inputPath) {
      setMessage("対象画像を選択してください。");
      return;
    }

    setRunning(true);
    setMessage("BiRefNet で切り抜き中...");
    try {
      const nextResult = await editSegment.run(inputPath, activeProjectName);
      setResult(nextResult);
      setMessage("切り抜きが完了しました。");
      pushToast({ kind: "success", text: "切り抜きが完了しました。" });
    } catch (error) {
      const text = `切り抜き失敗: ${String(error)}`;
      setMessage(text);
      pushToast({ kind: "error", text });
    } finally {
      setRunning(false);
    }
  }

  return (
    <EditModelGate required={["segment"]}>
      <div className="flex h-full min-h-0 flex-col gap-5 bg-[#0f0f0f] p-5 text-zinc-100">
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-5">
          <section className="flex min-h-0 flex-col rounded-lg border border-zinc-800 bg-[#161616]">
            <div className="border-b border-zinc-800 px-4 py-3">
              <h2 className="text-base font-semibold text-zinc-100">
                BiRefNet 切り抜き
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                前景PNG・背景ソース・マスクPNGをローカル生成します。
              </p>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              {imagePath.trim() ? (
                <img
                  src={imageSrc(imagePath.trim())}
                  alt="対象画像"
                  className="max-h-full max-w-full rounded-md border border-zinc-800 bg-[#0a0a0a] object-contain"
                />
              ) : (
                <div className="flex h-full min-h-80 w-full items-center justify-center rounded-md border border-dashed border-zinc-700 bg-[#0a0a0a] text-sm text-zinc-500">
                  対象画像を選択
                </div>
              )}
            </div>
          </section>

          <aside className="flex flex-col gap-4 rounded-lg border border-zinc-800 bg-[#161616] p-4">
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium text-zinc-300">対象画像</div>
              <button
                type="button"
                onClick={handleChooseImage}
                disabled={running}
                className="rounded-md border border-zinc-700 bg-[#0b0b0b] px-4 py-2 text-sm font-semibold text-zinc-100 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                画像を選ぶ
              </button>
              <div className="min-h-10 rounded-md border border-zinc-800 bg-[#0f0f0f] px-3 py-2 text-xs text-zinc-400">
                {imagePath ? (
                  <span className="break-all">{imagePath}</span>
                ) : (
                  <span className="text-zinc-600">未選択</span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-zinc-800 bg-[#0f0f0f] p-3 text-sm text-zinc-400">
              <div className="font-medium text-zinc-200">切り抜き (BiRefNet)</div>
              <div className="mt-1">
                1024px入力 + ImageNet正規化で前景マスクを推論します。
              </div>
              {activeProjectName ? (
                <div className="mt-2 text-xs text-zinc-500">
                  保存先プロジェクト: {activeProjectName}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={run}
              disabled={running || !imagePath.trim()}
              className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            >
              {running ? "切り抜き中..." : "✂️ 切り抜き実行 (BiRefNet)"}
            </button>

            {message ? (
              <div className="rounded-md border border-zinc-800 bg-[#0f0f0f] p-3 text-sm text-zinc-300">
                {message}
              </div>
            ) : null}
          </aside>
        </div>

        {result ? (
          <div className="min-h-0 rounded-lg border border-zinc-800 bg-[#181818]">
            <LayerPanel
              foregroundPath={result.foregroundPath}
              backgroundPath={result.backgroundPath}
              maskPath={result.maskPath}
            />
          </div>
        ) : null}
      </div>
    </EditModelGate>
  );
}

export default LayerDecomposeTab;
