import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { useProductSetRun } from "../../../lib/productSet/store";
import { buildCutPromptFragment, getProductCut } from "../../../lib/productSet/catalog";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useProjects } from "../../../lib/store/projects";
import { useImages } from "../../../lib/store/images";
import { images as imagesIpc } from "../../../lib/ipc";
import { useToasts } from "../../../lib/store/toasts";
import {
  useWorkspace,
  TIMELINE_SIZE_MIN,
  TIMELINE_SIZE_MAX,
  type TimelineSize,
} from "../../../lib/store/workspace";
import type { CutState, MultiAngleParams } from "../../../lib/multiangle/types";
import { GenerationGauge, recordGenerationDuration } from "../../GenerationGauge";

function aspectRatioCss(ratio: string): string {
  const [w, h] = ratio.split(":").map((s) => parseInt(s, 10));
  if (!w || !h) return "1 / 1";
  return `${w} / ${h}`;
}

const COL_BASE: Record<number, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-5 lg:grid-cols-6",
  7: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-7",
  8: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-8",
};

function gridColsClass(size: TimelineSize): string {
  return COL_BASE[size] ?? COL_BASE[4];
}

function ProductSizeSlider() {
  const timelineSize = useWorkspace((s) => s.timelineSize);
  const setTimelineSize = useWorkspace((s) => s.setTimelineSize);
  return (
    <label
      className="inline-flex items-center gap-2 rounded-md border border-[#343434] bg-[#101010] px-2 py-1"
      title="表示を大きく ⇔ 小さく"
    >
      <span className="text-[10px] font-bold text-neutral-500">大</span>
      <input
        type="range"
        min={TIMELINE_SIZE_MIN}
        max={TIMELINE_SIZE_MAX}
        step={1}
        value={timelineSize}
        onChange={(event) => setTimelineSize(Number(event.target.value))}
        className="h-1 w-24 cursor-pointer accent-pink-500"
        aria-label="出力タイルのサイズ"
      />
      <span className="text-[10px] font-bold text-neutral-500">小</span>
      <span className="ml-1 w-5 text-center text-[10px] font-black tabular-nums text-neutral-300">
        {timelineSize}
      </span>
    </label>
  );
}

/**
 * EC納品セット 出力グリッド（右ペイン）
 *
 * 並列生成の進捗をリアルタイム表示。終わったカットから順に画像が出る。
 * 各カット: 拡大 / 再生成 / アクティブプロジェクトへ保存 / ローカル保存。
 * マルチアングルの AngleGridPanel と同型だが、再生成のプロンプトは納品カタログから組む。
 */
