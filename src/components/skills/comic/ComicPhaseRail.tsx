import type { ComicPhase } from "../../../lib/comic/types";

/**
 * 漫画制作の Phase レール。
 *
 * 絵コンテ (storyboard/PhaseRail.tsx) の視覚文法をコピーして漫画専用に作る。
 * storyboard/PhaseRail を import しないのは、あちらが storyboardRun/planChat
 * ストアへ結線されているため（他スキルのファイルにも触れない）。
 * ここは props 駆動の純表示部品にする。
 *
 * フェーズ列は1本（input / plan / pages）。旧・詳細編集（コマ別）のレールは
 * 経路ごと撤去した (2026-07-28 STΛCK指示)。
 */
const RAIL_PHASES: Array<{ id: ComicPhase; label: string; subLabel: string }> = [
  { id: "input", label: "1. 話とキャラ", subLabel: "あらすじ・ページ数" },
  { id: "plan", label: "2. 構成の確認", subLabel: "ページ割りとセリフ" },
  { id: "pages", label: "3. ページ生成", subLabel: "並列生成・保存" },
];

/** 進捗タイルにするフェーズ（生成フェーズ）。 */
const GENERATING_PHASE: ComicPhase = "pages";
const GENERATING_LABEL = "3. ページ生成中";

export function ComicPhaseRail({
  phase,
  setPhase,
  hasStory,
  generating,
  completed,
  total,
}: {
  phase: ComicPhase;
  setPhase: (p: ComicPhase) => void;
  /** storyPages.length > 0（plan/pages の入場条件）。 */
  hasStory: boolean;
  /** generatingPages || pageResults.some(r => r.generating) */
  generating: boolean;
  /** pageResults.filter(r => r.imagePath).length */
  completed: number;
  /** storyPages.length */
  total: number;
}) {
  const progressPercent = total > 0 ? Math.min(100, (completed / total) * 100) : 0;

  return (
    <nav
      data-tour="comic-phases"
      className="flex h-full w-44 shrink-0 flex-col gap-2 border-r border-[#242424] bg-[#161616] px-3 py-4"
    >
      {RAIL_PHASES.map((p) => {
        const active = phase === p.id;
        // 入場可否は旧 PhaseNav の disabled 条件をそのまま移植する（ロジック追加なし）。
        const enabled = p.id === "input" || hasStory;

        // 生成中も進捗タイルのままクリックで戻れるようにする。
        // 以前は非クリックの div で、構成の確認へ移動すると生成画面へ
        // 戻る経路が無くなる一方通行だった（STΛCK 実機報告 2026-08-06）。
        if (p.id === GENERATING_PHASE && generating) {
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => setPhase(p.id)}
              title="生成の進捗画面へ戻る"
              className={[
                "flex flex-col gap-1.5 rounded-md border px-3 py-2 text-left text-pink-200 transition",
                active
                  ? "border-pink-500 bg-pink-500/10"
                  : "border-pink-500/50 bg-pink-500/5 hover:border-pink-500 hover:bg-pink-500/10",
              ].join(" ")}
            >
              <div className="flex w-full items-center justify-between">
                <span className="text-sm font-semibold">{GENERATING_LABEL}</span>
                <span className="text-[10px] opacity-80">
                  {completed}/{total}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0d0d0d]">
                <div
                  className="h-full bg-pink-400 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-[11px] opacity-80">生成中…</span>
            </button>
          );
        }

        // 生成が終わったフェーズは、サブラベルに実績を出す。
        const subLabel =
          p.id === GENERATING_PHASE && total > 0 && completed > 0
            ? `${completed}/${total} 生成済み`
            : p.subLabel;

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
            <span className="text-[11px] text-zinc-500">{subLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}
