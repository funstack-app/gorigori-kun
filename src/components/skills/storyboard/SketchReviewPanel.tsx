import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { storyboard, type RegenerateCutParams } from "../../../lib/ipc";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { usePlanChat } from "../../../lib/store/planChat";
import { useToasts } from "../../../lib/store/toasts";
import type {
  StoryboardSketchCut,
  StoryboardSketchVersion,
} from "../../../lib/storyboard/types";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function basename(p: string): string {
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] ?? p;
}

/**
 * Phase 2: SketchReview (1枚レビュー方式)
 *
 * STΛCK 指示 (2026-05-20):
 *  - グリッドではなくカット 1 枚をフォーカス表示
 *  - ◀ ▶ で順送り、進捗インジケータ (3/8) 表示
 *  - 「自由記述で書き直し」(userOverride をローカル上書き)
 *  - 「再生成」(将来 AI 部分再依頼用、現状はトーストのみ)
 *  - 「別案を依頼」で全カット作り直し
 *  - キャラ参照画像 (必須) / スタイル参照画像 (任意) を確定する UI
 *  - 全カット確認 + キャラ画像確定で「この絵コンテで生成 →」が押せる
 */
export function SketchReviewPanel() {
  const goal = useStoryboardRun((s) => s.goal);
  const sketchVersions = useStoryboardRun((s) => s.sketchVersions);
  const activeSketchVersionId = useStoryboardRun((s) => s.activeSketchVersionId);
  const pushSketchVersion = useStoryboardRun((s) => s.pushSketchVersion);
  const updateSketchCut = useStoryboardRun((s) => s.updateSketchCut);
  const sceneGroups = useStoryboardRun((s) => s.sceneGroups);
  const cutDisplayOrder = useStoryboardRun((s) => s.cutDisplayOrder);
  const setCutDisplayOrder = useStoryboardRun((s) => s.setCutDisplayOrder);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);

  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftOverride, setDraftOverride] = useState("");
  // 絵コンテ生成 (sketch_mode=true) の起動状態
  // P1修正 (2026-05-20): Phase切替でアンマウントされても保持できるようストア管理に変更。
  // ローカルuseStateだと Phase 2↔3 往復で重複 run が起動するバグの原因になっていた。
  const [sketchStarting, setSketchStarting] = useState(false);
  const sketchRunStartedAt = useStoryboardRun((s) => s.sketchRunStartedAt);
  const setSketchRunStartedAt = useStoryboardRun((s) => s.setSketchRunStartedAt);
  const sketchStarted = sketchRunStartedAt !== null;

  // ストア (cuts Map) から絵コンテ画像を読む
  // storyboard.run(sketch_mode=true) はイベントを既存ルートで流すので、
  // cuts Map の takes[0].imagePath を sketchImagePath として参照する
  const storeCuts = useStoryboardRun((s) => s.cuts);
  const storeStatus = useStoryboardRun((s) => s.status);

  const activeVersion: StoryboardSketchVersion | null = useMemo(() => {
    if (sketchVersions.length === 0) return null;
    if (activeSketchVersionId) {
      return sketchVersions.find((v) => v.versionId === activeSketchVersionId) ?? null;
    }
    return sketchVersions[sketchVersions.length - 1];
  }, [sketchVersions, activeSketchVersionId]);

  // 初回マウントで sketch 未生成なら、planChat の sceneConstruction から組み立てる
  useEffect(() => {
    if (sketchVersions.length > 0) return;
    if (!goal) return;
    if (!sceneConstruction || sceneConstruction.cuts.length === 0) return;

    const version: StoryboardSketchVersion = {
      versionId: `sketch-${Date.now()}`,
      createdAt: Date.now(),
      fromGoalSummary: goal.summary.slice(0, 200),
      directorNotes:
        "キャラクターの一貫性最優先。最初の参照画像と直前のエンドフレームを各カットで参照する。",
      cuts: sceneConstruction.cuts.map<StoryboardSketchCut>((cut, index) => ({
        cutId: cut.cut_id,
        order: index + 1,
        durationSeconds: cut.duration_seconds,
        intent: cut.description,
        cameraNote: inferCameraNote(index, sceneConstruction.cuts.length),
        visualLayout: cut.description,
        filmNotes: inferFilmNotes(index, sceneConstruction.cuts.length),
      })),
    };
    pushSketchVersion(version);
  }, [sceneConstruction, goal, sketchVersions.length, pushSketchVersion]);

  // カーソルが範囲外になったら 0 に戻す
  useEffect(() => {
    if (!activeVersion) return;
    if (cursor >= activeVersion.cuts.length) setCursor(0);
  }, [activeVersion, cursor]);

  // === 絵コンテ自動生成 (Phase 2 入場時) ===
  // STΛCK 指示 (2026-05-20): 絵コンテは GPT Image 2 でスケッチ風に生成する。
  // SketchCanvas (棒人間Canvas) は撤去し、本物の絵コンテ画像を出す。
  useEffect(() => {
    if (sketchStarted || sketchStarting) return;
    if (!activeVersion) return;
    if (!goal?.characterReferencePath) return; // キャラ参照がある時のみ起動 (生成に必須)
    if (!sceneConstruction) return;

    // 既に絵コンテ画像が全カット揃っているならスキップ
    const allDone = activeVersion.cuts.every((c) => c.sketchImagePath);
    if (allDone) {
      setSketchRunStartedAt(Date.now());
      return;
    }

    (async () => {
      setSketchStarting(true);
      try {
        // 絵コンテ専用 run。candidates_per_cut=1, sketch_mode=true。
        // 評価はバックエンドでも軽量、フロントは takes[0] をそのまま絵コンテに採用。
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
          sketchMode: true,
        };
        // 既存 storyboard.run を流用 (バックエンドで sketch_mode=true を受けてスタイル切替)
        const runId = await storyboard.run(params);
        useStoryboardRun.getState().beginRun(runId, params);
        setSketchRunStartedAt(Date.now());
        useToasts.getState().push({
          kind: "info",
          text: "絵コンテをスケッチ生成中…",
          ttlMs: 2400,
        });
      } catch (e) {
        useToasts.getState().push({
          kind: "error",
          text: `絵コンテ生成の起動に失敗: ${(e as Error)?.message ?? e}`,
          ttlMs: 6000,
        });
      } finally {
        setSketchStarting(false);
      }
    })();
  }, [
    sketchStarted,
    sketchStarting,
    activeVersion,
    goal,
    sceneConstruction,
  ]);

  // === 生成イベント (cuts Map) → 各カットの sketchImagePath を更新 ===
  useEffect(() => {
    if (!activeVersion) return;
    if (!sketchStarted) return;
    for (const cut of activeVersion.cuts) {
      const stored = storeCuts.get(cut.cutId);
      if (!stored) continue;
      const latest = stored.takes[stored.takes.length - 1]?.imagePath;
      const wantStatus: StoryboardSketchCut["sketchStatus"] =
        stored.status === "running"
          ? "generating"
          : stored.status === "failed"
            ? "failed"
            : latest
              ? "done"
              : "pending";
      if (cut.sketchImagePath !== latest || cut.sketchStatus !== wantStatus) {
        updateSketchCut(cut.cutId, {
          // updateSketchCut の patch は当該フィールド名で受ける
          // (型は SketchCut の Partial)
          ...({
            sketchImagePath: latest,
            sketchStatus: wantStatus,
          } as Partial<StoryboardSketchCut>),
        });
      }
    }
  }, [storeCuts, storeStatus, activeVersion, sketchStarted, updateSketchCut]);

  function handleRegenerate() {
    useToasts.getState().push({
      kind: "info",
      text:
        "別バージョンの絵コンテを AI に依頼する機能は実装中です。一度 Phase 1 に戻って追加の指示を出してください。",
      ttlMs: 5000,
    });
  }

  function handleProceed() {
    if (!activeVersion) return;
    if (!goal?.characterReferencePath) {
      useToasts.getState().push({
        kind: "error",
        text: "生成にはキャラクターの参照画像が必要です。下の「キャラ参照」から添付してください。",
        ttlMs: 6000,
      });
      return;
    }
    setPhase("generation");
  }

  async function pickReference(target: "character" | "style") {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r || typeof r !== "string") return;
      if (!goal) return;
      setGoal({
        ...goal,
        characterReferencePath:
          target === "character" ? r : goal.characterReferencePath,
        styleReferencePath: target === "style" ? r : goal.styleReferencePath,
      });
      useToasts.getState().push({
        kind: "success",
        text: `${target === "character" ? "キャラ" : "スタイル"}参照画像を設定しました。`,
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

  function clearReference(target: "character" | "style") {
    if (!goal) return;
    setGoal({
      ...goal,
      characterReferencePath:
        target === "character" ? "" : goal.characterReferencePath,
      styleReferencePath: target === "style" ? undefined : goal.styleReferencePath,
    });
  }

  function startEdit(cut: StoryboardSketchCut) {
    setDraftOverride(cut.userOverride ?? cut.intent);
    setEditing(true);
  }

  function saveEdit(cut: StoryboardSketchCut) {
    updateSketchCut(cut.cutId, { userOverride: draftOverride.trim() || undefined });
    setEditing(false);
    useToasts.getState().push({
      kind: "success",
      text: `Cut ${cut.order} を書き直しました。`,
      ttlMs: 2200,
    });
  }

  function cancelEdit() {
    setDraftOverride("");
    setEditing(false);
  }

  function clearOverride(cut: StoryboardSketchCut) {
    updateSketchCut(cut.cutId, { userOverride: undefined });
    setEditing(false);
  }

  // P4 (2026-05-20): 単一カット再生成。追加参照画像と自由記述で 1 take 生成する。
  // additionalRefs を渡せば、ユーザー投入のラフ画像を反映できる。
  async function handleRegenerateCut(
    cut: StoryboardSketchCut,
    additionalRefs: string[] = [],
  ) {
    if (!goal?.characterReferencePath) {
      useToasts.getState().push({
        kind: "error",
        text: "キャラ参照画像を先に選んでください。",
        ttlMs: 4000,
      });
      return;
    }
    const runId = useStoryboardRun.getState().activeRunId;
    if (!runId) {
      useToasts.getState().push({
        kind: "error",
        text: "アクティブな run が見つかりません。Phase 1 から始め直してください。",
        ttlMs: 4000,
      });
      return;
    }
    const params: RegenerateCutParams = {
      runId,
      cutId: cut.cutId,
      characterReferenceImage: goal.characterReferencePath,
      styleReferenceImage: goal.styleReferencePath,
      additionalRefs,
      promptOverride: cut.userOverride,
      aspectRatio: goal.aspectRatio,
      cutDescription: cut.intent,
      cutDurationSeconds: cut.durationSeconds,
      sketchMode: true, // Phase 2 では絵コンテモードで再生成
    };
    try {
      updateSketchCut(cut.cutId, { sketchStatus: "generating" });
      await storyboard.regenerateCut(params);
      useToasts.getState().push({
        kind: "info",
        text:
          additionalRefs.length > 0
            ? `Cut ${cut.order} を参照画像で再生成中…`
            : `Cut ${cut.order} を再生成中…`,
        ttlMs: 3000,
      });
    } catch (e) {
      useToasts.getState().push({
        kind: "error",
        text: `再生成に失敗: ${(e as Error)?.message ?? e}`,
        ttlMs: 5000,
      });
    }
  }

  if (!goal) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">先に Phase 1 でゴールを確定してください。</div>
      </div>
    );
  }

  if (!activeVersion) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">絵コンテを生成中…</div>
      </div>
    );
  }

  const canProceed = Boolean(goal.characterReferencePath);
  const editingCut = editing ? activeVersion.cuts[cursor] ?? null : null;

  // === 進捗計算 (絵コンテ生成のステータスバー) ===
  const totalCuts = activeVersion.cuts.length;
  const doneCount = activeVersion.cuts.filter((c) => c.sketchStatus === "done").length;
  const generatingCount = activeVersion.cuts.filter((c) => c.sketchStatus === "generating").length;
  const allDone = doneCount === totalCuts && totalCuts > 0;
  const progressPercent = totalCuts > 0 ? (doneCount / totalCuts) * 100 : 0;

  // === シーン分け (P3a) / 並べ替え (P3b) ===
  // 優先順位:
  //  1. cutDisplayOrder がある (ユーザー D&D 後): flat 一列表示
  //  2. sceneGroups がある: シーン単位グルーピング
  //  3. それ以外: 1グループ "シーン 1"
  const groupedCuts = useMemo(() => {
    const cutsByCutId = new Map(activeVersion.cuts.map((c) => [c.cutId, c]));
    if (cutDisplayOrder && cutDisplayOrder.length > 0) {
      const orderedCuts = cutDisplayOrder
        .map((id) => cutsByCutId.get(id))
        .filter((c): c is StoryboardSketchCut => Boolean(c));
      return [
        {
          id: "user-order",
          label: "ユーザー並び順",
          cuts: orderedCuts.map((c) => ({
            cut: c,
            index: activeVersion.cuts.findIndex((x) => x.cutId === c.cutId),
          })),
        },
      ];
    }
    if (sceneGroups.length === 0) {
      return [
        {
          id: "all",
          label: "シーン 1",
          cuts: activeVersion.cuts.map((c, i) => ({ cut: c, index: i })),
        },
      ];
    }
    return sceneGroups.map((g, gi) => ({
      id: g.id,
      label: `シーン ${gi + 1}`,
      cuts: g.cutIds
        .map((id) => cutsByCutId.get(id))
        .filter((c): c is StoryboardSketchCut => Boolean(c))
        .map((c) => ({
          cut: c,
          index: activeVersion.cuts.findIndex((x) => x.cutId === c.cutId),
        })),
    }));
  }, [activeVersion.cuts, sceneGroups, cutDisplayOrder]);

  // D&D で並べ替え。ユーザー D&D が走った瞬間に flat 表示に切り替わる。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  function handleDragEnd(e: DragEndEvent) {
    if (!e.active || !e.over) return;
    if (e.active.id === e.over.id) return;
    if (!activeVersion) return;
    const currentOrder =
      cutDisplayOrder ?? activeVersion.cuts.map((c) => c.cutId);
    const oldIndex = currentOrder.indexOf(String(e.active.id));
    const newIndex = currentOrder.indexOf(String(e.over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(currentOrder, oldIndex, newIndex);
    setCutDisplayOrder(next);
  }
  function resetDisplayOrder() {
    setCutDisplayOrder(null);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* === ヘッダー === */}
      <header className="flex flex-col gap-3 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-200">Phase 2: 絵コンテレビュー</h2>
          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{goal.summary}</p>
          <p className="mt-2 text-[11px] text-pink-200">
            ディレクターメモ: {activeVersion.directorNotes}
          </p>
        </div>

        {/* 参照画像エリア */}
        <div className="flex shrink-0 items-end gap-3">
          <ReferenceSlot
            label="キャラ参照 (必須)"
            path={goal.characterReferencePath}
            onPick={() => pickReference("character")}
            onClear={() => clearReference("character")}
            required
          />
          <ReferenceSlot
            label="スタイル参照 (任意)"
            path={goal.styleReferencePath}
            onPick={() => pickReference("style")}
            onClear={() => clearReference("style")}
          />
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <button
            type="button"
            onClick={handleRegenerate}
            className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
          >
            別案を依頼
          </button>
          <button
            type="button"
            onClick={handleProceed}
            disabled={!canProceed}
            className={[
              "rounded-md px-4 py-2 text-sm font-semibold transition",
              canProceed
                ? "bg-pink-500 text-white hover:bg-pink-400"
                : "cursor-not-allowed bg-zinc-700 text-zinc-400",
            ].join(" ")}
            title={canProceed ? undefined : "キャラ参照画像を選択してください"}
          >
            この絵コンテで生成 →
          </button>
        </div>
        </div>

        {/* === 絵コンテ生成 進捗バー === */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className={allDone ? "text-emerald-300" : "text-pink-200"}>
              {allDone
                ? "絵コンテ生成完了"
                : generatingCount > 0
                  ? `絵コンテ生成中…  ${doneCount}/${totalCuts}`
                  : doneCount === 0
                    ? `準備中…  0/${totalCuts}`
                    : `${doneCount}/${totalCuts}`}
            </span>
            <span className="text-zinc-500">
              {Math.round(allDone ? 100 : progressPercent)}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#0d0d0d]">
            <div
              className={[
                "h-full transition-all duration-500",
                allDone ? "bg-emerald-400" : "bg-pink-400",
              ].join(" ")}
              style={{ width: `${allDone ? 100 : progressPercent}%` }}
            />
          </div>
        </div>
      </header>

      {/* === シーン分けタイムライン (P3a) / D&D 並べ替え (P3b) === */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="flex flex-col gap-5">
            {groupedCuts.map((group) => (
              <section key={group.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 border-l-2 border-pink-500 pl-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-pink-200">
                      {group.label}
                    </h3>
                    <span className="text-[10px] text-zinc-500">
                      {group.cuts.length} カット
                    </span>
                  </div>
                  {cutDisplayOrder && (
                    <button
                      type="button"
                      onClick={resetDisplayOrder}
                      className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-zinc-400 hover:border-pink-500/40"
                      title="並び順を元に戻す (シーン分け表示へ)"
                    >
                      並びを元に戻す
                    </button>
                  )}
                </div>
                <SortableContext
                  items={group.cuts.map(({ cut }) => cut.cutId)}
                  strategy={rectSortingStrategy}
                >
                  <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.cuts.map(({ cut: c, index: i }) => (
                      <SortableSketchCutCard
                        key={c.cutId}
                        cut={c}
                        index={i}
                        aspectRatio={goal.aspectRatio}
                        onEdit={() => {
                          setCursor(i);
                          startEdit(c);
                        }}
                        onRegenerate={() => handleRegenerateCut(c)}
                        onRegenerateWithRefs={(refs) => handleRegenerateCut(c, refs)}
                        onClearOverride={() => clearOverride(c)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </section>
            ))}
          </div>
        </DndContext>
      </div>

      {/* === 自由記述モーダル (書き直し中のカットがあれば表示) === */}
      {editing && editingCut && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={cancelEdit}
        >
          <div
            className="w-full max-w-2xl space-y-3 rounded-lg border border-[#2a2a2a] bg-[#161616] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-200">
                CUT {editingCut.order} を書き直し
              </h3>
              <span className="text-[10px] text-zinc-500">
                {editingCut.durationSeconds}s / {editingCut.cameraNote}
              </span>
            </div>
            <textarea
              value={draftOverride}
              onChange={(e) => setDraftOverride(e.target.value)}
              rows={6}
              autoFocus
              className="w-full resize-none rounded-md border border-[#2a2a2a] bg-[#0d0d0d] p-3 text-sm text-zinc-200 outline-none focus:border-pink-500/50"
              placeholder="このカットの意図・構図を自分の言葉で書き直す"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-300 hover:border-pink-500/40"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => saveEdit(editingCut)}
                className="rounded-md bg-pink-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-400"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// === D&D 並べ替え対応ラッパー (P3b) ===
function SortableSketchCutCard(props: {
  cut: StoryboardSketchCut;
  index: number;
  aspectRatio: string;
  onEdit: () => void;
  onRegenerate: () => void;
  onRegenerateWithRefs: (refs: string[]) => void;
  onClearOverride: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.cut.cutId });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  // SketchCutCard 自体は <li>。SortableSketchCutCard は外側で <div ref> を持つ。
  // <li> が hover で D&D activate distance 内なら listeners 経由でハンドル動作。
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SketchCutCard {...props} />
    </div>
  );
}

// === カット 1 枚 (Phase 3 のカードと同じトンマナ) ===
function SketchCutCard({
  cut,
  index,
  aspectRatio,
  onEdit,
  onRegenerate,
  onRegenerateWithRefs,
  onClearOverride,
}: {
  cut: StoryboardSketchCut;
  index: number;
  aspectRatio: string;
  onEdit: () => void;
  onRegenerate: () => void;
  onRegenerateWithRefs: (refs: string[]) => void;
  onClearOverride: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  // D&D: 画像ファイルを受けたら参照画像として再生成
  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }
  function handleDragLeave() {
    setDragOver(false);
  }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    const imagePaths = files
      .filter((f) => f.type.startsWith("image/"))
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    if (imagePaths.length > 0) {
      onRegenerateWithRefs(imagePaths);
    }
  }
  async function pickRefImages() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = (Array.isArray(r) ? r : [r]).filter(
        (p): p is string => typeof p === "string",
      );
      if (paths.length > 0) onRegenerateWithRefs(paths);
    } catch {
      // noop
    }
  }

  const status = cut.sketchStatus ?? "pending";
  const statusLabel =
    status === "done"
      ? "完了"
      : status === "generating"
        ? "生成中…"
        : status === "failed"
          ? "失敗"
          : "順番待ち";
  const statusColor =
    status === "done"
      ? "text-emerald-300"
      : status === "generating"
        ? "text-pink-200"
        : status === "failed"
          ? "text-red-400"
          : "text-zinc-500";

  return (
    <li
      className={[
        "flex flex-col gap-2 rounded-md border bg-[#1a1a1a] p-3 transition",
        dragOver ? "border-pink-500 ring-2 ring-pink-500/40" : "border-[#242424]",
      ].join(" ")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
          Cut {index + 1} · {cut.durationSeconds}s
        </span>
        <span className={`text-[11px] ${statusColor}`}>{statusLabel}</span>
      </div>

      <div className="flex items-center justify-center overflow-hidden rounded-md border border-[#2a2a2a] bg-[#fcfbf5]">
        <SketchImageBox cut={cut} aspectRatio={aspectRatio} />
      </div>

      {dragOver && (
        <div className="rounded-md border border-pink-500/50 bg-pink-500/10 px-2 py-1 text-center text-[10px] text-pink-100">
          画像をドロップして参照付きで再生成
        </div>
      )}

      <div className="line-clamp-2 text-xs text-zinc-300">
        {cut.userOverride ? (
          <>
            <span className="text-[10px] text-pink-300">[手書き] </span>
            {cut.userOverride}
          </>
        ) : (
          cut.intent
        )}
      </div>

      <div className="text-[10px] text-zinc-500">{cut.cameraNote}</div>

      <div className="mt-auto flex flex-wrap gap-1 pt-1">
        <button
          type="button"
          onClick={onEdit}
          className="rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-[10px] text-pink-200 hover:bg-pink-500/20"
        >
          書き直し
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
        >
          再生成
        </button>
        <button
          type="button"
          onClick={pickRefImages}
          className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
          title="画像を投げて参照付きで再生成"
        >
          参照を投げる
        </button>
        {cut.userOverride && (
          <button
            type="button"
            onClick={onClearOverride}
            className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-500 hover:border-pink-500/40 hover:text-pink-200"
          >
            上書きを取消
          </button>
        )}
      </div>
    </li>
  );
}

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

function SketchImageBox({
  cut,
  aspectRatio,
}: {
  cut: StoryboardSketchCut;
  aspectRatio: string;
}) {
  const status = cut.sketchStatus ?? "pending";
  const path = cut.sketchImagePath;
  const box = `flex w-full max-w-[640px] items-center justify-center rounded-md border border-[#2a2a2a] bg-[#fcfbf5] ${aspectClass(aspectRatio)}`;
  if (path && status === "done") {
    return (
      <div className="flex justify-center">
        <img
          src={`asset://localhost/${encodeURI(path)}`}
          alt={`sketch cut ${cut.order}`}
          className={`${aspectClass(aspectRatio)} max-h-[60vh] max-w-[640px] rounded-md border border-[#2a2a2a] object-contain bg-[#fcfbf5]`}
        />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="flex justify-center">
        <div className={`${box} flex-col gap-2 text-zinc-500`}>
          <span className="text-sm text-red-400">絵コンテ生成に失敗</span>
          <span className="text-[10px]">後でやり直してください</span>
        </div>
      </div>
    );
  }
  // pending or generating
  return (
    <div className="flex justify-center">
      <div className={`${box} flex-col gap-3 text-zinc-500`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
        <span className="text-[11px]">
          {status === "generating" ? "絵コンテ生成中…" : "順番待ち"}
        </span>
      </div>
    </div>
  );
}

function ReferenceSlot({
  label,
  path,
  onPick,
  onClear,
  required,
}: {
  label: string;
  path: string | undefined;
  onPick: () => void;
  onClear: () => void;
  required?: boolean;
}) {
  return (
    <div className="flex w-24 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onPick}
        className={[
          "flex h-16 w-24 items-center justify-center overflow-hidden rounded-md border transition",
          path
            ? "border-[#2a2a2a]"
            : required
              ? "border-dashed border-pink-500/50 bg-pink-500/5 hover:border-pink-500"
              : "border-dashed border-[#2a2a2a] hover:border-pink-500/40",
        ].join(" ")}
        title={path ? basename(path) : "クリックで画像を選択"}
      >
        {path ? (
          <img
            src={`asset://localhost/${encodeURI(path)}`}
            alt={label}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="text-[10px] text-zinc-500">
            {required ? "選択 (必須)" : "選択"}
          </span>
        )}
      </button>
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-zinc-500">{label}</span>
        {path && (
          <button
            type="button"
            onClick={onClear}
            className="rounded text-[10px] text-zinc-500 hover:text-pink-300"
            title="解除"
            aria-label="解除"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function inferCameraNote(index: number, total: number): string {
  if (index === 0) return "ワイド〜ミディアム / イントロ";
  if (index === total - 1) return "クロースアップ / オチ";
  return "ミディアム / 中継";
}

function inferFilmNotes(index: number, total: number): string[] {
  const notes: string[] = ["キャラクターの一貫性: 直前カットのエンドフレームを参照"];
  if (index > 0) notes.push("180度ルール: 前カットの視線方向を維持");
  if (index === Math.floor(total / 2)) notes.push("B-roll 候補: 状況説明・引きの絵");
  return notes;
}

