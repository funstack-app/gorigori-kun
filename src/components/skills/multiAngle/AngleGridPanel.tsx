import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { useMultiAngleRun } from "../../../lib/store/multiAngleRun";
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
import { getAngleCut } from "../../../lib/multiangle/angles";
import type { CutState, MultiAngleParams } from "../../../lib/multiangle/types";

/**
 * 選択中アスペクト比 ("3:4" 等) を CSS の aspect-ratio 値 ("3 / 4") に変換する。
 * 不正値はフォールバックで正方形 (1 / 1)。
 */
function aspectRatioCss(ratio: string): string {
  const [w, h] = ratio.split(":").map((s) => parseInt(s, 10));
  if (!w || !h) return "1 / 1";
  return `${w} / ${h}`;
}

/**
 * 数値サイズ (timelineSize 2-8) からグリッド列数の Tailwind クラスへ。
 * GenerationWorkspace.gridColsClass と同じ写像。Tailwind は静的解析のため
 * grid-cols-N を事前に書き出しておく。小さい size = 列少 = タイル大。
 */
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

/**
 * サイズ調整スライダー (大 ⇔ 小)。通常制作画面の TimelineSizeToggle と同じ
 * useWorkspace.timelineSize を共用し、挙動・見た目を揃える (STΛCK 指示 2026-06-09)。
 */
function AngleSizeSlider() {
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
 * マルチアングル出力グリッド（右ペイン）
 *
 * 並列生成の進捗をリアルタイム表示。終わったカットから順に画像が出る。
 * 各カット: 拡大 / 再生成 / アクティブプロジェクトへ保存。
 *
 * プロジェクト横断性（ユーザー最重要要件）:
 *   上部の ActiveProjectSelector で選んだ案件に、各カットを addItem で放り込む。
 *   storyboard の CutGridReviewPanel と同じパターン。
 */
export function AngleGridPanel({
  onPreview,
}: {
  onPreview?: (path: string, all: string[]) => void;
}) {
  const status = useMultiAngleRun((s) => s.status);
  const cuts = useMultiAngleRun((s) => s.cuts);
  const cutOrder = useMultiAngleRun((s) => s.cutOrder);
  const cutStartedAt = useMultiAngleRun((s) => s.cutStartedAt);
  const runId = useMultiAngleRun((s) => s.runId);
  const characterImagePath = useMultiAngleRun((s) => s.characterImagePath);
  const environmentDescription = useMultiAngleRun((s) => s.environmentDescription);
  const aspectRatio = useMultiAngleRun((s) => s.aspectRatio);
  const selectedCutIds = useMultiAngleRun((s) => s.selectedCutIds);
  const selectedOutputCutIds = useMultiAngleRun((s) => s.selectedOutputCutIds);
  const toggleOutputCut = useMultiAngleRun((s) => s.toggleOutputCut);
  const selectAllCompletedOutputs = useMultiAngleRun((s) => s.selectAllCompletedOutputs);
  const clearOutputSelection = useMultiAngleRun((s) => s.clearOutputSelection);

  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const downloadAs = useImages((s) => s.downloadAs);
  const pushToast = useToasts((s) => s.push);
  const timelineSize = useWorkspace((s) => s.timelineSize);

  // 選択中アスペクト比を CSS 値に。各タイルのプレビュー枠をこの比率にする。
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
      note: `マルチアングル: ${cut.label}`,
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
          note: `マルチアングル: ${cut.label}`,
        });
        saved += 1;
      }
    }
    pushToast({
      kind: saved > 0 ? "success" : "info",
      text:
        saved > 0
          ? `${saved} 枚を ${activeProject?.name ?? "プロジェクト"} に保存しました。`
          : "保存できる完成カットがまだありません。",
      ttlMs: 3000,
    });
  }

  /**
   * 1 枚をローカルに「名前を付けて保存」。ライブラリの保存と同じ要領 (useImages.downloadAs)。
   * プロジェクト保存とは別系統で、画像ファイルそのものをローカルに書き出す。
   */
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
    // dest が null = キャンセル or 失敗。downloadAs 内でログ済みなので無通知。
  }

  /**
   * 選択中の完成カットを「フォルダを選んでローカルに一括保存」。ライブラリの
   * LibraryBatchSaveButton と同じ要領 (フォルダ選択 → imagesIpc.saveAs で連番コピー)。
   */
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
        title: "保存先フォルダを選択",
      });
      if (typeof dir !== "string") return; // キャンセル

      let saved = 0;
      const used = new Set<string>();
      for (const cut of targets) {
        const src = cut.imagePath as string;
        const ext = src.split(".").pop()?.toLowerCase() || "png";
        const base = `${cut.label}`.replace(/[\\/:*?"<>|]/g, "_");
        // 同名ラベル衝突は連番フォールバック (上書き事故防止)
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
          console.warn("multiangle local save failed", { src, error: err });
        }
      }
      pushToast({
        kind: saved > 0 ? "success" : "error",
        text:
          saved > 0
            ? `${saved} 枚をローカルに保存しました。`
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
    if (!runId || !characterImagePath) return;
    const angleCut = getAngleCut(cut.cutId);
    if (!angleCut) return;

    const params: MultiAngleParams = {
      characterImage: characterImagePath,
      environmentDescription,
      aspectRatio,
      cutIds: selectedCutIds,
      cutPrompts: selectedCutIds
        .map((id) => getAngleCut(id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => ({ cutId: c.id, label: c.label, promptFragment: c.promptFragment })),
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

  // 出力選択の派生値。完成済みカットだけが「実際に保存できる選択」。
  // 再生成で completed→running に戻ったカットが選択に残っても、カウントは
  // 完成済みのみで数える（ボタンの (N) と実保存枚数を一致させる。evaluator 指摘 2026-06-09）。
  const selectedCount = selectedOutputCutIds.filter((id) => {
    const c = cuts[id];
    return c?.status === "completed" && Boolean(c.imagePath);
  }).length;
  const allSelected = doneCount > 0 && selectedCount >= doneCount;

  if (status === "idle" || orderedCuts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-neutral-500">
        <div className="text-3xl">📐</div>
        <p className="text-[13px] font-bold">構図を選んで「一気に生成」を押すと</p>
        <p className="text-[12px]">参照画像のキャラがいろんなアングルで出てきます</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 上部バー: 進捗 + 全保存 */}
      <div className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
        <div className="text-[12px] font-bold text-neutral-300">
          {status === "running" ? "並列生成中…" : "生成完了"}{" "}
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
          <AngleSizeSlider />
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
            全部プロジェクトへ保存
          </button>
        </div>
      </div>

      {/* 出力タイル: 列数はサイズスライダー連動、各タイルは選択アスペクト比で表示 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className={`grid gap-3 ${gridColsClass(timelineSize)}`}>
          {orderedCuts.map((cut) => (
            <div
              key={cut.cutId}
              className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]"
            >
              {/*
                STΛCK 指示 (2026-06-09): グリッド固定 (aspect-square) をやめ、選択中の
                アスペクト比でプレビュー枠を表示。画像は object-contain で枠内に歪めず収める
                (実際の生成比率が選択とズレても見切れない)。
              */}
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
                  <div className="flex h-full w-full items-center justify-center">
                    <div
                      className={`text-[11px] font-bold ${
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
