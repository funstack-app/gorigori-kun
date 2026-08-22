import { useEffect, useMemo, useRef, useState } from "react";

import { storyboard } from "../../../lib/ipc";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useToasts } from "../../../lib/store/toasts";
import { useWorkspace } from "../../../lib/store/workspace";
import { buildProductionParams } from "../../../lib/storyboard/productionParams";
import { useSceneConstruction } from "../../../lib/storyboard/useSceneConstruction";
import { GenerationGauge, recordGenerationDuration } from "../../GenerationGauge";
import { SafeImage } from "../../SafeImage";
import { CardSizeSlider, gridColsForAspect } from "./cardSize";

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
  const activeRunParams = useStoryboardRun((s) => s.params);
  const lastError = useStoryboardRun((s) => s.lastError);
  const beginRun = useStoryboardRun((s) => s.beginRun);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const regenerateCut = useStoryboardRun((s) => s.regenerateCut);
  // ラフ消失修正 (2026-07-28): take が届くまでの間、そのカットのラフを下敷きに表示する。
  const generationCutSketchMeta = useStoryboardRun((s) => s.generationCutSketchMeta);
  // B2: キービジュアル固定参照 (全カット共通の基準画像)
  const keyVisualPath = useStoryboardRun((s) => s.keyVisualPath);
  const setKeyVisualPath = useStoryboardRun((s) => s.setKeyVisualPath);
  // 共有 planChat が消えていても storyboard 側の控えから読む (Sol 評価 blocking#3)。
  const sceneConstruction = useSceneConstruction();
  // STΛCK指示(2026-06-07): カードサイズ。1=大きく/2=既定/3=小さく。
  // 2026-07-28: ローカル useState から workspace ストアへ移行 (永続 + 他2画面と共有)。
  const storyboardCardSize = useWorkspace((s) => s.storyboardCardSize);

  // P1 修正 (2026-05-20): ローカル useState で起動済み判定すると、Phase 切替で
  // アンマウントされた瞬間にフラグが false に戻り重複 run が走ってしまうため、
  // ストア (storyboardRun.generationRunStartedAt) で起動済み判定を保持する。
  const generationRunStartedAt = useStoryboardRun((s) => s.generationRunStartedAt);
  const lastEventAt = useStoryboardRun((s) => s.lastEventAt);
  const setGenerationRunStartedAt = useStoryboardRun((s) => s.setGenerationRunStartedAt);
  const generationStarted = generationRunStartedAt !== null;
  const starting =
    status === "running" &&
    activeRunId !== null &&
    activeRunParams !== null &&
    !activeRunParams.sketchMode &&
    !generationStarted;
  const startError = status === "failed" ? lastError : null;
  const [now, setNow] = useState(() => Date.now());
  const previousCutStatusesRef = useRef<Record<string, string>>(
    Object.fromEntries(Array.from(cuts, ([cutId, cut]) => [cutId, cut.status])),
  );
  const cutStartedAtRef = useRef<Record<string, number>>(
    Object.fromEntries(
      Array.from(cuts, ([cutId, cut]) =>
        cut.status === "running"
          ? [cutId, lastEventAt ?? generationRunStartedAt ?? Date.now()]
          : [],
      ).filter((entry) => entry.length === 2),
    ),
  );

  useEffect(() => {
    const previousStatuses = previousCutStatusesRef.current;
    cuts.forEach((cut, cutId) => {
      const previousStatus = previousStatuses[cutId];
      if (cut.status === "running" && previousStatus !== "running") {
        cutStartedAtRef.current[cutId] = lastEventAt ?? Date.now();
      } else if (previousStatus === "running" && cut.status === "review") {
        const startedAt = cutStartedAtRef.current[cutId];
        if (startedAt != null) {
          recordGenerationDuration(
            "storyboard",
            Math.max(0, (Date.now() - startedAt) / 1000),
          );
        }
      }
    });
    previousCutStatusesRef.current = Object.fromEntries(
      Array.from(cuts, ([cutId, cut]) => [cutId, cut.status]),
    );
  }, [cuts, lastEventAt]);

  useEffect(() => {
    if (status !== "running") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // B2: キービジュアルをファイル選択で設定する。
  async function pickKeyVisual() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (!r || typeof r !== "string") return;
      setKeyVisualPath(r);
      useToasts.getState().push({
        kind: "success",
        text: "キービジュアルを全カットの基準に設定しました。",
        ttlMs: 2500,
      });
    } catch (err) {
      useToasts.getState().push({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  // P11 (2026-05-20 STΛCK 指示): Phase 3 入場時の自動生成 useEffect を撤廃。
  // 「本生成を開始」ボタンを押すまで何もしない設計に変更。
  // 鉄則: パネルに入っただけでは絶対に生成を始めない。
  async function startGeneration() {
    if (generationStarted) return;
    if (!goal || !sceneConstruction) return;
    if (starting) return;
    // 既に本番 run が走っているなら既起動済みマーク。
    // getState で同期的に見るため、タブ復帰直後や連打でも古い描画値を使わない。
    const currentRun = useStoryboardRun.getState();
    if (currentRun.activeRunId) {
      const cur = currentRun.params;
      if (cur && !cur.sketchMode) {
        setGenerationRunStartedAt(Date.now());
      }
      return;
    }
    useStoryboardRun.setState({ lastError: null });
    let issuedRunId: string | null = null;
    try {
      // S3 (2026-07-28): params 組み立ては buildProductionParams に集約した
      // (採用ゲート式の startProductionForCuts と同じ手順を共有するため)。
      //
      // ラフ消失修正 (2026-07-28): ここで reset() を呼ぶのをやめた。ラフは生成枠を
      // 消費した資産なので、本生成を始めても破棄しない。run 状態の初期化は beginRun が
      // 担う。前ストーリーの絵コンテ流入防止は B1 の goal バインディング検査
      // (buildProductionParams 内) と SketchReviewPanel の goal キーガードが担保する。
      const runId = crypto.randomUUID();
      issuedRunId = runId;
      const { params, cutSketchMeta } = buildProductionParams({
        runId,
        goal,
        sceneConstruction,
        run: useStoryboardRun.getState(),
      });

      // 確定絵コンテのスナップショット (Phase 4 の i2v メタ + Phase 3 のラフ下敷きの
      // データ源)。全量上書きなので reset を挟まなくても前 run のメタは残らない。
      useStoryboardRun.getState().setGenerationCutSketchMeta(cutSketchMeta);

      beginRun(runId, params);
      await storyboard.run(params);
      setGenerationRunStartedAt(Date.now());
      useToasts.getState().push({
        kind: "success",
        text: "本生成を開始しました。",
        ttlMs: 2400,
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const run = useStoryboardRun.getState();
      if (issuedRunId && run.activeRunId === issuedRunId) {
        useStoryboardRun.setState({
          activeRunId: null,
          status: "failed",
          lastError: msg,
        });
      }
      useToasts.getState().push({
        kind: "error",
        text: `生成起動に失敗しました: ${msg}`,
        ttlMs: 6000,
      });
    }
  }

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
    runParams?.candidatesPerCut ?? useStoryboardRun.getState().generationCandidatesPerCut ?? 3;
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
            {startError && <p className="mt-1 text-[11px] text-red-400">{startError}</p>}
          </div>
          {/* 参照画像を常時表示 (キャラ一貫性の文脈担保) */}
          <div className="flex shrink-0 gap-2">
            <RefThumb label="キャラ" path={goal.characterReferencePath} />
            {goal.styleReferencePath && (
              <RefThumb label="スタイル" path={goal.styleReferencePath} />
            )}
          </div>

          {/* P11: 未起動なら「本生成を開始」、起動済みなら「最終確認へ」 */}
          <div className="flex shrink-0 flex-col gap-2">
            {!generationStarted ? (
              <button
                type="button"
                onClick={startGeneration}
                disabled={starting}
                className={[
                  "rounded-md px-4 py-2 text-sm font-semibold transition",
                  starting
                    ? "cursor-not-allowed bg-zinc-700 text-zinc-400"
                    : "bg-pink-500 text-white hover:bg-pink-400",
                ].join(" ")}
                title={`本生成 (${useStoryboardRun.getState().generationCandidatesPerCut}案/カット) を開始`}
              >
                {starting ? "起動中…" : "本生成を開始 →"}
              </button>
            ) : (
              <>
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
                {/* S3 (2026-07-28): checkpoint 依存の「中断」ボタンは撤去。停止区間が消え、
                    押しても何も起きないボタンになるため (右上の生成状況パネルの中止を使う) */}
              </>
            )}
          </div>
        </div>

        {/* === B2: キービジュアル固定参照 (生成開始前のみ操作可) === */}
        {!generationStarted && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-[#242424] bg-[#101010] px-3 py-2">
            <div className="flex items-center gap-3">
              <div className="h-12 w-16 shrink-0 overflow-hidden rounded-md border border-[#2a2a2a] bg-[#0d0d0d]">
                {keyVisualPath ? (
                  <SafeImage
                    path={keyVisualPath}
                    alt="キービジュアル"
                    className="h-full w-full cursor-zoom-in object-cover"
                    title="ダブルクリックで拡大"
                    onDoubleClick={() =>
                      useImagePreview.getState().open(keyVisualPath, [keyVisualPath])
                    }
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[9px] text-zinc-600">
                    未設定
                  </div>
                )}
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold text-zinc-300">
                  キービジュアル固定参照
                </span>
                <span className="text-[10px] text-zinc-500">
                  {keyVisualPath
                    ? "この画像を全カットの基準にして生成します。"
                    : "全カット共通の基準画像を固定したい場合に設定 (任意)。"}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={pickKeyVisual}
                className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
              >
                {keyVisualPath ? "差し替え" : "画像を選ぶ"}
              </button>
              {keyVisualPath && (
                <button
                  type="button"
                  onClick={() => setKeyVisualPath(null)}
                  className="rounded-md border border-[#2a2a2a] px-2 py-1.5 text-[11px] text-zinc-500 hover:border-pink-500/40 hover:text-pink-200"
                  title="キービジュアルを解除"
                >
                  解除
                </button>
              )}
            </div>
          </div>
        )}

        {/* === 本番カット生成 進捗バー === */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className={allDoneGen ? "text-emerald-300" : "text-pink-200"}>
              {allDoneGen
                ? "本番カット生成完了"
                : `本番カット生成中…  ${completed}/${totalForBar || "?"}`}
            </span>
            <div className="flex items-center gap-2">
              {/* STΛCK指示(2026-06-07): カードサイズスライダー (大⇔小) */}
              <CardSizeSlider />
              <span className="text-zinc-500">{Math.round(allDoneGen ? 100 : progressPercent)}%</span>
            </div>
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
                <span className="text-[10px] text-zinc-500">{group.items.length} カット</span>
              </div>
              <ol
                className={`grid gap-3 ${gridColsForAspect(goal?.aspectRatio ?? "16:9", storyboardCardSize)}`}
              >
                {group.items.map((o) => {
                  const i = o.displayIndex;
                  const s = o.state;
                  const statusLabel =
                    s?.status === "confirmed"
                      ? "採用済み"
                      : s?.status === "review"
                        ? "選択待ち"
                        : s?.status === "running"
                          ? `生成中… ${Math.max(
                              0,
                              Math.floor(
                                (now - (lastEventAt ?? generationRunStartedAt ?? now)) / 1000,
                              ),
                            )}秒`
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
                  // ラフ消失修正 (2026-07-28): take 未着スロットの下敷きに使うラフ画像。
                  // 絵コンテをスキップした直行フローではメタが無いので従来の Spinner。
                  const sketchUnderlayPath =
                    generationCutSketchMeta[o.cutId]?.sketchImagePath ?? null;
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
                      {s?.status === "running" &&
                        (lastEventAt ?? generationRunStartedAt) != null && (
                          <GenerationGauge
                            startedAt={
                              cutStartedAtRef.current[o.cutId] ??
                              (lastEventAt ?? generationRunStartedAt) as number
                            }
                            mode="storyboard"
                          />
                        )}

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
                                `group relative flex ${aspectClass(goal?.aspectRatio ?? "16:9")} items-center justify-center overflow-hidden rounded-md border bg-[#0d0d0d]`,
                                isAdopted
                                  ? "border-pink-500 ring-2 ring-pink-500/40"
                                  : "border-dashed border-[#333]",
                              ].join(" ")}
                            >
                              {take ? (
                                <>
                                  <SafeImage
                                    path={take.imagePath}
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
                              ) : sketchUnderlayPath ? (
                                <>
                                  <SafeImage
                                    path={sketchUnderlayPath}
                                    alt={`sketch-${i + 1}`}
                                    title="絵コンテのラフ（この構図で本生成中）"
                                    className="h-full w-full object-cover opacity-40 grayscale"
                                  />
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <Spinner running={s?.status === "running"} />
                                  </div>
                                  <div className="absolute left-1 top-1 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold text-zinc-300">
                                    ラフ
                                  </div>
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
                      {/* A-1 (2026-07-30): 失敗カットに次の操作を提示する。store の
                          regenerateCut は running のみガードなので failed から呼べる。
                          成功すると TakeCompleted で review に戻り、採用操作で決着する
                          (既存設計のまま)。 */}
                      {s?.status === "failed" && (
                        <button
                          type="button"
                          onClick={() => regenerateCut(o.cutId)}
                          className="self-start rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-200 transition hover:bg-red-500/20"
                          title="このカットだけ同じ設定でもう一度生成します"
                        >
                          このカットだけ再生成
                        </button>
                      )}
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
        <SafeImage
          path={path}
          alt={label}
          title="ダブルクリックで拡大"
          onDoubleClick={() => useImagePreview.getState().open(path, [path])}
          className="h-full w-full cursor-zoom-in object-cover hover:opacity-80"
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

/** アスペクト比文字列から Tailwind の aspect クラスを返す (絵コンテと同じ表示比率に揃える)。 */
function aspectClass(a: string): string {
  switch (a) {
    case "9:16":
      return "aspect-[9/16]";
    case "1:1":
      return "aspect-square";
    case "4:5":
      return "aspect-[4/5]";
    case "16:9":
    default:
      return "aspect-video";
  }
}