export function ProductSetGridPanel({
  onPreview,
}: {
  onPreview?: (path: string, all: string[]) => void;
}) {
  const status = useProductSetRun((s) => s.status);
  const cuts = useProductSetRun((s) => s.cuts);
  const cutOrder = useProductSetRun((s) => s.cutOrder);
  const cutStartedAt = useProductSetRun((s) => s.cutStartedAt);
  const runId = useProductSetRun((s) => s.runId);
  const productImagePath = useProductSetRun((s) => s.productImagePath);
  const productDescription = useProductSetRun((s) => s.productDescription);
  const sceneHint = useProductSetRun((s) => s.sceneHint);
  const aspectRatio = useProductSetRun((s) => s.aspectRatio);
  const selectedCutIds = useProductSetRun((s) => s.selectedCutIds);
  const selectedOutputCutIds = useProductSetRun((s) => s.selectedOutputCutIds);
  const toggleOutputCut = useProductSetRun((s) => s.toggleOutputCut);
  const selectAllCompletedOutputs = useProductSetRun((s) => s.selectAllCompletedOutputs);
  const clearOutputSelection = useProductSetRun((s) => s.clearOutputSelection);

  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const downloadAs = useImages((s) => s.downloadAs);
  const pushToast = useToasts((s) => s.push);
  const timelineSize = useWorkspace((s) => s.timelineSize);

  const tileAspectCss = aspectRatioCss(aspectRatio);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const orderedCuts = cutOrder
    .map((id) => cuts[id])
    .filter((c): c is CutState => Boolean(c));
  const completedPaths = orderedCuts
    .filter((c) => c.status === "completed" && c.imagePath)
    .map((c) => c.imagePath as string);

  const doneCount = orderedCuts.filter((c) => c.status === "completed").length;
  const total = orderedCuts.length;
  const hasRunningCut = orderedCuts.some((c) => c.status === "running");
  const [now, setNow] = useState(() => Date.now());
  const previousStatusesRef = useRef<Record<string, CutState["status"]>>(
    Object.fromEntries(orderedCuts.map((cut) => [cut.cutId, cut.status])),
  );

  useEffect(() => {
    const previousStatuses = previousStatusesRef.current;
    for (const cut of orderedCuts) {
      if (previousStatuses[cut.cutId] === "running" && cut.status === "completed") {
        const startedAt = cutStartedAt[cut.cutId];
        if (startedAt != null) {
          // 生成経路がマルチアングルと同一 (multiangle_run) のため、所要時間ゲージも
          // "multiangle" プロファイルを共用する（時間傾向が同じ）。
          recordGenerationDuration(
            "multiangle",
            Math.max(0, (Date.now() - startedAt) / 1000),
          );
        }
      }
    }
    previousStatusesRef.current = Object.fromEntries(
      orderedCuts.map((cut) => [cut.cutId, cut.status]),
    );
  }, [cuts, cutOrder, cutStartedAt]);

  useEffect(() => {
    if (!hasRunningCut) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunningCut]);

  function saveCutToProject(cut: CutState) {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    if (!cut.imagePath) return;
    addItem(activeProjectId, {
      imagePath: cut.imagePath,
      note: `EC納品セット: ${cut.label}`,
    });
    pushToast({
      kind: "success",
      text: `「${cut.label}」を ${activeProject?.name ?? "プロジェクト"} に保存しました。`,
      ttlMs: 2500,
    });
  }

  function saveAllToProject() {
    if (!activeProjectId) {
      pushToast({
        kind: "info",
        text: "上の「プロジェクト」から保存先の案件を選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    let saved = 0;
    for (const cut of orderedCuts) {
      if (cut.status === "completed" && cut.imagePath) {
        addItem(activeProjectId, {
          imagePath: cut.imagePath,
          note: `EC納品セット: ${cut.label}`,
        });
        saved += 1;
      }
    }
    pushToast({
      kind: saved > 0 ? "success" : "info",
      text:
        saved > 0
          ? `納品セット ${saved} 枚を ${activeProject?.name ?? "プロジェクト"} に保存しました。`
          : "保存できる完成カットがまだありません。",
      ttlMs: 3000,
    });
  }

  async function saveCutToLocal(cut: CutState) {
    if (cut.status !== "completed" || !cut.imagePath) return;
    const ext = cut.imagePath.split(".").pop()?.toLowerCase() || "png";
    const fileName = `${cut.label}.${ext}`.replace(/[\\/:*?"<>|]/g, "_");
    const dest = await downloadAs(cut.imagePath, fileName);
    if (dest) {
      pushToast({
        kind: "success",
        text: `「${cut.label}」をローカルに保存しました。`,
        ttlMs: 2500,
      });
    }
  }

  async function saveSelectedToLocal() {
    const targets = selectedOutputCutIds
      .map((id) => cuts[id])
      .filter(
        (c): c is CutState =>
          Boolean(c) && c.status === "completed" && Boolean(c.imagePath),
      );
    if (targets.length === 0) {
      pushToast({
        kind: "info",
        text: "保存する完成カットを選んでください。",
        ttlMs: 3000,
      });
      return;
    }
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "納品セットの保存先フォルダを選択",
      });
      if (typeof dir !== "string") return;

      let saved = 0;
      const used = new Set<string>();
      for (const cut of targets) {
        const src = cut.imagePath as string;
        const ext = src.split(".").pop()?.toLowerCase() || "png";
        const base = `${cut.label}`.replace(/[\\/:*?"<>|]/g, "_");
        let name = `${base}.${ext}`;
        let n = 2;
        while (used.has(name)) {
          name = `${base}_${n}.${ext}`;
          n += 1;
        }
        used.add(name);
        try {
          await imagesIpc.saveAs(src, `${dir}/${name}`);
          saved += 1;
        } catch (err) {
          console.warn("productSet local save failed", { src, error: err });
        }
      }
      pushToast({
        kind: saved > 0 ? "success" : "error",
        text:
          saved > 0
            ? `納品セット ${saved} 枚をローカルに保存しました。`
            : "保存できませんでした。",
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `一括保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    }
  }

  async function regenerateCut(cut: CutState) {
    if (!runId || !productImagePath) return;
    const productCut = getProductCut(cut.cutId);
    if (!productCut) return;

    // 単一カット再生成でも full params を渡す（Rust は cut_prompts から該当カットを引く）。
    const cutPrompts = selectedCutIds
      .map((id) => getProductCut(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => ({
        cutId: c.id,
        label: c.label,
        promptFragment: buildCutPromptFragment(c, productDescription, sceneHint),
      }));

    const params: MultiAngleParams = {
      characterImage: productImagePath,
      environmentDescription: sceneHint,
      aspectRatio,
      cutIds: selectedCutIds,
      cutPrompts,
      // 再生成も商品向けプロンプト(ラベル・ロゴ維持)を使う。
      subjectKind: "product",
    };

    try {
      await invoke<string>("multiangle_regenerate_cut", {
        runId,
        cutId: cut.cutId,
        params,
      });
      pushToast({ kind: "info", text: `「${cut.label}」を再生成中…`, ttlMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `再生成に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  const selectedCount = selectedOutputCutIds.filter((id) => {
    const c = cuts[id];
    return c?.status === "completed" && Boolean(c.imagePath);
  }).length;
  const allSelected = doneCount > 0 && selectedCount >= doneCount;

  if (status === "idle" || orderedCuts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-neutral-500">
        <div className="text-3xl">📸</div>
        <p className="text-[13px] font-bold">商品写真1枚と納品カットを選んで「生成」を押すと</p>
        <p className="text-[12px]">白背景・シーン・ディテールの納品一式がセットで出てきます</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 上部バー: 進捗 + 保存 */}
      <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
        <div className="text-[12px] font-bold text-neutral-300">
          {status === "running" ? "納品セット生成中…" : "生成完了"}{" "}
          <span className="text-neutral-500">
            ({doneCount}/{total})
          </span>
          {activeProject && (
            <span className="text-neutral-500"> · 保存先: {activeProject.name}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {doneCount > 0 && (
            <>
              <button
                type="button"
                onClick={() =>
                  allSelected ? clearOutputSelection() : selectAllCompletedOutputs()
                }
                title="完成カットを全部選ぶ / 選択を解除"
                className="rounded-lg border border-[#343434] px-2.5 py-1.5 text-[12px] font-bold text-neutral-300 transition hover:border-emerald-400 hover:text-white"
              >
                {allSelected ? "選択解除" : "全選択"}
              </button>
              <button
                type="button"
                onClick={() => void saveSelectedToLocal()}
                disabled={selectedCount === 0}
                title="選択した画像をフォルダを選んでローカルに保存"
                className={
                  "rounded-lg px-3 py-1.5 text-[12px] font-bold transition " +
                  (selectedCount === 0
                    ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                    : "bg-emerald-600 text-white hover:bg-emerald-500")
                }
              >
                {selectedCount > 0
                  ? `💾 ローカルに保存 (${selectedCount})`
                  : "💾 ローカルに保存"}
              </button>
            </>
          )}
          <ProductSizeSlider />
          <button
            type="button"
            onClick={saveAllToProject}
            disabled={doneCount === 0}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition ${
              doneCount === 0
                ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                : "bg-[#101010] text-neutral-200 hover:bg-pink-500/20 hover:text-pink-100"
            }`}
          >
            納品セットを案件へ
          </button>
        </div>
      </div>

      {/* 出力タイル */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className={`grid gap-3 ${gridColsClass(timelineSize)}`}>
          {orderedCuts.map((cut) => (
            <div
              key={cut.cutId}
              className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]"
            >
              <div
                className={
                  "relative w-full bg-[#0d0d0d] " +
                  (selectedOutputCutIds.includes(cut.cutId)
                    ? "ring-2 ring-emerald-400"
                    : "")
                }
                style={{ aspectRatio: tileAspectCss }}
              >
                {cut.status === "completed" && cut.imagePath && (
                  <button
                    type="button"
                    onClick={() => toggleOutputCut(cut.cutId)}
                    title="選択 (ローカルに一括保存する対象にする)"
                    className={
                      "absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md border text-[13px] font-black transition " +
                      (selectedOutputCutIds.includes(cut.cutId)
                        ? "border-emerald-400 bg-emerald-500 text-white"
                        : "border-white/40 bg-black/50 text-transparent hover:text-white/60")
                    }
                  >
                    ✓
                  </button>
                )}
                {cut.status === "completed" && cut.imagePath ? (
                  <img
                    src={convertFileSrc(cut.imagePath)}
                    alt={cut.label}
                    className="h-full w-full cursor-pointer object-contain"
                    onClick={() =>
                      onPreview?.(cut.imagePath as string, completedPaths)
                    }
                  />
                ) : cut.status === "failed" ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center text-[11px] text-red-300">
                    <span>生成失敗</span>
                    {cut.reason && (
                      <span className="text-[9px] text-neutral-500 line-clamp-2">
                        {cut.reason}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-4">
                    <div
                      className={`flex w-full max-w-40 flex-col items-center gap-2 text-[11px] font-bold ${
                        cut.status === "running"
                          ? "animate-pulse text-pink-300"
                          : "text-neutral-600"
                      }`}
                    >
                      {cut.status === "running"
                        ? `生成中… ${Math.max(
                            0,
                            Math.floor((now - (cutStartedAt[cut.cutId] ?? now)) / 1000),
                          )}秒`
                        : "待機中"}
                      {cut.status === "running" && cutStartedAt[cut.cutId] != null && (
                        <GenerationGauge
                          startedAt={cutStartedAt[cut.cutId]}
                          mode="multiangle"
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5 px-2 py-2">
                <div className="truncate text-[11px] font-bold text-neutral-200">
                  {cut.label}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => regenerateCut(cut)}
                    disabled={status === "running" && cut.status === "running"}
                    className="flex-1 rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                  >
                    再生成
                  </button>
                  <button
                    type="button"
                    onClick={() => saveCutToProject(cut)}
                    disabled={cut.status !== "completed"}
                    title="アクティブな案件(プロジェクト)に保存"
                    className="flex-1 rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                  >
                    案件へ
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveCutToLocal(cut)}
                    disabled={cut.status !== "completed"}
                    title="名前を付けてローカルに保存"
                    className="flex-1 rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-emerald-400/60 hover:text-white disabled:opacity-40"
                  >
                    ⤓ ローカル
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
