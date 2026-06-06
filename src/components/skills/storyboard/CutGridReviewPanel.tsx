import { useMemo } from "react";

import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useActiveProject } from "../../../lib/store/activeProject";
import { useProjects } from "../../../lib/store/projects";
import { useImages } from "../../../lib/store/images";
import { useToasts } from "../../../lib/store/toasts";
import { sendImageToPlanForRediscuss } from "../../../lib/sendToPlan";
import {
  sendCutToVideoTab,
  sendCutsBatchToVideoTab,
} from "../../../lib/storyboard/sendCutToVideo";
import type { StoryboardSketchCut } from "../../../lib/storyboard/types";

/**
 * P13 (2026-05-20): i2v 用カメラワークプロンプトを構築する。
 * Codex セッション2 の E「i2v 動作端点設計」の要素を組み立てる。
 * 出力例:
 *   "Camera: medium shot, slow dolly in toward subject's face.
 *    Subject: starts from neutral standing pose, raises right hand slowly to reach the doorknob.
 *    Motion: smooth, 2.5 seconds duration.
 *    Aspect: 16:9. Keep character identity, costume, and lighting consistent with the source image."
 */
function buildI2vPrompt(
  sketch: StoryboardSketchCut | null,
  cut: { description?: string; duration?: number },
  aspectRatio: string,
  cutIndex: number,
): string {
  const shotInfo = sketch?.shotType ?? "medium shot";
  const camera = sketch?.cameraMotion ?? "static";
  const cameraNote = sketch?.cameraNote ?? "stable camera";
  const intent = sketch?.intent || cut.description || "";
  const duration = cut.duration ?? 2.5;
  const cameraVerb = (() => {
    switch (camera) {
      case "pan_left":
        return "slow pan to the left";
      case "pan_right":
        return "slow pan to the right";
      case "tilt_up":
        return "smooth tilt up";
      case "tilt_down":
        return "smooth tilt down";
      case "dolly_in":
        return "gentle dolly push-in toward the subject";
      case "dolly_out":
        return "gentle dolly pull-back from the subject";
      case "handheld":
        return "subtle handheld float";
      case "static":
      default:
        return "locked camera, no movement";
    }
  })();
  return [
    `Cut ${cutIndex + 1} — Image-to-Video prompt`,
    `Camera: ${shotInfo}, ${cameraVerb}. ${cameraNote}.`,
    intent ? `Subject: ${intent}` : null,
    `Duration: approx ${duration}s.`,
    `Aspect ratio: ${aspectRatio}.`,
    `Maintain character identity, costume color, lighting, and screen direction consistent with the source frame. Avoid identity drift, costume changes, or background teleportation.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Phase 4: CutGridReview
 *
 * STΛCK 指示 (2026-05-20):
 *   - 完成カットを並べて最終確認
 *   - 各カットごとに「採用 take の切替」「やり直し」「企画で再検討」「プロジェクトに保存」
 *   - 全カット一括で「プロジェクトに保存」も用意
 *   - 上部に参照画像 (キャラ・スタイル) を表示し続けて一貫性確認
 */
export function CutGridReviewPanel() {
  const goal = useStoryboardRun((s) => s.goal);
  const cuts = useStoryboardRun((s) => s.cuts);
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const selectTake = useStoryboardRun((s) => s.selectTake);
  const regenerateCut = useStoryboardRun((s) => s.regenerateCut);
  const setPhase = useStoryboardRun((s) => s.setPhase);
  const activeProjectId = useActiveProject((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const addItem = useProjects((s) => s.addItem);
  // B4: 確定フォルダ (確定カット画像) を Finder で開くのに使う。
  const revealInFinder = useImages((s) => s.revealInFinder);

  const orderedCuts = useMemo(() => Array.from(cuts.values()), [cuts]);
  // P13: 絵コンテバージョンから cutId → SketchCut のマップを引いて i2v プロンプトに使う
  const sketchVersions = useStoryboardRun((s) => s.sketchVersions);
  const activeSketchVersionId = useStoryboardRun((s) => s.activeSketchVersionId);
  // B1' 補完: 本生成開始時に撮った確定絵コンテメタのスナップショット。
  // reset() で sketchVersions が破棄されてもカメラワーク等を失わない。
  const generationCutSketchMeta = useStoryboardRun((s) => s.generationCutSketchMeta);
  const sketchByCutId = useMemo(() => {
    const map = new Map<string, StoryboardSketchCut>();
    // 優先: 本生成 run スナップショット (今の run に紐づく確定絵コンテ)。
    for (const [cutId, cut] of Object.entries(generationCutSketchMeta)) {
      map.set(cutId, cut);
    }
    // フォールバック: live sketchVersions (まだ reset 前の経路用)。
    if (map.size === 0) {
      const active =
        sketchVersions.find((v) => v.versionId === activeSketchVersionId) ??
        sketchVersions[sketchVersions.length - 1] ??
        null;
      if (active) {
        for (const c of active.cuts) {
          map.set(c.cutId, c);
        }
      }
    }
    return map;
  }, [generationCutSketchMeta, sketchVersions, activeSketchVersionId]);
  const confirmedAll = orderedCuts.every((c) => c.status === "confirmed");
  const allTakeImages = useMemo(
    () =>
      orderedCuts
        .map((c) => {
          const adopted = c.takes.find((t) => t.takeId === c.selectedTakeId);
          return adopted?.imagePath ?? c.takes[0]?.imagePath;
        })
        .filter((p): p is string => Boolean(p)),
    [orderedCuts],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  function saveAllToProject() {
    if (!activeProjectId) {
      useToasts.getState().push({
        kind: "error",
        text: "保存先プロジェクトが選ばれていません。",
        ttlMs: 4000,
      });
      return;
    }
    let saved = 0;
    orderedCuts.forEach((c, i) => {
      const adopted = c.takes.find((t) => t.takeId === c.selectedTakeId) ?? c.takes[0];
      if (!adopted) return;
      addItem(activeProjectId, {
        imagePath: adopted.imagePath,
        prompt: goal?.summary,
        note: `storyboard cut ${i + 1} (${c.cutId})`,
      });
      saved += 1;
    });
    useToasts.getState().push({
      kind: "success",
      text: `${saved} カットをプロジェクトに保存しました。`,
      ttlMs: 3000,
    });
  }

  // P13: 全カットの i2v プロンプトを一括コピー
  function copyAllI2vPrompts() {
    const lines: string[] = [];
    orderedCuts.forEach((c, i) => {
      const sketch = sketchByCutId.get(c.cutId) ?? null;
      const duration = sketch?.durationSeconds ?? 2.5;
      const prompt = buildI2vPrompt(
        sketch,
        { description: sketch?.intent, duration },
        goal?.aspectRatio ?? "16:9",
        i,
      );
      lines.push(prompt);
      lines.push(""); // separator
    });
    const text = lines.join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      useToasts.getState().push({
        kind: "success",
        text: `${orderedCuts.length} カット分の i2v プロンプトをコピーしました。`,
        ttlMs: 3000,
      });
    });
  }

  function copySingleI2vPrompt(cutId: string, cutIndex: number) {
    const sketch = sketchByCutId.get(cutId) ?? null;
    const duration = sketch?.durationSeconds ?? 2.5;
    const prompt = buildI2vPrompt(
      sketch,
      { description: sketch?.intent, duration },
      goal?.aspectRatio ?? "16:9",
      cutIndex,
    );
    void navigator.clipboard.writeText(prompt).then(() => {
      useToasts.getState().push({
        kind: "success",
        text: `Cut ${cutIndex + 1} の i2v プロンプトをコピーしました。`,
        ttlMs: 2500,
      });
    });
  }

  function saveCutToProject(cutId: string, imagePath: string, order: number) {
    if (!activeProjectId) {
      useToasts.getState().push({
        kind: "error",
        text: "保存先プロジェクトが選ばれていません。",
        ttlMs: 4000,
      });
      return;
    }
    addItem(activeProjectId, {
      imagePath,
      prompt: goal?.summary,
      note: `storyboard cut ${order} (${cutId})`,
    });
    useToasts.getState().push({
      kind: "success",
      text: `Cut ${order} を保存しました。`,
      ttlMs: 2500,
    });
  }

  // 採用 take の画像パスを引く (selectedTake → なければ先頭 take)。
  function adoptedImageOf(cut: (typeof orderedCuts)[number]): string | undefined {
    const adopted = cut.takes.find((t) => t.takeId === cut.selectedTakeId) ?? cut.takes[0];
    return adopted?.imagePath;
  }

  // B3: 単一の確定カットを動画タブの i2v 元画像へ送る。
  function sendCutToVideo(cut: (typeof orderedCuts)[number], cutIndex: number) {
    const imagePath = adoptedImageOf(cut);
    if (!imagePath) {
      useToasts.getState().push({
        kind: "error",
        text: "このカットには採用画像がありません。",
        ttlMs: 4000,
      });
      return;
    }
    const sketch = sketchByCutId.get(cut.cutId) ?? null;
    const prompt = buildI2vPrompt(
      sketch,
      { description: sketch?.intent, duration: sketch?.durationSeconds ?? 2.5 },
      goal?.aspectRatio ?? "16:9",
      cutIndex,
    );
    sendCutToVideoTab({ imagePath, prompt });
  }

  // B5: 確定カットをまとめて動画タブへ送る (一括動画化)。
  async function sendAllConfirmedToVideo() {
    const batch = orderedCuts
      .map((c, i) => {
        const imagePath = adoptedImageOf(c);
        if (!imagePath) return null;
        const sketch = sketchByCutId.get(c.cutId) ?? null;
        const prompt = buildI2vPrompt(
          sketch,
          { description: sketch?.intent, duration: sketch?.durationSeconds ?? 2.5 },
          goal?.aspectRatio ?? "16:9",
          i,
        );
        return { imagePath, prompt, label: `Cut ${i + 1}` };
      })
      .filter((x): x is { imagePath: string; prompt: string; label: string } => x !== null);
    await sendCutsBatchToVideoTab({ cuts: batch });
  }

  // B4: 確定カット画像が入っているフォルダを Finder で開く。
  // 確定カットは生成時に ~/.codex/... 配下へ書き出されており、その実体パスを
  // Finder で開いて確定フォルダとして露出する。
  async function openConfirmedFolder() {
    const first = orderedCuts.map(adoptedImageOf).find((p): p is string => Boolean(p));
    if (!first) {
      useToasts.getState().push({
        kind: "error",
        text: "確定カットの画像がまだありません。",
        ttlMs: 4000,
      });
      return;
    }
    await revealInFinder(first);
  }

  if (!goal) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">先にゴールを確定してください。</div>
      </div>
    );
  }

  if (orderedCuts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <div className="text-sm">生成完了カットがまだありません。</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex items-start justify-between gap-4 rounded-md border border-[#242424] bg-[#161616] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Phase 4: 最終確認</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {orderedCuts.length} カット
            {confirmedAll ? " · 全カット採用済み" : " · 一部 take を切り替え可能"}
            {activeProject && ` · 保存先: ${activeProject.name}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setPhase("generation")}
            className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
          >
            ← 生成に戻る
          </button>
          <button
            type="button"
            onClick={saveAllToProject}
            className="rounded-md bg-pink-500 px-4 py-2 text-sm font-semibold text-white hover:bg-pink-400"
          >
            一括でプロジェクトに保存
          </button>
          {/* P13: i2v 用カメラワークプロンプトを一括コピー */}
          <button
            type="button"
            onClick={copyAllI2vPrompts}
            className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
            title="全カットの Image-to-Video プロンプトをクリップボードへ"
          >
            i2v プロンプト一括コピー
          </button>
          {/* B5: 確定カットを一括で動画タブへ送る */}
          <button
            type="button"
            onClick={() => void sendAllConfirmedToVideo()}
            className="rounded-md border border-pink-500/40 bg-pink-500/10 px-3 py-2 text-xs font-semibold text-pink-100 hover:bg-pink-500/20"
            title="確定カットを動画タブへ送り、全カット分の i2v プロンプトをコピー"
          >
            一括で動画化 →
          </button>
          {/* B4: 確定カットのフォルダを開く */}
          <button
            type="button"
            onClick={() => void openConfirmedFolder()}
            className="rounded-md border border-[#2a2a2a] px-3 py-2 text-xs text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5"
            title="確定カット画像の保存フォルダを開く"
          >
            確定フォルダを開く
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-4">
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orderedCuts.map((c, i) => {
            const adopted =
              c.takes.find((t) => t.takeId === c.selectedTakeId) ?? c.takes[0];
            if (!adopted) return null;
            return (
              <li
                key={c.cutId}
                className="flex flex-col gap-2 rounded-md border border-[#242424] bg-[#1a1a1a] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-pink-200">
                    Cut {i + 1}
                  </span>
                  <span
                    className={[
                      "text-[11px]",
                      c.status === "confirmed" ? "text-emerald-300" : "text-zinc-400",
                    ].join(" ")}
                  >
                    {c.status === "confirmed" ? "採用済み" : "未採用"}
                  </span>
                </div>

                <div className="aspect-video overflow-hidden rounded-md bg-[#0d0d0d]">
                  <img
                    src={`asset://localhost/${encodeURI(adopted.imagePath)}`}
                    alt={`cut-${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                </div>

                {c.takes.length > 1 && (
                  <div className="flex gap-1">
                    {c.takes.map((t, ti) => (
                      <button
                        type="button"
                        key={t.takeId}
                        onClick={() => selectTake(c.cutId, t.takeId)}
                        className={[
                          "h-12 w-16 overflow-hidden rounded border",
                          t.takeId === (c.selectedTakeId ?? c.takes[0]?.takeId)
                            ? "border-pink-500"
                            : "border-[#2a2a2a]",
                        ].join(" ")}
                        title={`take ${ti + 1}`}
                      >
                        <img
                          src={`asset://localhost/${encodeURI(t.imagePath)}`}
                          alt={`take-${ti + 1}`}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1">
                  {c.status !== "confirmed" && (
                    <button
                      type="button"
                      onClick={() => adoptTake(c.cutId)}
                      className="rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-[10px] text-pink-200 hover:bg-pink-500/20"
                    >
                      採用
                    </button>
                  )}
                  {/* B3: このカットを動画タブの i2v 元画像へ送る */}
                  <button
                    type="button"
                    onClick={() => sendCutToVideo(c, i)}
                    className="rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-[10px] font-semibold text-pink-100 hover:bg-pink-500/20"
                    title="このカット画像を動画生成タブの元画像にセットして切り替える"
                  >
                    動画タブへ送る
                  </button>
                  <button
                    type="button"
                    onClick={() => regenerateCut(c.cutId)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    やり直し
                  </button>
                  <button
                    type="button"
                    onClick={() => sendImageToPlanForRediscuss(adopted.imagePath)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    企画で再検討
                  </button>
                  <button
                    type="button"
                    onClick={() => saveCutToProject(c.cutId, adopted.imagePath, i + 1)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                  >
                    1 枚保存
                  </button>
                  <button
                    type="button"
                    onClick={() => copySingleI2vPrompt(c.cutId, i)}
                    className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-300 hover:border-pink-500/40"
                    title="このカットの Image-to-Video プロンプトをコピー"
                  >
                    i2v コピー
                  </button>
                </div>

                {/* P13: i2v プロンプトプレビュー */}
                <details className="rounded border border-[#2a2a2a] bg-[#0d0d0d] p-2">
                  <summary className="cursor-pointer text-[10px] font-semibold text-zinc-400 hover:text-pink-200">
                    i2v プロンプトを見る
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap text-[10px] leading-relaxed text-zinc-300">
                    {buildI2vPrompt(
                      sketchByCutId.get(c.cutId) ?? null,
                      {
                        description: sketchByCutId.get(c.cutId)?.intent,
                        duration: sketchByCutId.get(c.cutId)?.durationSeconds ?? 2.5,
                      },
                      goal?.aspectRatio ?? "16:9",
                      i,
                    )}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      </div>

      {allTakeImages.length > 0 && (
        <footer className="flex items-center justify-between gap-3 rounded-md border border-[#242424] bg-[#161616] px-3 py-2 text-[11px] text-zinc-500">
          <span>
            完成セット: {allTakeImages.length} 枚 / {orderedCuts.length} カット
            {activeProject && ` · 確定フォルダ: ${activeProject.name}`}
          </span>
          {/* B4: 確定フォルダ導線 (footer からも開ける) */}
          <button
            type="button"
            onClick={() => void openConfirmedFolder()}
            className="shrink-0 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-400 hover:border-pink-500/40 hover:text-pink-200"
            title="確定カット画像の保存フォルダを開く"
          >
            確定フォルダを開く
          </button>
        </footer>
      )}
    </div>
  );
}
