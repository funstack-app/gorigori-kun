import { useEffect, useMemo, useState } from "react";

import { storyboard } from "../../../lib/ipc";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useImagePreview } from "../../../lib/store/imagePreview";
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
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // P1 修正 (2026-05-20): ローカル useState で起動済み判定すると、Phase 切替で
  // アンマウントされた瞬間にフラグが false に戻り重複 run が走ってしまうため、
  // ストア (storyboardRun.generationRunStartedAt) で起動済み判定を保持する。
  const generationRunStartedAt = useStoryboardRun((s) => s.generationRunStartedAt);
  const setGenerationRunStartedAt = useStoryboardRun((s) => s.setGenerationRunStartedAt);
  const generationStarted = generationRunStartedAt !== null;

  // 入場時に本番 run を起動。
  // STΛCK 指示 (2026-05-20): Phase 2 で絵コンテ run (sketch_mode=true) を
  // 走らせている場合、その activeRunId / cuts が残っているので、
  // 本番 run を起動する前に reset() で一度クリアする (sketchVersions に
  // 絵コンテ画像は保存済みなので消えない)。
  useEffect(() => {
    if (generationStarted) return; // ストア管理で重複起動を防ぐ
    if (!goal || !sceneConstruction) return;
    if (starting) return;
    // 既に本番 run が走っている (params.sketchMode が false) なら何もしない
    if (activeRunId) {
      const cur = useStoryboardRun.getState().params;
      if (cur && !cur.sketchMode) {
        setGenerationRunStartedAt(Date.now());
        return;
      }
    }

    (async () => {
      setStarting(true);
      setStartError(null);
      try {
        // 絵コンテ run の残骸をクリア (sketchVersions / chatMessages / goal は保持される)
        useStoryboardRun.getState().reset();

        // P3b: ユーザーが D&D で並べ替えていた場合は sceneConstruction.cuts を
        // その順序にして本番に渡す。
        const displayOrder = useStoryboardRun.getState().cutDisplayOrder;
        const orderedScene = (() => {
          if (!displayOrder || displayOrder.length === 0) return sceneConstruction;
          const byCutId = new Map(sceneConstruction.cuts.map((c) => [c.cut_id, c]));
          const reordered = displayOrder
            .map((id) => byCutId.get(id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c));
          if (reordered.length !== sceneConstruction.cuts.length) {
            return sceneConstruction; // 整合性が崩れたら元順
          }
          return { ...sceneConstruction, cuts: reordered };
        })();

        const params = {
          storyPrompt: goal.summary || "ストーリーカット",
          characterReferenceImage: goal.characterReferencePath,
          styleReferenceImage: goal.styleReferencePath,
          aspectRatio: goal.aspectRatio,
          durationSeconds: goal.durationSeconds,
          tempo: goal.tempo,
          // P2 + P10 (2026-05-20): ユーザー選択枚数で並列生成、評価ループは廃止
          // (ユーザーが Phase 4 確認画面で take を手動採用)
          candidatesPerCut: useStoryboardRun.getState().generationCandidatesPerCut,
          cwd: undefined,
          sceneConstruction: orderedScene,
          sketchMode: false,
          manualSelection: true,
        };
        const runId = await storyboard.run(params);
        beginRun(runId, params);
        setGenerationRunStartedAt(Date.now());
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
  }, [
    generationStarted,
    activeRunId,
    goal,
    sceneConstruction,
    starting,
    beginRun,
    setGenerationRunStartedAt,
  ]);

  // P2 修正 (2026-05-20): manual_selection ではユーザー採用待ちなので自動遷移しない。
  // 「最終確認へ」ボタンでユーザー意思で進む。

  const ordered = useMemo(() => {
    if (!sceneConstruction) return [];
    return sceneConstruction.cuts.map((c) => ({
      cutId: c.cut_id,
      description: c.description,
      duration: c.duration_seconds,
      state: cuts.get(c.cut_id) ?? null,
    }));
  }, [sceneConstruction, cuts]);

  // P3a: シーン分けグルーピング
  const sceneGroups = useStoryboardRun((s) => s.sceneGroups);
  const groupedOrdered = useMemo(() => {
    const byCutId = new Map(ordered.map((o) => [o.cutId, o]));
    if (sceneGroups.length === 0) {
      return [
        {
          id: "all",
          label: "シーン 1",
          items: ordered.map((o, i) => ({ ...o, displayIndex: i })),
        },
      ];
    }
    return sceneGroups.map((g, gi) => ({
      id: g.id,
      label: `シーン ${gi + 1}`,
      items: g.cutIds
        .map((id) => byCutId.get(id))
        .filter((o): o is (typeof ordered)[number] => Boolean(o))
        .map((o) => ({
          ...o,
          displayIndex: ordered.findIndex((x) => x.cutId === o.cutId),
        })),
    }));
  }, [ordered, sceneGroups]);

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

  // === 進捗バー算出 ===
  const totalForBar = ordered.length || totalCuts || 0;
  // P10: 表示する take slot 数 = 現在 run の candidatesPerCut。run params が
  // 取れない場合はストアの選択値、それも無ければ 3 にフォールバック。
  const runParams = useStoryboardRun.getState().params;
  const slotCount: number =
    runParams?.candidatesPerCut ??
    useStoryboardRun.getState().generationCandidatesPerCut ??
    3;
  const progressPercent = totalForBar > 0 ? (completed / totalForBar) * 100 : 0;
  const allDoneGen = status === "completed" || (totalForBar > 0 && completed === totalForBar);
  // 全カット採用済み判定 (manual_selection で Phase 4 進行ボタン制御に使う)
  const allAdopted = ordered.every((o) => o.state?.status === "confirmed");

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex flex-col gap-3 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Phase 3: カット生成中</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {starting && "起動中…"}
            {status === "failed" && "失敗"}
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

        {/* P2: 手動採用モードでは「最終確認へ」ボタンで進む */}
        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={() => setPhase("review")}
            disabled={completed === 0}
            className={[
              "rounded-md px-4 py-2 text-sm font-semibold transition",
              completed > 0
                ? "bg-pink-500 text-white hover:bg-pink-400"
                : "cursor-not-allowed bg-zinc-700 text-zinc-400",
            ].join(" ")}
            title={
              allAdopted
                ? "全カット採用済み"
                : completed === 0
                  ? "カット完了を待ってください"
                  : "未採用のカットがありますが、確認画面に進めます"
            }
          >
            最終確認へ →
          </button>
        </div>
        </div>

        {/* === 本番カット生成 進捗バー === */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className={allDoneGen ? "text-emerald-300" : "text-pink-200"}>
              {allDoneGen
                ? "本番カット生成完了"
                : `本番カット生成中…  ${completed}/${totalForBar || "?"}`}
            </span>
            <span className="text-zinc-500">
              {Math.round(allDoneGen ? 100 : progressPercent)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0d0d0d]">
            <div
              className={[
                "h-full transition-all duration-500",
                allDoneGen ? "bg-emerald-400" : "bg-pink-400",
              ].join(" ")}
              style={{ width: `${allDoneGen ? 100 : progressPercent}%` }}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <div className="flex flex-col gap-5">
          {groupedOrdered.map((group) => (
            <section key={group.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 border-l-2 border-pink-500 pl-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-pink-200">
                  {group.label}
                </h3>
                <span className="text-[10px] text-zinc-500">
                  {group.items.length} カット
                </span>
              </div>
              <ol className="grid gap-3 md:grid-cols-1 xl:grid-cols-2">
              {group.items.map((o) => {
                const i = o.displayIndex;
            const s = o.state;
            const statusLabel =
              s?.status === "confirmed"
                ? "採用済み"
                : s?.status === "review"
                  ? "選択待ち"
                  : s?.status === "running"
                    ? "生成中…"
                    : s?.status === "failed"
                      ? "失敗"
                      : "待機中";
            const statusColor =
              s?.status === "confirmed"
                ? "text-emerald-300"
                : s?.status === "review"
                  ? "text-amber-300"
                  : s?.status === "running"
                    ? "text-pink-200"
                    : s?.status === "failed"
                      ? "text-red-400"
                      : "text-zinc-500";
            const takes = s?.takes ?? [];
            const adoptedTakeId = s?.selectedTakeId;
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

                {/* P10: N take 並列サムネ (ユーザー選択枚数) + ダブルクリックプレビュー */}
                <div
                  className="grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${slotCount}, minmax(0, 1fr))` }}
                >
                  {Array.from({ length: slotCount }).map((_, idx) => {
                    const take = takes[idx];
                    const isAdopted = take && adoptedTakeId === take.takeId;
                    const allTakePaths = takes
                      .map((t) => t.imagePath)
                      .filter((p): p is string => Boolean(p));
                    return (
                      <div
                        key={idx}
                        className={[
                          "group relative flex aspect-video items-center justify-center overflow-hidden rounded-md border bg-[#0d0d0d]",
                          isAdopted
                            ? "border-pink-500 ring-2 ring-pink-500/40"
                            : "border-dashed border-[#333]",
                        ].join(" ")}
                      >
                        {take ? (
                          <>
                            <img
                              src={`asset://localhost/${encodeURI(take.imagePath)}`}
                              alt={`take-${idx + 1}`}
                              className="h-full w-full cursor-zoom-in object-cover"
                              onDoubleClick={() =>
                                useImagePreview.getState().open(take.imagePath, allTakePaths)
                              }
                              title="ダブルクリックでプレビュー"
                            />
                            {!isAdopted && (
                              <button
                                type="button"
                                onClick={() => adoptTake(o.cutId, take.takeId)}
                                className="absolute inset-x-0 bottom-0 hidden bg-pink-500/90 py-1 text-[10px] font-semibold text-white group-hover:block"
                              >
                                採用
                              </button>
                            )}
                            {isAdopted && (
                              <div className="absolute inset-x-0 bottom-0 bg-pink-500 py-1 text-center text-[10px] font-bold text-white">
                                採用中
                              </div>
                            )}
                          </>
                        ) : (
                          <Spinner running={s?.status === "running"} />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="line-clamp-2 text-xs text-zinc-300">{o.description}</div>
                {s?.error && <div className="text-[10px] text-red-400">{s.error}</div>}
              </li>
            );
          })}
              </ol>
            </section>
          ))}
        </div>
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
