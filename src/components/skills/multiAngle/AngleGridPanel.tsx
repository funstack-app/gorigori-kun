import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { useMultiAngleRun } from "../../../lib/store/multiAngleRun";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useProjects } from "../../../lib/store/projects";
import { useToasts } from "../../../lib/store/toasts";
import { getAngleCut } from "../../../lib/multiangle/angles";
import type { CutState, MultiAngleParams } from "../../../lib/multiangle/types";

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
  const runId = useMultiAngleRun((s) => s.runId);
  const characterImagePath = useMultiAngleRun((s) => s.characterImagePath);
  const environmentDescription = useMultiAngleRun((s) => s.environmentDescription);
  const aspectRatio = useMultiAngleRun((s) => s.aspectRatio);
  const selectedCutIds = useMultiAngleRun((s) => s.selectedCutIds);

  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  const pushToast = useToasts((s) => s.push);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const orderedCuts = cutOrder
    .map((id) => cuts[id])
    .filter((c): c is CutState => Boolean(c));
  const completedPaths = orderedCuts
    .filter((c) => c.status === "completed" && c.imagePath)
    .map((c) => c.imagePath as string);

  const doneCount = orderedCuts.filter((c) => c.status === "completed").length;
  const total = orderedCuts.length;

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

      {/* グリッド */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {orderedCuts.map((cut) => (
            <div
              key={cut.cutId}
              className="flex flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]"
            >
              <div className="relative aspect-square w-full bg-[#0d0d0d]">
                {cut.status === "completed" && cut.imagePath ? (
                  <img
                    src={convertFileSrc(cut.imagePath)}
                    alt={cut.label}
                    className="h-full w-full cursor-pointer object-cover"
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
                      {cut.status === "running" ? "生成中…" : "待機中"}
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
                    className="flex-1 rounded-md border border-[#343434] px-1.5 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400/60 hover:text-white disabled:opacity-40"
                  >
                    保存
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
