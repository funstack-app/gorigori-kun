import { useMemo } from "react";

import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import type { StoryboardPhase } from "../../../lib/storyboard/types";

const PHASES: Array<{ id: StoryboardPhase; label: string; subLabel: string }> = [
  { id: "goal", label: "1. 目標", subLabel: "AIと深掘り" },
  { id: "sketch", label: "2. 絵コンテ", subLabel: "カット案レビュー" },
  { id: "generation", label: "3. 生成", subLabel: "順次描画中" },
  { id: "review", label: "4. 確認", subLabel: "最終チェック" },
];

/**
 * Phase レール。
 * 現在 Phase の左側に縦並びで表示する。
 *
 * 設計方針:
 *   - 戻れる Phase はクリックで遷移可能 (ユーザー駆動で巻き戻し OK)
 *   - 進めない Phase はグレーアウト (前提条件不足)
 */
export function PhaseRail() {
  const phase = useStoryboardRun((s) => s.phase);
  const goal = useStoryboardRun((s) => s.goal);
  const sketchVersions = useStoryboardRun((s) => s.sketchVersions);
  const totalCuts = useStoryboardRun((s) => s.totalCuts);
  const cuts = useStoryboardRun((s) => s.cuts);
  const runStatus = useStoryboardRun((s) => s.status);
  const setPhase = useStoryboardRun((s) => s.setPhase);

  // 生成進捗 (Phase 3 の最中に PhaseRail のゲージで表示)
  const { completedCuts, knownTotal } = useMemo(() => {
    const list = Array.from(cuts.values());
    const done = list.filter((c) => c.status === "confirmed" || c.status === "review").length;
    return { completedCuts: done, knownTotal: totalCuts || list.length };
  }, [cuts, totalCuts]);

  function canEnter(target: StoryboardPhase): boolean {
    switch (target) {
      case "goal":
        return true;
      case "sketch":
        return goal !== null;
      case "generation":
        return sketchVersions.length > 0;
      case "review":
        return totalCuts > 0;
    }
  }

  return (
    <nav className="flex h-full w-44 shrink-0 flex-col gap-2 border-r border-[#242424] bg-[#161616] px-3 py-4">
      {PHASES.map((p) => {
        const active = phase === p.id;
        const enabled = canEnter(p.id);
        const isGeneration = p.id === "generation";
        const generationDone = runStatus === "completed";
        const generationActive = isGeneration && active;
        const progressPercent =
          knownTotal > 0 ? Math.min(100, (completedCuts / knownTotal) * 100) : 0;

        // 生成 Phase は専用表示にする
        if (isGeneration && (generationActive || generationDone)) {
          return (
            <div
              key={p.id}
              className={[
                "flex flex-col gap-1.5 rounded-md border px-3 py-2",
                generationDone
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-pink-500 bg-pink-500/10 text-pink-200",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">
                  {generationDone ? "3. 生成 ✓" : "3. 生成中"}
                </span>
                <span className="text-[10px] opacity-80">
                  {knownTotal > 0 ? `${completedCuts}/${knownTotal}` : "—"}
                </span>
              </div>
              {/* プログレスバー */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0d0d0d]">
                <div
                  className={[
                    "h-full transition-all duration-500",
                    generationDone ? "bg-emerald-400" : "bg-pink-400",
                  ].join(" ")}
                  style={{ width: `${generationDone ? 100 : progressPercent}%` }}
                />
              </div>
              <span className="text-[11px] opacity-80">
                {generationDone ? "全カット完了" : "順次描画中…"}
              </span>
            </div>
          );
        }

        return (
          <button
            type="button"
            key={p.id}
            disabled={!enabled}
            onClick={() => setPhase(p.id)}
            className={[
              "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition",
              active
                ? "border-pink-500 bg-pink-500/10 text-pink-200"
                : enabled
                  ? "border-[#2a2a2a] bg-transparent text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
                  : "cursor-not-allowed border-[#1f1f1f] bg-transparent text-zinc-600",
            ].join(" ")}
          >
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="text-[11px] text-zinc-500">{p.subLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}
