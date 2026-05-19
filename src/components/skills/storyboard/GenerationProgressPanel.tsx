import { useEffect, useMemo, useState } from "react";

import { storyboard } from "../../../lib/ipc";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { usePlanChat } from "../../../lib/store/planChat";
import { useToasts } from "../../../lib/store/toasts";

/**
 * Phase 3: GenerationProgress
 *
 * STΛCK 指示 (2026-05-20):
 *   - 生成中はカットごとの進捗を可視化
 *   - キャラ一貫性の参照画像が常時見える状態を保つ (UI 上部に固定)
 *   - 完了したら自動で Phase 4 review へ
 *
 * 実装:
 *   - 入場時に storyboard.run を起動 (まだ activeRunId が無ければ)
 *   - storyboardRun.cuts (Map<cutId, CutState>) を購読してカード描画
 *   - status === "completed" になったら setPhase("review")
 */
export function GenerationProgressPanel() {
  const goal = useStoryboardRun((s) => s.goal);
  const cuts = useStoryboardRun((s) => s.cuts);
  const totalCuts = useStoryboardRun((s) => s.totalCuts);
  const status = useStoryboardRun((s) => s.status);
  const activeRunId = useStoryboardRun((s) => s.activeRunId);
  const beginRun = useStoryboardRun((s) => s.beginRun);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // 入場時に run を起動 (まだ起動していなければ)
  useEffect(() => {
    if (activeRunId) return;
    if (!goal || !sceneConstruction) return;
    if (starting) return;

    (async () => {
      setStarting(true);
      setStartError(null);
      try {
        const params = {
          storyPrompt: goal.summary || "ストーリーカット",
          characterReferenceImage: goal.characterReferencePath,
          styleReferenceImage: goal.styleReferencePath,
          aspectRatio: goal.aspectRatio,
          durationSeconds: goal.durationSeconds,
          tempo: goal.tempo,
          candidatesPerCut: 1 as 1 | 3,
          cwd: undefined,
          sceneConstruction,
        };
        const runId = await storyboard.run(params);
        beginRun(runId, params);
        useToasts.getState().push({
          kind: "success",
          text: "ストーリーカット生成を開始しました。",
          ttlMs: 2400,
        });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        setStartError(msg);
        useToasts.getState().push({
          kind: "error",
          text: `生成起動に失敗しました: ${msg}`,
          ttlMs: 6000,
        });
      } finally {
        setStarting(false);
      }
    })();
  }, [activeRunId, goal, sceneConstruction, starting, beginRun]);

  // 完了したら次フェーズへ
  useEffect(() => {
    if (status === "completed" && totalCuts > 0) {
      const t = setTimeout(() => setPhase("review"), 800);
      return () => clearTimeout(t);
    }
  }, [status, totalCuts, setPhase]);

  const ordered = useMemo(() => {
    if (!sceneConstruction) return [];
    return sceneConstruction.cuts.map((c) => ({
      cutId: c.cut_id,
      description: c.description,
      duration: c.duration_seconds,
      state: cuts.get(c.cut_id) ?? null,
    }));
  }, [sceneConstruction, cuts]);

  const completed = ordered.filter(
    (o) => o.state?.status === "confirmed" || o.state?.status === "review",
  ).length;

  if (!goal || !sceneConstruction) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">先に Phase 1 / 2 を完了してください。</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Phase 3: カット生成中</h2>
          <p className="mt-1 text-xs text-zinc-500">
            進捗 {completed} / {ordered.length || totalCuts || "?"} カット
            {starting && " · 起動中…"}
            {status === "failed" && " · 失敗"}
          </p>
          {startError && (
            <p className="mt-1 text-[11px] text-red-400">{startError}</p>
          )}
        </div>
        {/* 参照画像を常時表示 (キャラ一貫性の文脈担保) */}
        <div className="flex shrink-0 gap-2">
          <RefThumb label="キャラ" path={goal.characterReferencePath} />
          {goal.styleReferencePath && (
            <RefThumb label="スタイル" path={goal.styleReferencePath} />
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((o, i) => {
            const s = o.state;
            const latestTake = s?.takes?.[s.takes.length - 1];
            const statusLabel =
              s?.status === "confirmed"
                ? "確定"
                : s?.status === "review"
                  ? "完了"
                  : s?.status === "running"
                    ? "生成中…"
                    : s?.status === "failed"
                      ? "失敗"
                      : "待機中";
            const statusColor =
              s?.status === "confirmed" || s?.status === "review"
                ? "text-emerald-300"
                : s?.status === "running"
                  ? "text-pink-200"
                  : s?.status === "failed"
                    ? "text-red-400"
                    : "text-zinc-500";
            return (
              <li
                key={o.cutId}
                className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#1a1a1a] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
                    Cut {i + 1} · {o.duration}s
                  </span>
                  <span className={`text-[11px] ${statusColor}`}>{statusLabel}</span>
                </div>
                <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border border-dashed border-[#333] bg-[#0d0d0d]">
                  {latestTake ? (
                    <img
                      src={`asset://localhost/${encodeURI(latestTake.imagePath)}`}
                      alt={o.cutId}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Spinner running={s?.status === "running"} />
                  )}
                </div>
                <div className="line-clamp-2 text-xs text-zinc-300">{o.description}</div>
                {s?.error && <div className="text-[10px] text-red-400">{s.error}</div>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function RefThumb({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex w-20 flex-col items-center gap-1">
      <div className="h-14 w-20 overflow-hidden rounded-md border border-[#242424] bg-[#0d0d0d]">
        <img
          src={`asset://localhost/${encodeURI(path)}`}
          alt={label}
          className="h-full w-full object-cover"
        />
      </div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </div>
  );
}

function Spinner({ running }: { running: boolean }) {
  if (!running) return <div className="text-xs text-zinc-600">待機中</div>;
  return (
    <div className="flex flex-col items-center gap-2 text-pink-200">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
      <div className="text-[10px]">生成中</div>
    </div>
  );
}
