import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { images as imagesIpc } from "../lib/ipc";
import { useBatches, type BatchWorker } from "../lib/store/batches";
import { useComposer } from "../lib/store/composer";
import { useEditTab } from "../lib/store/editTab";
import { useImages, type GalleryItem } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useThreads } from "../lib/store/threads";
import { EditModelGate } from "./EditModelGate";
import { ClickSegmentTool } from "./edit/ClickSegmentTool";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function basename(path: string) {
  return path.split("/").pop() ?? path;
}

export function EditTabPanel() {
  const selectedImagePath = useEditTab((s) => s.selectedImagePath);
  const maskPath = useEditTab((s) => s.maskPath);
  const instruction = useEditTab((s) => s.instruction);
  const setSelectedImagePath = useEditTab((s) => s.setSelectedImagePath);
  const setMaskPath = useEditTab((s) => s.setMaskPath);
  const setInstruction = useEditTab((s) => s.setInstruction);
  const selectedGalleryPath = useImages((s) => s.selectedPath);
  const images = useImages((s) => s.items);
  const batches = useBatches((s) => s.batches);
  const openMaskEditor = useMaskEditor((s) => s.open);
  const composerMaskPath = useComposer((s) =>
    selectedImagePath
      ? s.references.find((r) => r.path === selectedImagePath)?.maskPath
      : undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedItem = useMemo(
    () => images.find((item) => item.path === selectedImagePath),
    [images, selectedImagePath],
  );
  const recentImages = images.slice(0, 12);
  const latestBatches = batches.slice(-3).reverse();

  useEffect(() => {
    if (composerMaskPath && composerMaskPath !== maskPath) {
      setMaskPath(composerMaskPath);
    }
  }, [composerMaskPath, maskPath, setMaskPath]);

  const pickFile = async () => {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const result = await open({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (typeof result === "string") {
        setSelectedImagePath(result);
      }
    } catch (err) {
      setError(`画像を選べませんでした: ${String(err)}`);
    }
  };

  const useSelectedGalleryImage = () => {
    if (!selectedGalleryPath) return;
    setError(null);
    setSelectedImagePath(selectedGalleryPath);
  };

  const openMask = () => {
    if (!selectedImagePath) return;
    openMaskEditor({
      path: selectedImagePath,
      name: selectedItem?.name ?? basename(selectedImagePath),
    });
  };

  const runEdit = async () => {
    const prompt = instruction.trim();
    if (!selectedImagePath || !maskPath || !prompt || busy) return;

    const threads = useThreads.getState();
    const tempId = `local-edit-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    setBusy(true);
    setError(null);
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt,
      references: [
        {
          path: selectedImagePath,
          name: selectedItem?.name ?? basename(selectedImagePath),
        },
      ],
      count: 1,
    });

    try {
      const result = await imagesIpc.generateBatch({
        prompt,
        count: 1,
        cwd: threads.cwd,
        refImagePaths: [selectedImagePath],
        maskPaths: [maskPath],
        model: threads.selectedModel,
        effort: threads.selectedEffort,
      });
      if (result.failedCount > 0) {
        setError("編集に失敗しました。ログを確認してください。");
      }
    } catch (err) {
      useBatches.getState().removeBatch(tempId);
      setError(`編集に失敗しました: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const canRun = Boolean(selectedImagePath && maskPath && instruction.trim()) && !busy;

  return (
    <div className="grid min-h-full gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-h-[560px] rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-white">編集対象画像</h3>
            <p className="mt-1 truncate text-xs text-neutral-500">
              {selectedImagePath ?? "画像を選んでください"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={useSelectedGalleryImage}
              disabled={!selectedGalleryPath}
              className="rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-xs font-bold text-neutral-200 hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ギャラリー選択を使う
            </button>
            <button
              type="button"
              onClick={pickFile}
              className="rounded-lg bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-600"
            >
              画像を選ぶ
            </button>
          </div>
        </div>

        <div className="flex min-h-[460px] items-center justify-center overflow-hidden rounded-lg border border-[#303030] bg-[#101010]">
          {selectedImagePath ? (
            <img
              src={convertFileSrc(selectedImagePath)}
              alt=""
              className="max-h-[70vh] max-w-full object-contain"
            />
          ) : (
            <div className="text-center text-sm font-bold text-neutral-600">
              編集する画像を選択
            </div>
          )}
        </div>
      </section>

      <aside className="space-y-4">
        <EditModelGate required={["inpaint"]}>
          <section className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4">
            <h3 className="text-sm font-black text-emerald-100">ローカルAIモデル</h3>
            <p className="mt-2 text-xs font-bold text-emerald-50/80">
              背景補完モデルは準備済みです。
            </p>
          </section>
        </EditModelGate>

        <ClickSegmentTool />

        <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <h3 className="text-sm font-black text-white">部分編集</h3>
          <div className="mt-4 space-y-4">
            <div>
              <button
                type="button"
                onClick={openMask}
                disabled={!selectedImagePath}
                className="w-full rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-sm font-black text-neutral-100 hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                マスクを描く
              </button>
              <p className="mt-2 text-xs text-neutral-500">
                {maskPath ? "マスク設定済み" : "白く塗った部分だけを編集します"}
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-bold text-neutral-300">編集指示</span>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={7}
                placeholder="例: 赤い服を青に変える。表情を笑顔にする。"
                className="mt-2 w-full resize-none rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400"
              />
            </label>

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={runEdit}
              disabled={!canRun}
              className="w-full rounded-lg bg-pink-500 px-3 py-3 text-sm font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              {busy ? "編集中…" : "編集を実行"}
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-black text-white">進捗</h3>
            <span className="rounded border border-[#343434] bg-[#101010] px-2 py-1 text-[10px] font-bold text-neutral-500">
              {latestBatches.length} 件
            </span>
          </div>
          <div className="space-y-2">
            {latestBatches.length > 0 ? (
              latestBatches.map((batch) => (
                <BatchProgress key={batch.batchId} workers={batch.workers} />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-8 text-center text-xs font-bold text-neutral-600">
                編集待ち
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-[#2a2a2a] bg-[#181818] p-4">
          <h3 className="text-sm font-black text-white">最近の画像</h3>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {recentImages.map((item) => (
              <GalleryButton
                key={item.path}
                item={item}
                active={item.path === selectedImagePath}
                onClick={() => {
                  setError(null);
                  setSelectedImagePath(item.path);
                }}
              />
            ))}
          </div>
          {recentImages.length === 0 && (
            <div className="mt-3 rounded-lg border border-dashed border-[#343434] bg-[#101010] px-3 py-8 text-center text-xs font-bold text-neutral-600">
              画像がありません
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

function BatchProgress({ workers }: { workers: BatchWorker[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2 rounded-lg border border-[#303030] bg-[#101010] p-2">
      {workers.map((worker) => (
        <div
          key={worker.idx}
          className="flex aspect-square items-center justify-center overflow-hidden rounded-md border border-[#343434] bg-[#181818] text-[10px] font-bold text-neutral-400"
          title={worker.status === "failed" ? worker.error : undefined}
        >
          {worker.status === "completed" ? (
            <img
              src={convertFileSrc(worker.path)}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : worker.status === "failed" ? (
            "失敗"
          ) : (
            "生成中"
          )}
        </div>
      ))}
    </div>
  );
}

function GalleryButton({
  item,
  active,
  onClick,
}: {
  item: GalleryItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`overflow-hidden rounded-lg border bg-[#101010] text-left ${
        active ? "border-pink-400" : "border-[#303030] hover:border-pink-400"
      }`}
      title={item.name}
    >
      <img src={convertFileSrc(item.path)} alt="" className="aspect-square w-full object-cover" />
    </button>
  );
}
