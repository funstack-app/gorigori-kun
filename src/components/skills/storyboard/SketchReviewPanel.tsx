import { convertFileSrc } from "@tauri-apps/api/core";
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
import { useImagePreview } from "../../../lib/store/imagePreview";
import { useWorkspace } from "../../../lib/store/workspace";
import { CandidatesSelect } from "./CandidatesSelect";
import { CardSizeSlider, gridColsForAspect } from "./cardSize";
import type {
  StoryboardCameraAngle,
  StoryboardCameraMotion,
  StoryboardSketchCut,
  StoryboardSketchVersion,
  StoryboardShotType,
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
  // 2026-07-28: カードサイズはストーリーカット3画面で共有 (workspace ストア / localStorage 永続)
  const storyboardCardSize = useWorkspace((s) => s.storyboardCardSize);
  const sketchVersions = useStoryboardRun((s) => s.sketchVersions);
  const activeSketchVersionId = useStoryboardRun((s) => s.activeSketchVersionId);
  const pushSketchVersion = useStoryboardRun((s) => s.pushSketchVersion);
  const confirmSketchVersion = useStoryboardRun((s) => s.confirmSketchVersion);
  const updateSketchCut = useStoryboardRun((s) => s.updateSketchCut);
  const sceneGroups = useStoryboardRun((s) => s.sceneGroups);
  const cutDisplayOrder = useStoryboardRun((s) => s.cutDisplayOrder);
  const setCutDisplayOrder = useStoryboardRun((s) => s.setCutDisplayOrder);
  // P10: 枚数選択 (絵コンテ用 / 本生成用)
  const sketchCandidatesPerCut = useStoryboardRun((s) => s.sketchCandidatesPerCut);
  const setSketchCandidatesPerCut = useStoryboardRun((s) => s.setSketchCandidatesPerCut);
  const generationCandidatesPerCut = useStoryboardRun((s) => s.generationCandidatesPerCut);
  const setGenerationCandidatesPerCut = useStoryboardRun((s) => s.setGenerationCandidatesPerCut);
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
  // ラフ消失修正 (2026-07-28): 本生成 run 中はラフ再生成を止める。イベント振り分けは
  // 現在 run の params.sketchMode で決まるため、本生成中に sketch 再生成すると
  // take が本生成側 cuts Map に混入する。
  const generationRunStartedAt = useStoryboardRun((s) => s.generationRunStartedAt);

  // ストア (cuts Map) から絵コンテ画像を読む
  // storyboard.run(sketch_mode=true) はイベントを既存ルートで流すので、
  // cuts Map の takes[0].imagePath を sketchImagePath として参照する
  // P19a (2026-05-21): 絵コンテ run 専用の sketchCuts を購読する (本生成 cuts と完全分離)
  const storeCuts = useStoryboardRun((s) => s.sketchCuts);
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
    if (!goal) return;
    // ラフ消失修正 (2026-07-28): 「1つでもバージョンがあれば return」から
    // 「現在の goal に紐づくバージョンがあれば return」へ。本生成開始で reset を
    // 呼ばなくなったため、前ストーリーの残留は破棄ではなく表示選択で防ぐ。
    const goalKey = goal.summary.slice(0, 200);
    if (sketchVersions.some((v) => v.fromGoalSummary === goalKey)) return;
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
        // AI が sceneConstruction に出した shot_type/camera_motion/camera_angle を
        // sketch メタに引き継ぐ。これを埋めないと buildI2vPrompt が全カット
        // 「medium shot / locked camera」固定になり、動画タブ送り/i2vコピーの
        // カメラワークがカットごとに変わらなかった (#5/i2v固定 2026-06-07)。
        // AI が想定外の値を返しても壊れないよう、enum 許可リストでバリデートする。
        shotType: toShotType(cut.shot_type),
        cameraMotion: toCameraMotion(cut.camera_motion),
        cameraAngle: toCameraAngle(cut.camera_angle),
      })),
    };
    pushSketchVersion(version);
  }, [sceneConstruction, goal, sketchVersions, pushSketchVersion]);

  // カーソルが範囲外になったら 0 に戻す
  useEffect(() => {
    if (!activeVersion) return;
    if (cursor >= activeVersion.cuts.length) setCursor(0);
  }, [activeVersion, cursor]);

  // === 絵コンテ生成 (P7 STΛCK 指示 2026-05-20: 明示ボタン化) ===
  //
  // 自動 useEffect は撤廃。「絵コンテを生成」ボタンを押すまで生成しない。
  // 理由: Phase 2 入場時に自動で走ると、ユーザーが「この絵コンテで生成」を
  // 押す前から絵コンテも本番も走るような印象になり、UX が一方通行ではなくなる。
  // ルートを明確にするため、絵コンテはユーザー意思で開始する。
  async function startSketchGeneration() {
    if (sketchStarted || sketchStarting) return;
    if (!activeVersion) return;
    if (!goal?.characterReferencePath) {
      useToasts.getState().push({
        kind: "error",
        text: "キャラ参照画像を選んでから絵コンテを生成してください。",
        ttlMs: 4000,
      });
      return;
    }
    if (!sceneConstruction) return;

    const allDone = activeVersion.cuts.every((c) => c.sketchImagePath);
    if (allDone) {
      setSketchRunStartedAt(Date.now());
      return;
    }

    setSketchStarting(true);
    let issuedRunId: string | null = null;
    try {
      const runId = crypto.randomUUID();
      issuedRunId = runId;
      const params = {
        runId,
        storyPrompt: goal.summary || "ストーリーカット",
        characterReferenceImage: goal.characterReferencePath,
        styleReferenceImage: goal.styleReferencePath,
        // FB#3 (2026-06-06): 複数キャラ/スタイル参照 (後方互換: 単数も維持)。
        characterReferenceImages: goal.characterReferencePaths,
        styleReferenceImages: goal.styleReferencePaths,
        aspectRatio: goal.aspectRatio,
        durationSeconds: goal.durationSeconds,
        tempo: goal.tempo,
        // P10: ユーザー選択値を反映 (デフォルト 1)
        candidatesPerCut: sketchCandidatesPerCut,
        cwd: undefined,
        sceneConstruction,
        sketchMode: true,
      };
      useStoryboardRun.getState().beginRun(runId, params);
      await storyboard.run(params);
      setSketchRunStartedAt(Date.now());
      useToasts.getState().push({
        kind: "info",
        text: "絵コンテを生成しています…",
        ttlMs: 2400,
      });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      const run = useStoryboardRun.getState();
      if (issuedRunId && run.activeRunId === issuedRunId) {
        useStoryboardRun.setState({
          activeRunId: null,
          status: "failed",
          lastError: message,
        });
      }
      useToasts.getState().push({
        kind: "error",
        text: `絵コンテ生成の起動に失敗: ${message}`,
        ttlMs: 6000,
      });
    } finally {
      setSketchStarting(false);
    }
  }

  // === 生成イベント (cuts Map) → 各カットの sketchImagePath を更新 ===
  // P9 + P14 (2026-05-20 STΛCK 指示): 絵コンテ画像は本生成で採用したやつに
  // 差し替えない。以下3重ガードで混線を完全排除:
  //  1. sketchStarted (絵コンテ生成が開始されている)
  //  2. curParams.sketchMode === true (現在のrunが絵コンテモード)
  //  3. 全カット done になったら以後同期しない (storeCuts が何であっても触らない)
  useEffect(() => {
    if (!activeVersion) return;
    if (!sketchStarted) return;
    const curParams = useStoryboardRun.getState().params;
    if (!curParams?.sketchMode) return; // 本番 run / runなし時は絵コンテ更新しない

    // 全カット done に達したら同期完全停止 (混線防止の最終ガード)
    const allDone = activeVersion.cuts.every(
      (c) => c.sketchStatus === "done" && c.sketchImagePath,
    );
    if (allDone) return;

    for (const cut of activeVersion.cuts) {
      const stored = storeCuts.get(cut.cutId);
      if (!stored) continue;
      // 既に done のカットはそのまま保持
      if (cut.sketchStatus === "done" && cut.sketchImagePath) continue;
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
          ...({
            sketchImagePath: latest,
            sketchStatus: wantStatus,
          } as Partial<StoryboardSketchCut>),
        });
      }
    }
  }, [storeCuts, storeStatus, activeVersion, sketchStarted, updateSketchCut]);

  // === S3 issue-1 (2026-07-28): 採用ゲート式の本生成 ===
  //
  // 「採用済み」= ラフが実際に出来上がっている (sketchStatus === "done") カット。
  // このパネルにはカット単位の採用トグルが無く、書き直し/再生成で作り直した
  // 結果を残す = 採用、という運用になっているため、done を採用済みとして扱う。
  const adoptedCutIds = useMemo(
    () =>
      (activeVersion?.cuts ?? [])
        .filter((c) => c.sketchStatus === "done" && c.sketchImagePath)
        .map((c) => c.cutId),
    [activeVersion],
  );

  async function sendCutsToProduction(cutIds: string[]) {
    if (!goal?.characterReferencePath) {
      useToasts.getState().push({
        kind: "error",
        text: "生成にはキャラクターの参照画像が必要です。下の「キャラ参照」から添付してください。",
        ttlMs: 6000,
      });
      return;
    }
    // 本生成の参照に使えるのは「確定した絵コンテ」だけ (B1)。採用ゲートから
    // 送る場合も、現在のバージョンを確定させてから送る。
    if (activeVersion && !activeVersion.confirmed) {
      confirmSketchVersion(activeVersion.versionId);
    }
    await useStoryboardRun.getState().startProductionForCuts(cutIds);
  }

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
    // P19b (2026-05-21 STΛCK指示): 絵コンテを「確定」状態にしてから Phase 3 へ。
    // confirmed=true の絵コンテだけが本生成の sketchReferences として使われる。
    // これで「絵コンテ生成中のまま本生成に画像が流れ込む」現象を防ぐ。
    if (!allDone) {
      useToasts.getState().push({
        kind: "error",
        text: "絵コンテがまだ全カット生成されていません。完了を待ってから確定してください。",
        ttlMs: 5000,
      });
      return;
    }
    confirmSketchVersion(activeVersion.versionId);
    useToasts.getState().push({
      kind: "success",
      text: "絵コンテを確定しました。本生成に進みます。",
      ttlMs: 3000,
    });
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
    if (generationRunStartedAt !== null) {
      useToasts.getState().push({
        kind: "warn",
        text: "本生成が始まっているため、ラフの再生成はできません。",
        ttlMs: 4000,
      });
      return;
    }
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
      updateSketchCut(cut.cutId, { sketchStatus: "failed" });
      useToasts.getState().push({
        kind: "error",
        text: `再生成に失敗: ${(e as Error)?.message ?? e}`,
        ttlMs: 5000,
      });
    }
  }

  // === シーン分け (P3a) / 並べ替え (P3b) ===
  // [React Hooks 規則] useMemo / useSensors は early return の前に配置する必要がある。
  // activeVersion === null の場合は空配列を返し、レンダリング側で early return する。
  const groupedCuts = useMemo(() => {
    if (!activeVersion) return [];
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
  }, [activeVersion, sceneGroups, cutDisplayOrder]);

  // D&D で並べ替え。ユーザー D&D が走った瞬間に flat 表示に切り替わる。
  // [React Hooks 規則] early return の前に置く。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

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
          {!sketchStarted ? (
            // 絵コンテ未生成: 「絵コンテを生成」ボタン + 枚数セレクタ
            <div className="flex items-center gap-2">
              <CandidatesSelect
                value={sketchCandidatesPerCut}
                onChange={setSketchCandidatesPerCut}
                label="絵コンテ"
                disabled={sketchStarting || !canProceed}
              />
              <button
                type="button"
                onClick={startSketchGeneration}
                disabled={sketchStarting || !canProceed}
                className={[
                  "rounded-md px-4 py-2 text-sm font-semibold transition",
                  canProceed && !sketchStarting
                    ? "bg-pink-500 text-white hover:bg-pink-400"
                    : "cursor-not-allowed bg-zinc-700 text-zinc-400",
                ].join(" ")}
                title={
                  canProceed
                    ? `絵コンテを ${sketchCandidatesPerCut} 枚ずつ生成 (キャラ参照画像が必要)`
                    : "キャラ参照画像を選択してください"
                }
              >
                {sketchStarting ? "起動中…" : "絵コンテを生成 →"}
              </button>
            </div>
          ) : (
            // 絵コンテ生成済み: 「別案を依頼」+「この絵コンテで本生成」 + 本生成枚数
            <>
              <button
                type="button"
                onClick={handleRegenerate}
                className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
              >
                別案を依頼
              </button>
              <div className="flex items-center gap-2">
                <CandidatesSelect
                  value={generationCandidatesPerCut}
                  onChange={setGenerationCandidatesPerCut}
                  label="本生成"
                  disabled={!canProceed}
                />
                <button
                  type="button"
                  onClick={handleProceed}
                  disabled={!canProceed || !allDone}
                  className={[
                    "rounded-md px-4 py-2 text-sm font-semibold transition",
                    canProceed && allDone
                      ? "bg-pink-500 text-white hover:bg-pink-400"
                      : "cursor-not-allowed bg-zinc-700 text-zinc-400",
                  ].join(" ")}
                  title={
                    !allDone
                      ? "絵コンテが全カット完了するまで待ってください"
                      : !canProceed
                        ? "キャラ参照画像を選択してください"
                        : `絵コンテを確定して本生成 (${generationCandidatesPerCut}案/カット) を開始`
                  }
                >
                  {allDone ? "絵コンテを確定して本生成 →" : "絵コンテ完成待ち…"}
                </button>
              </div>
            </>
          )}
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
            <div className="flex items-center gap-2">
              {/* カードサイズスライダー (大⇔小)。本生成進捗・最終確認と同じ値を共有する */}
              <CardSizeSlider />
              <span className="text-zinc-500">
                {Math.round(allDone ? 100 : progressPercent)}%
              </span>
            </div>
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
                  <ol
                    className={`grid gap-3 ${gridColsForAspect(goal.aspectRatio, storyboardCardSize)}`}
                  >
                    {group.cuts.map(({ cut: c, index: i }) => {
                      // P10: プレビュー時の兄弟リスト = activeVersion 内の全
                      //      sketchImagePath を順に並べる。
                      const siblingPaths = activeVersion.cuts
                        .map((x) => x.sketchImagePath)
                        .filter((p): p is string => Boolean(p));
                      return (
                        <SortableSketchCutCard
                          key={c.cutId}
                          cut={c}
                          index={i}
                          aspectRatio={goal.aspectRatio}
                          siblingPaths={siblingPaths}
                          onEdit={() => {
                            setCursor(i);
                            startEdit(c);
                          }}
                          onRegenerate={() => handleRegenerateCut(c)}
                          onRegenerateWithRefs={(refs) => handleRegenerateCut(c, refs)}
                          onClearOverride={() => clearOverride(c)}
                          onSendToProduction={() => void sendCutsToProduction([c.cutId])}
                        />
                      );
                    })}
                  </ol>
                </SortableContext>
              </section>
            ))}
          </div>
        </DndContext>
      </div>

      {/* === S3 issue-1: 採用済みカットの一括送り === */}
      <footer className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-[#242424] bg-[#161616] px-4 py-2">
        <span className="text-[11px] text-zinc-500">
          ラフが完成したカットから順に本番へ送れます (全カット一括は上の「絵コンテを確定して本生成」)。
        </span>
        <button
          type="button"
          onClick={() => void sendCutsToProduction(adoptedCutIds)}
          disabled={adoptedCutIds.length === 0}
          className={[
            "shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition",
            adoptedCutIds.length > 0
              ? "bg-emerald-500 text-white hover:bg-emerald-400"
              : "cursor-not-allowed bg-zinc-700 text-zinc-400",
          ].join(" ")}
          title={
            adoptedCutIds.length > 0
              ? "採用済みのカットだけを本番生成に送る"
              : "採用済みのカットがまだありません"
          }
        >
          採用済み{adoptedCutIds.length}枚をまとめて本番へ
        </button>
      </footer>

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
  siblingPaths: string[];
  onEdit: () => void;
  onRegenerate: () => void;
  onRegenerateWithRefs: (refs: string[]) => void;
  onClearOverride: () => void;
  onSendToProduction: () => void;
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
  siblingPaths,
  onEdit,
  onRegenerate,
  onRegenerateWithRefs,
  onClearOverride,
  onSendToProduction,
}: {
  cut: StoryboardSketchCut;
  index: number;
  aspectRatio: string;
  siblingPaths: string[];
  onEdit: () => void;
  onRegenerate: () => void;
  onRegenerateWithRefs: (refs: string[]) => void;
  onClearOverride: () => void;
  onSendToProduction: () => void;
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

      <SketchImageBox
        cut={cut}
        aspectRatio={aspectRatio}
        onDoubleClick={() => {
          if (cut.sketchImagePath) {
            useImagePreview
              .getState()
              .open(cut.sketchImagePath, siblingPaths);
          }
        }}
      />

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
        {/* S3 issue-1: 採用ゲート式の本生成。このカット1枚だけ本番へ送る。
            ラフが出来上がっている (done) カットだけ押せる。 */}
        <button
          type="button"
          onClick={onSendToProduction}
          disabled={status !== "done"}
          className={[
            "rounded border px-2 py-1 text-[10px] transition",
            status === "done"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
              : "cursor-not-allowed border-[#2a2a2a] text-zinc-600",
          ].join(" ")}
          title={
            status === "done"
              ? "このカットのラフを採用して本番生成に送る"
              : "ラフが完成してから本番へ送れます"
          }
        >
          このカットを本番へ
        </button>
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
  onDoubleClick,
}: {
  cut: StoryboardSketchCut;
  aspectRatio: string;
  onDoubleClick?: () => void;
}) {
  const status = cut.sketchStatus ?? "pending";
  const path = cut.sketchImagePath;
  // P8 (2026-05-20): w-full でカード幅をフル使う + アスペクト比でカード高を決める。
  // これでカード全体が常に正しいアスペクトで描画される。
  const box = `flex w-full items-center justify-center rounded-md border border-[#2a2a2a] bg-[#fcfbf5] ${aspectClass(aspectRatio)}`;
  if (path && status === "done") {
    return (
      <div className="w-full">
        <img
          src={convertFileSrc(path)}
          alt={`sketch cut ${cut.order}`}
          onDoubleClick={onDoubleClick}
          className={`${aspectClass(aspectRatio)} w-full cursor-zoom-in rounded-md border border-[#2a2a2a] bg-[#fcfbf5] object-cover`}
          title="ダブルクリックでプレビュー"
        />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="w-full">
        <div className={`${box} flex-col gap-2 text-zinc-500`}>
          <span className="text-sm text-red-400">絵コンテ生成に失敗</span>
          <span className="text-[10px]">後でやり直してください</span>
        </div>
      </div>
    );
  }
  // pending or generating
  return (
    <div className="w-full">
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
        // P20b (2026-05-21): 画像があるときダブルクリックで拡大プレビュー
        onDoubleClick={
          path
            ? (e) => {
                e.stopPropagation();
                useImagePreview.getState().open(path, [path]);
              }
            : undefined
        }
        className={[
          "flex h-16 w-24 items-center justify-center overflow-hidden rounded-md border transition",
          path
            ? "cursor-zoom-in border-[#2a2a2a]"
            : required
              ? "border-dashed border-pink-500/50 bg-pink-500/5 hover:border-pink-500"
              : "border-dashed border-[#2a2a2a] hover:border-pink-500/40",
        ].join(" ")}
        title={
          path
            ? `${basename(path)} (ダブルクリックで拡大)`
            : "クリックで画像を選択"
        }
      >
        {path ? (
          <img
            src={convertFileSrc(path)}
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

// AI が出した自由文字列 (shot_type / camera_motion / camera_angle) を、
// 既知の enum 値に正規化する。enum に無い値は undefined を返し、
// buildI2vPrompt 側のデフォルト (medium shot / static) にフォールバックさせる。
// 正規化は「小文字化 + 空白/ハイフンを _ に寄せる」だけ。これで
// "Pan Left"→pan_left, "dolly-in"→dolly_in 等の表記揺れは拾えるが、
// 単語の増減 (例: "medium shot"→medium_shot は enum medium と不一致) は
// 拾わず default に落ちる。AI プロンプト(planChat.ts)が enum トークンを
// 厳密指定しているため、実運用ではこれで十分。
const SHOT_TYPES: readonly StoryboardShotType[] = [
  "extreme_close",
  "close",
  "medium",
  "full",
  "wide",
  "extreme_wide",
];
const CAMERA_MOTIONS: readonly StoryboardCameraMotion[] = [
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "handheld",
];
const CAMERA_ANGLES: readonly StoryboardCameraAngle[] = [
  "front",
  "side",
  "back",
  "three_quarter",
  "high",
  "low",
  "dutch",
];

function normalizeEnumKey(raw: string | undefined): string | undefined {
  const v = raw?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return v && v.length > 0 ? v : undefined;
}

function toShotType(raw: string | undefined): StoryboardShotType | undefined {
  const v = normalizeEnumKey(raw);
  return v && (SHOT_TYPES as readonly string[]).includes(v)
    ? (v as StoryboardShotType)
    : undefined;
}

function toCameraMotion(raw: string | undefined): StoryboardCameraMotion | undefined {
  const v = normalizeEnumKey(raw);
  return v && (CAMERA_MOTIONS as readonly string[]).includes(v)
    ? (v as StoryboardCameraMotion)
    : undefined;
}

function toCameraAngle(raw: string | undefined): StoryboardCameraAngle | undefined {
  const v = normalizeEnumKey(raw);
  return v && (CAMERA_ANGLES as readonly string[]).includes(v)
    ? (v as StoryboardCameraAngle)
    : undefined;
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
