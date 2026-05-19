import { useEffect, useMemo, useState } from "react";

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
  const setActiveSketchVersion = useStoryboardRun((s) => s.setActiveSketchVersion);
  const updateSketchCut = useStoryboardRun((s) => s.updateSketchCut);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const setGoal = useStoryboardRun((s) => s.setGoal);
  const sceneConstruction = usePlanChat((s) => s.sceneConstruction);

  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftOverride, setDraftOverride] = useState("");

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

  function handleRegenerateCut(cut: StoryboardSketchCut) {
    // 将来: AI に「カット {order} をこういう内容に書き直して」と部分再依頼する。
    // 現状は意図を明示するトーストだけ。
    useToasts.getState().push({
      kind: "info",
      text: `Cut ${cut.order} の AI 再生成は実装中です。一旦「書き直し」で手書き上書きしてください。`,
      ttlMs: 5000,
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

  const cut = activeVersion.cuts[cursor];
  const total = activeVersion.cuts.length;
  const canProceed = Boolean(goal.characterReferencePath);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* === ヘッダー === */}
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
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
      </header>

      {/* === カット1枚レビュー === */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* 左ナビ */}
        <button
          type="button"
          onClick={() => setCursor((c) => Math.max(0, c - 1))}
          disabled={cursor === 0}
          className={[
            "flex w-10 shrink-0 items-center justify-center rounded-md border transition",
            cursor === 0
              ? "cursor-not-allowed border-[#1f1f1f] text-zinc-700"
              : "border-[#2a2a2a] text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5",
          ].join(" ")}
          aria-label="前のカット"
        >
          <IconChevronLeft />
        </button>

        {/* メインカード */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-md border border-[#242424] bg-[#101010] p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
                Cut {cut.order} · {cut.durationSeconds}s
              </div>
              <div className="mt-1 text-[10px] text-zinc-500">{cut.cameraNote}</div>
            </div>
            <div className="text-[11px] text-zinc-500">
              {cursor + 1} / {total}
            </div>
          </div>

          <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-[#333] bg-[#0d0d0d] p-4 text-center text-sm text-zinc-200">
            {cut.userOverride || cut.visualLayout}
          </div>

          {/* 自由記述エリア */}
          {editing ? (
            <div className="space-y-2">
              <label className="text-[10px] text-zinc-500">自由記述で書き直し</label>
              <textarea
                value={draftOverride}
                onChange={(e) => setDraftOverride(e.target.value)}
                rows={4}
                className="w-full resize-none rounded-md border border-[#2a2a2a] bg-[#0d0d0d] p-3 text-sm text-zinc-200 outline-none focus:border-pink-500/50"
                placeholder="このカットの意図・構図を自分の言葉で書き直す"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => saveEdit(cut)}
                  className="rounded-md bg-pink-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pink-400"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-300 hover:border-pink-500/40"
                >
                  キャンセル
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="text-sm text-zinc-300">
                {cut.userOverride ? (
                  <>
                    <span className="text-[10px] text-pink-300">[手書き上書き] </span>
                    {cut.userOverride}
                  </>
                ) : (
                  cut.intent
                )}
              </div>

              {cut.filmNotes && cut.filmNotes.length > 0 && (
                <ul className="space-y-1">
                  {cut.filmNotes.map((note, i) => (
                    <li key={i} className="text-[11px] text-zinc-500">
                      · {note}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => startEdit(cut)}
                  className="rounded-md border border-pink-500/40 bg-pink-500/10 px-3 py-1.5 text-xs text-pink-200 hover:bg-pink-500/20"
                >
                  書き直し
                </button>
                <button
                  type="button"
                  onClick={() => handleRegenerateCut(cut)}
                  className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-300 hover:border-pink-500/40"
                >
                  このカットを再生成
                </button>
                {cut.userOverride && (
                  <button
                    type="button"
                    onClick={() => clearOverride(cut)}
                    className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-xs text-zinc-500 hover:border-pink-500/40 hover:text-pink-200"
                  >
                    上書きを取消
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* 右ナビ */}
        <button
          type="button"
          onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
          disabled={cursor >= total - 1}
          className={[
            "flex w-10 shrink-0 items-center justify-center rounded-md border transition",
            cursor >= total - 1
              ? "cursor-not-allowed border-[#1f1f1f] text-zinc-700"
              : "border-[#2a2a2a] text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5",
          ].join(" ")}
          aria-label="次のカット"
        >
          <IconChevronRight />
        </button>
      </div>

      {/* === フッター: カット番号ジャンプ + バージョン履歴 === */}
      <footer className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#242424] bg-[#161616] px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {activeVersion.cuts.map((c, i) => (
            <button
              type="button"
              key={c.cutId}
              onClick={() => setCursor(i)}
              className={[
                "h-7 w-7 rounded text-[11px] font-medium transition",
                i === cursor
                  ? "bg-pink-500 text-white"
                  : c.userOverride
                    ? "bg-pink-500/15 text-pink-200 hover:bg-pink-500/25"
                    : "bg-[#1c1c1c] text-zinc-400 hover:bg-pink-500/10",
              ].join(" ")}
              title={c.userOverride ? "手書き上書きあり" : undefined}
            >
              {i + 1}
            </button>
          ))}
        </div>
        {sketchVersions.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">バージョン:</span>
            <div className="flex flex-wrap gap-1">
              {sketchVersions.map((v, i) => (
                <button
                  type="button"
                  key={v.versionId}
                  onClick={() => setActiveSketchVersion(v.versionId)}
                  className={[
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    v.versionId === activeVersion.versionId
                      ? "border-pink-500 bg-pink-500/15 text-pink-200"
                      : "border-[#2a2a2a] text-zinc-400 hover:border-pink-500/30",
                  ].join(" ")}
                >
                  v{i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </footer>
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

// Lucide 風アイコン (viewBox 24, stroke 2, round caps)
function IconChevronLeft() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
