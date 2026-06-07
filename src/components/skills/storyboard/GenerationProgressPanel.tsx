import { convertFileSrc } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";

import { storyboard } from "../../../lib/ipc";
import { useImagePreview } from "../../../lib/store/imagePreview";
import { usePlanChat } from "../../../lib/store/planChat";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useToasts } from "../../../lib/store/toasts";
import type { StoryboardSketchCut } from "../../../lib/storyboard/types";

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
  const setStatus = useStoryboardRun((s) => s.setStatus);
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  // B2: キービジュアル固定参照 (全カット共通の基準画像)
  const keyVisualPath = useStoryboardRun((s) => s.keyVisualPath);
  const setKeyVisualPath = useStoryboardRun((s) => s.setKeyVisualPath);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // STΛCK指示(2026-06-07): カードサイズ。1=大きく/2=既定/3=小さく。
  const [sizeLevel, setSizeLevel] = useState(2);

  // P1 修正 (2026-05-20): ローカル useState で起動済み判定すると、Phase 切替で
  // アンマウントされた瞬間にフラグが false に戻り重複 run が走ってしまうため、
  // ストア (storyboardRun.generationRunStartedAt) で起動済み判定を保持する。
  const generationRunStartedAt = useStoryboardRun((s) => s.generationRunStartedAt);
  const setGenerationRunStartedAt = useStoryboardRun((s) => s.setGenerationRunStartedAt);
  const generationStarted = generationRunStartedAt !== null;

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
    // 既に本番 run が走っているなら既起動済みマーク
    if (activeRunId) {
      const cur = useStoryboardRun.getState().params;
      if (cur && !cur.sketchMode) {
        setGenerationRunStartedAt(Date.now());
        return;
      }
    }
    setStarting(true);
    setStartError(null);
    try {
      // === B1 修正 (2026-06-06): 絵コンテ混在の根絶 ===
      // 本生成で参照する絵コンテは「(a) 確定 (confirmed===true) かつ
      // (b) 今の goal に紐づくもの」だけに厳格化する。条件を満たさなければ
      // sketchReferences は空のまま = プロンプトのみで普通に生成する。
      //
      // 重要: reset() は sketchVersions を破棄するため (B1' 修正)、参照の捕捉を
      // reset の「前」に行う。これで「絵コンテを確定 → 本生成」の正規フローは
      // その回の確定絵コンテを失わず、かつ前のストーリーの絵コンテは残らない。
      const sketchVersionsBefore = useStoryboardRun.getState().sketchVersions;
      const activeSketchVersionId = useStoryboardRun.getState().activeSketchVersionId;
      const candidate =
        sketchVersionsBefore.find((v) => v.versionId === activeSketchVersionId) ??
        sketchVersionsBefore[sketchVersionsBefore.length - 1] ??
        null;
      // (b) goal バインディング検査: 絵コンテ生成時の goal 要約と現在の goal 要約の
      //     先頭が一致するときだけ採用する。前ストーリーの確定絵コンテが
      //     activeSketchVersionId 経由で残っていても、goal が変わっていれば弾く。
      const currentGoalKey = (goal.summary ?? "").slice(0, 200);
      const sketchBelongsToCurrentGoal =
        candidate != null && candidate.fromGoalSummary === currentGoalKey;
      const activeSketch =
        candidate?.confirmed === true && sketchBelongsToCurrentGoal ? candidate : null;
      const sketchReferences: Record<string, string> = {};
      if (activeSketch) {
        for (const c of activeSketch.cuts) {
          // 確定済みかつ実際に done で画像が出ているカットのみ参照する。
          // 未生成 (sketchImagePath なし) のカットは混ぜない。
          if (c.sketchImagePath && c.sketchStatus === "done") {
            sketchReferences[c.cutId] = c.sketchImagePath;
          }
        }
      }

      // === B2: キービジュアル固定参照 (NOCTURNE @img1 移植) ===
      // キービジュアルが設定されていれば、確定絵コンテ参照を持たない全カットに
      // 共通の基準画像を固定で渡す。確定絵コンテがあるカットはその絵コンテを優先。
      const keyVisualPath = useStoryboardRun.getState().keyVisualPath;
      if (keyVisualPath) {
        for (const c of sceneConstruction.cuts) {
          if (!sketchReferences[c.cut_id]) {
            sketchReferences[c.cut_id] = keyVisualPath;
          }
        }
      }

      // B1' 補完: Phase 4 の i2v プロンプトがカメラワーク等のスケッチメタを
      // 失わないよう、確定絵コンテのメタを run スナップショットに退避してから
      // reset する。今の goal/run に紐づくものだけを撮るので次ストーリーに残らない。
      const cutSketchMeta: Record<string, StoryboardSketchCut> = {};
      if (activeSketch) {
        for (const c of activeSketch.cuts) {
          cutSketchMeta[c.cutId] = c;
        }
      }

      // 絵コンテ run の残骸をクリア (chatMessages / goal / keyVisualPath は保持される)。
      // sketchVersions は B1' 修正で破棄されるので、参照は上で捕捉済み。
      useStoryboardRun.getState().reset();
      // reset の後にスナップショットを格納 (reset が初期化するため順序が重要)。
      useStoryboardRun.getState().setGenerationCutSketchMeta(cutSketchMeta);

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
          return sceneConstruction;
        }
        return { ...sceneConstruction, cuts: reordered };
      })();

      const params = {
        storyPrompt: goal.summary || "ストーリーカット",
        characterReferenceImage: goal.characterReferencePath,
        styleReferenceImage: goal.styleReferencePath,
        // FB#3 (2026-06-06): 複数キャラ/スタイル参照 (後方互換: 単数も維持)。
        characterReferenceImages: goal.characterReferencePaths,
        styleReferenceImages: goal.styleReferencePaths,
        aspectRatio: goal.aspectRatio,
        durationSeconds: goal.durationSeconds,
        tempo: goal.tempo,
        candidatesPerCut: useStoryboardRun.getState().generationCandidatesPerCut,
        cwd: undefined,
        sceneConstruction: orderedScene,
        sketchMode: false,
        manualSelection: true,
        sketchReferences,
      };
      const runId = await storyboard.run(params);
      beginRun(runId, params);
      setGenerationRunStartedAt(Date.now());
      useToasts.getState().push({
        kind: "success",
        text: "本生成を開始しました。",
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
  }

  // FB#3 修正 (2026-06-06 夜): 「一時停止 / 中断」ボタンを生成画面に追加する。
  //
  // 鉄則 (STΛCK 指示): 停止しても UI レイアウト / フェーズは変えない。
  //   - 旧 GenerationWorkspace の StoryboardRunPanel では「中断」が run.reset() を
  //     呼んで cuts を全消去 → カードが消えて画面が崩れていた。これが「停止で UI が
  //     変わる」症状の元。
  //   - ここでは reset() / setPhase() を一切呼ばず、run の status を "paused" に
  //     するだけにする。これで生成は止める意思表示をしつつ、既出カード・進捗・
  //     Phase 3 のレイアウトはそのまま保持される。
  //   - 再開ボタンで status を "running" に戻せる (バックエンドはイベントを流し
  //     続けるので、実体としては「UI 上の停止表示」)。
  function pauseGeneration() {
    setStatus("paused");
    useToasts.getState().push({
      kind: "info",
      text: "生成を一時停止しました (画面はそのままです)。",
      ttlMs: 2600,
    });
  }
  function resumeGeneration() {
    setStatus("running");
    useToasts.getState().push({
      kind: "info",
      text: "生成を再開しました。",
      ttlMs: 2000,
    });
  }
  function stopGeneration() {
    // 中断: cuts / phase は保持。status のみ paused にして以降の進行を止める意思表示。
    // 既に生成済みのカットはそのまま「最終確認へ」進める。
    setStatus("paused");
    useToasts.getState().push({
      kind: "info",
      text: "生成を中断しました。生成済みのカットはそのまま確認・採用できます。",
      ttlMs: 3600,
    });
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
                {/* FB#3: 一時停止 / 再開 / 中断。phase も cuts も変えない (UI 維持)。 */}
                {!allDoneGen && (
                  <div className="flex gap-2">
                    {status === "paused" ? (
                      <button
                        type="button"
                        onClick={resumeGeneration}
                        className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
                        title="生成を再開する (画面は変わりません)"
                      >
                        再開
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={pauseGeneration}
                        className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
                        title="生成を一時停止する (画面は変わりません)"
                      >
                        一時停止
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={stopGeneration}
                      className="rounded-md border border-red-400/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10"
                      title="生成を中断する (生成済みカットは残ります)"
                    >
                      中断
                    </button>
                  </div>
                )}
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
                  <img
                    src={convertFileSrc(keyVisualPath)}
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
              <label className="inline-flex items-center gap-1" title="カードを大きく ⇔ 小さく">
                <span className="text-[10px] font-bold text-neutral-500">大</span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={1}
                  value={sizeLevel}
                  onChange={(e) => setSizeLevel(Number(e.target.value))}
                  className="h-1 w-16 cursor-pointer accent-pink-500"
                  aria-label="カードサイズ"
                />
                <span className="text-[10px] font-bold text-neutral-500">小</span>
              </label>
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
              <ol className={`grid gap-3 ${gridColsForAspect(goal?.aspectRatio ?? "16:9", sizeLevel)}`}>
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
                                `group relative flex ${aspectClass(goal?.aspectRatio ?? "16:9")} items-center justify-center overflow-hidden rounded-md border bg-[#0d0d0d]`,
                                isAdopted
                                  ? "border-pink-500 ring-2 ring-pink-500/40"
                                  : "border-dashed border-[#333]",
                              ].join(" ")}
                            >
                              {take ? (
                                <>
                                  <img
                                    src={convertFileSrc(take.imagePath)}
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
          src={convertFileSrc(path)}
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

/** アスペクト比 + サイズレベル(1=大きく少列 〜 3=小さく多列)に応じてカードの列数を返す。
 *  STΛCK指示(2026-06-07): 他タブ同様スライダーでサイズを選べるように。
 *  level 2 が既定 (絵コンテ SketchReviewPanel と同じ並べ方)。level 1=大きく、level 3=小さく。 */
function gridColsForAspect(a: string, level: number = 2): string {
  const table: Record<string, [string, string, string]> = {
    "9:16": [
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
      "grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
    ],
    "1:1": [
      "grid-cols-1 md:grid-cols-1 xl:grid-cols-2",
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
    ],
    "4:5": [
      "grid-cols-1 md:grid-cols-1 xl:grid-cols-2",
      "grid-cols-1 md:grid-cols-2 xl:grid-cols-3",
      "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
    ],
    "16:9": [
      "grid-cols-1 md:grid-cols-1",
      "grid-cols-1 md:grid-cols-2",
      "grid-cols-2 md:grid-cols-3",
    ],
  };
  const cols = table[a] ?? table["16:9"];
  const idx = Math.min(2, Math.max(0, level - 1));
  return cols[idx];
}
