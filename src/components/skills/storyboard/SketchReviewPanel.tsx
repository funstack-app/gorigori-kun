import { useEffect, useMemo } from "react";

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
 * Phase 2: SketchReview
 *
 * STΛCK 指示 (2026-05-20):
 *   - 視覚的に絵コンテとして出す (テキストカードの並びでも絵コンテに見えるよう設計)
 *   - 動画化を見越した余白・カット意図・カメラノートを明示
 *   - 180度ルール / A-roll/B-roll / 視線誘導等の filmNotes が出る
 *   - 1 カットずつ手書きで上書きできる (userOverride)
 *   - 「やり直し」で別バージョンを生成 (sketchVersions に積む)
 *
 * 実装:
 *   - planChat の sceneConstruction を取り込んで初回バージョンを構築
 *   - 不足情報 (cameraNote, filmNotes) は AI から取れない場合はテンプレ
 */
export function SketchReviewPanel() {
  const goal = useStoryboardRun((s) => s.goal);
  const sketchVersions = useStoryboardRun((s) => s.sketchVersions);
  const activeSketchVersionId = useStoryboardRun((s) => s.activeSketchVersionId);
  const pushSketchVersion = useStoryboardRun((s) => s.pushSketchVersion);
  const setActiveSketchVersion = useStoryboardRun((s) => s.setActiveSketchVersion);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);

  const activeVersion: StoryboardSketchVersion | null = useMemo(() => {
    if (sketchVersions.length === 0) return null;
    if (activeSketchVersionId) {
      return sketchVersions.find((v) => v.versionId === activeSketchVersionId) ?? null;
    }
    return sketchVersions[sketchVersions.length - 1];
  }, [sketchVersions, activeSketchVersionId]);

  // 初回マウントでバージョン未生成なら、planChat の sceneConstruction から組み立てる
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

  function handleRegenerate() {
    // AI に再構成を依頼するメッセージを planChat に投げる想定だが、
    // 実装の確定は次イテレーション。ここではトーストでフィードバック。
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
        text:
          "生成にはキャラクターの参照画像が必要です。下の「キャラ参照を選択」から添付してください。",
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
        styleReferencePath:
          target === "style" ? r : goal.styleReferencePath,
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
      styleReferencePath:
        target === "style" ? undefined : goal.styleReferencePath,
    });
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

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-200">Phase 2: 絵コンテレビュー</h2>
          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{goal.summary}</p>
          <p className="mt-2 text-[11px] text-pink-200">
            ディレクターメモ: {activeVersion.directorNotes}
          </p>
        </div>

        {/* 参照画像エリア (キャラ必須 / スタイル任意) */}
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
            disabled={!goal.characterReferencePath}
            className={[
              "rounded-md px-4 py-2 text-sm font-semibold transition",
              goal.characterReferencePath
                ? "bg-pink-500 text-white hover:bg-pink-400"
                : "cursor-not-allowed bg-zinc-700 text-zinc-400",
            ].join(" ")}
            title={
              goal.characterReferencePath
                ? undefined
                : "キャラ参照画像を選択してください"
            }
          >
            この絵コンテで生成 →
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {activeVersion.cuts.map((cut) => (
            <SketchCutCard key={cut.cutId} cut={cut} />
          ))}
        </ol>
      </div>

      {sketchVersions.length > 1 && (
        <footer className="rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
          <div className="text-[11px] text-zinc-500">バージョン履歴:</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {sketchVersions.map((v, i) => (
              <button
                type="button"
                key={v.versionId}
                onClick={() => setActiveSketchVersion(v.versionId)}
                className={[
                  "rounded-full border px-2 py-1 text-[11px]",
                  v.versionId === activeVersion.versionId
                    ? "border-pink-500 bg-pink-500/15 text-pink-200"
                    : "border-[#2a2a2a] text-zinc-400 hover:border-pink-500/30",
                ].join(" ")}
              >
                v{i + 1}
              </button>
            ))}
          </div>
        </footer>
      )}
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
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function SketchCutCard({ cut }: { cut: StoryboardSketchCut }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#1a1a1a] p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
          Cut {cut.order} · {cut.durationSeconds}s
        </div>
        <div className="text-[10px] text-zinc-500">{cut.cameraNote}</div>
      </div>

      {/* 絵コンテ風ボックス: テキストでも枠付きで提示 */}
      <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-[#333] bg-[#0d0d0d] p-3 text-center text-xs text-zinc-300">
        {cut.visualLayout}
      </div>

      <div className="text-xs text-zinc-300">{cut.intent}</div>

      {cut.filmNotes && cut.filmNotes.length > 0 && (
        <ul className="space-y-1">
          {cut.filmNotes.map((note, i) => (
            <li key={i} className="text-[10px] text-zinc-500">
              · {note}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// AI から取れない時のフォールバック推論。映像文脈の最低限を保つ。
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
