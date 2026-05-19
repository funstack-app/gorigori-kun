import { useMemo } from "react";

import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useProjects } from "../../../lib/store/projects";
import { useToasts } from "../../../lib/store/toasts";
import { sendImageToPlanForRediscuss } from "../../../lib/sendToPlan";

/**
 * Phase 4: CutGridReview
 *
 * STΛCK 指示 (2026-05-20):
 *   - 完成カットを並べて最終確認
 *   - 各カットごとに「採用 take の切替」「やり直し」「企画で再検討」「プロジェクトに保存」
 *   - 全カット一括で「プロジェクトに保存」も用意
 *   - 上部に参照画像 (キャラ・スタイル) を表示し続けて一貫性確認
 */
export function CutGridReviewPanel() {
  const goal = useStoryboardRun((s) => s.goal);
  const cuts = useStoryboardRun((s) => s.cuts);
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const selectTake = useStoryboardRun((s) => s.selectTake);
  const regenerateCut = useStoryboardRun((s) => s.regenerateCut);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);

  const orderedCuts = useMemo(() => Array.from(cuts.values()), [cuts]);
  const confirmedAll = orderedCuts.every((c) => c.status === "confirmed");
  const allTakeImages = useMemo(
    () =>
      orderedCuts
        .map((c) => {
          const adopted = c.takes.find((t) => t.takeId === c.selectedTakeId);
          return adopted?.imagePath ?? c.takes[0]?.imagePath;
        })
        .filter((p): p is string => Boolean(p)),
    [orderedCuts],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  function saveAllToProject() {
    if (!activeProjectId) {
      useToasts.getState().push({
        kind: "error",
        text: "保存先プロジェクトが選ばれていません。",
        ttlMs: 4000,
      });
      return;
    }
    let saved = 0;
    orderedCuts.forEach((c, i) => {
      const adopted = c.takes.find((t) => t.takeId === c.selectedTakeId) ?? c.takes[0];
      if (!adopted) return;
      addItem(activeProjectId, {
        imagePath: adopted.imagePath,
        prompt: goal?.summary,
        note: `storyboard cut ${i + 1} (${c.cutId})`,
      });
      saved += 1;
    });
    useToasts.getState().push({
      kind: "success",
      text: `${saved} カットをプロジェクトに保存しました。`,
      ttlMs: 3000,
    });
  }

  function saveCutToProject(cutId: string, imagePath: string, order: number) {
    if (!activeProjectId) {
      useToasts.getState().push({
        kind: "error",
        text: "保存先プロジェクトが選ばれていません。",
        ttlMs: 4000,
      });
      return;
    }
    addItem(activeProjectId, {
      imagePath,
      prompt: goal?.summary,
      note: `storyboard cut ${order} (${cutId})`,
    });
    useToasts.getState().push({
      kind: "success",
      text: `Cut ${order} を保存しました。`,
      ttlMs: 2500,
    });
  }

  if (!goal) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">先にゴールを確定してください。</div>
      </div>
    );
  }

  if (orderedCuts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">生成完了カットがまだありません。</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Phase 4: 最終確認</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {orderedCuts.length} カット
            {confirmedAll ? " · 全カット採用済み" : " · 一部 take を切り替え可能"}
            {activeProject && ` · 保存先: ${activeProject.name}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setPhase("generation")}
            className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
          >
            ← 生成に戻る
          </button>
          <button
            type="button"
            onClick={saveAllToProject}
            className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-400"
          >
            一括でプロジェクトに保存
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orderedCuts.map((c, i) => {
            const adopted =
              c.takes.find((t) => t.takeId === c.selectedTakeId) ?? c.takes[0];
            if (!adopted) return null;
            return (
              <li
                key={c.cutId}
                className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#1a1a1a] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
                    Cut {i + 1}
                  </span>
                  <span
                    className={[
                      "text-[11px]",
                      c.status === "confirmed" ? "text-emerald-300" : "text-zinc-400",
                    ].join(" ")}
                  >
                    {c.status === "confirmed" ? "採用済み" : "未採用"}
                  </span>
                </div>

                <div className="aspect-video overflow-hidden rounded-md bg-[#0d0d0d]">
                  <img
                    src={`asset://localhost/${encodeURI(adopted.imagePath)}`}
                    alt={`cut-${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                </div>

                {c.takes.length > 1 && (
                  <div className="flex gap-1">
                    {c.takes.map((t, ti) => (
                      <button
                        type="button"
                        key={t.takeId}
                        onClick={() => selectTake(c.cutId, t.takeId)}
                        className={[
                          "h-12 w-16 overflow-hidden rounded border",
                          t.takeId === (c.selectedTakeId ?? c.takes[0]?.takeId)
                            ? "border-pink-500"
                            : "border-[#2a2a2a]",
                        ].join(" ")}
                        title={`take ${ti + 1}`}
                      >
                        <img
                          src={`asset://localhost/${encodeURI(t.imagePath)}`}
                          alt={`take-${ti + 1}`}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1">
                  {c.status !== "confirmed" && (
                    <button
                      type="button"
                      onClick={() => adoptTake(c.cutId)}
                      className="rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-[10px] text-pink-200 hover:bg-pink-500/20"
                    >
                      採用
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => regenerateCut(c.cutId)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    やり直し
                  </button>
                  <button
                    type="button"
                    onClick={() => sendImageToPlanForRediscuss(adopted.imagePath)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    企画で再検討
                  </button>
                  <button
                    type="button"
                    onClick={() => saveCutToProject(c.cutId, adopted.imagePath, i + 1)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    1 枚保存
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {allTakeImages.length > 0 && (
        <footer className="rounded-md border border-[#242424] bg-[#161616] px-3 py-2 text-[11px] text-zinc-500">
          完成セット: {allTakeImages.length} 枚 / {orderedCuts.length} カット
        </footer>
      )}
    </div>
  );
}
