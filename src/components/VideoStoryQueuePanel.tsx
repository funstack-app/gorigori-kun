import { useEffect, useState } from "react";
import { SafeImage } from "./SafeImage";
import { humanizeError } from "../lib/humanizeError";
import { editModels } from "../lib/ipc";
import { useBatches } from "../lib/store/batches";
import { useImages } from "../lib/store/images";
import { useToasts } from "../lib/store/toasts";
import { useVideoGen } from "../lib/store/videoGen";
import { isStoryRunBusy, useVideoStory, type StoryCutJob } from "../lib/store/videoStory";
import { clampDurationForModel, findVideoModel, VIDEO_MODELS } from "../lib/videoModels";
import { concatOnly, retryCut, runStoryVideo } from "../lib/videoStory/runStoryVideo";

/**
 * ストーリー動画キューパネル (uy6 Wave 3)。
 *
 * ストーリーモード Phase 4 の「ストーリー動画にする」で積まれた確定カット列を
 * 表示し、カットごとの i2v 生成 → ffmpeg 結合を実行する。
 * キューが空のときは何も描画しない (通常の単発動画生成の邪魔をしない)。
 */

/** 同時に走らせられるバッチ数。useVideoSceneGeneration と同値。 */
const MAX_CONCURRENT_BATCHES = 3;

type InstallPlatform = "mac" | "windows" | "unknown";

const STATUS_LABEL: Record<StoryCutJob["status"], string> = {
  queued: "待機中",
  generating: "生成中…",
  done: "完成",
  failed: "失敗",
};

function statusClass(status: StoryCutJob["status"]): string {
  switch (status) {
    case "done":
      return "text-emerald-300";
    case "failed":
      return "text-red-400";
    case "generating":
      return "text-pink-200";
    default:
      return "text-zinc-400";
  }
}

export function VideoStoryQueuePanel() {
  const cuts = useVideoStory((s) => s.cuts);
  const runStatus = useVideoStory((s) => s.runStatus);
  const concatFailReason = useVideoStory((s) => s.concatFailReason);
  const finalVideoPath = useVideoStory((s) => s.finalVideoPath);
  const cancelRequested = useVideoStory((s) => s.cancelRequested);
  const requestCancel = useVideoStory((s) => s.requestCancel);
  const abortAndClear = useVideoStory((s) => s.abortAndClear);
  const removeCut = useVideoStory((s) => s.removeCut);
  const modelId = useVideoGen((s) => s.modelId);
  const revealInFinder = useImages((s) => s.revealInFinder);
  const pushToast = useToasts((s) => s.push);
  const batches = useBatches((s) => s.batches);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [installPlatform, setInstallPlatform] = useState<InstallPlatform>("unknown");

  const showFfmpegGuide =
    runStatus === "concatFailed" && concatFailReason === "ffmpeg-not-found";

  useEffect(() => {
    if (!showFfmpegGuide) return;

    let active = true;
    void editModels
      .platformInfo()
      .then(({ os }) => {
        if (!active) return;
        const normalized = os.toLowerCase();
        if (normalized.includes("mac") || normalized.includes("darwin")) {
          setInstallPlatform("mac");
        } else if (normalized.includes("windows") || normalized.includes("win32")) {
          setInstallPlatform("windows");
        } else {
          setInstallPlatform("unknown");
        }
      })
      .catch(() => {
        if (active) setInstallPlatform("unknown");
      });

    return () => {
      active = false;
    };
  }, [showFfmpegGuide]);

  const copyInstallCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      pushToast({ kind: "success", text: "インストールコマンドをコピーしました。" });
    } catch {
      pushToast({
        kind: "warn",
        text: "コピーできませんでした。コマンドを選んでコピーしてください。",
      });
    }
  };

  if (cuts.length === 0) return null;

  const model = findVideoModel(modelId) ?? VIDEO_MODELS[0];
  const runningBatchCount = batches.filter((b) => b.status === "running").length;
  const queueFull = runningBatchCount >= MAX_CONCURRENT_BATCHES;
  const allDone = cuts.every((c) => c.status === "done");
  // 結合だけをやり直せる状態: 全カット完成しているが、まだ 1 本になっていない。
  const canConcatOnly =
    allDone && (runStatus === "concatFailed" || runStatus === "failedPartial" || runStatus === "idle");
  // 全体ランは「全カット失敗」のときだけ出す。1 枚でも成功していれば、その成果を
  // 消して全カットを再生成することになり有料枠を捨てる（カット別「再生成」が正）。
  const allFailed = cuts.every((c) => c.status === "failed");
  // 開始ロック中 / 実行中 / カット別再生成中は全体ランを禁止する（重複起動と競合の防止）。
  const runBusy = isStoryRunBusy(runStatus) || retrying !== null;

  return (
    <div className="shrink-0 px-3 pt-3">
      <div className="rounded-md border border-pink-500/40 bg-pink-500/5 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-pink-100">ストーリー動画</p>
          <span className="text-[10px] text-zinc-500">{cuts.length} カット</span>
        </div>

        <ol className="mt-2 flex flex-col gap-1">
          {cuts.map((cut) => {
            const clamped = clampDurationForModel(model.id, Math.round(cut.requestedSeconds));
            const adjusted = clamped !== cut.requestedSeconds;
            return (
              <li
                key={cut.cutId}
                className="flex items-center gap-2 rounded border border-[#2a2a2a] bg-[#141414] p-1.5"
              >
                <SafeImage
                  path={cut.imagePath}
                  alt={`Cut ${cut.order}`}
                  className="h-9 w-12 shrink-0 rounded object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold text-zinc-300">Cut {cut.order}</p>
                  <p
                    className="text-[10px] text-zinc-500"
                    title={
                      adjusted
                        ? `絵コンテの ${cut.requestedSeconds} 秒をモデル対応値に調整`
                        : undefined
                    }
                  >
                    {clamped}秒
                  </p>
                </div>
                <span className={`shrink-0 text-[10px] ${statusClass(cut.status)}`}>
                  {STATUS_LABEL[cut.status]}
                </span>
                {cut.status === "failed" && (
                  <button
                    type="button"
                    disabled={retrying === cut.cutId}
                    onClick={() => {
                      setRetrying(cut.cutId);
                      void retryCut(cut.cutId).finally(() => setRetrying(null));
                    }}
                    className="shrink-0 rounded border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-[10px] text-pink-100 hover:bg-pink-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    title={cut.error ? humanizeError(cut.error) : undefined}
                  >
                    このカットを再生成
                  </button>
                )}
                {/*
                  A1 (2026-08-05): カット 1 件だけキューから外す。
                  これが無いと「全消しか全生成」の二択しかなく、要らない 1 カットを
                  外せずに残り続けた (STΛCK 実機報告)。
                  生成中は外せない (走行中の有料ジョブの置き場を消さない)。
                */}
                <button
                  type="button"
                  disabled={cut.status === "generating"}
                  onClick={() => {
                    if (cut.videoPath || cut.status === "done") {
                      const ok = window.confirm(
                        `Cut ${cut.order} は動画が生成済みです。\n` +
                          "キューから外すとこの動画は一覧から消えます。\n\n外しますか？",
                      );
                      if (!ok) return;
                    }
                    removeCut(cut.cutId);
                  }}
                  className="shrink-0 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-zinc-400 hover:border-pink-500/40 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    cut.status === "generating"
                      ? "生成中のカットは外せません"
                      : "このカットをキューから外す"
                  }
                >
                  外す
                </button>
              </li>
            );
          })}
        </ol>

        {/*
          失敗理由は行に収まらないので、まとめて下に出す。
          G2 (2026-08-05): Higgsfield MCP の `generation.error` はそのまま
          流れてくる (higgsfield_mcp.rs の job_status 経路)。`not_enough_credits`
          等の生の英語がここで初めてユーザーの目に触れるので日本語化する。
        */}
        {cuts.some((c) => c.status === "failed" && c.error) && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {cuts
              .filter((c) => c.status === "failed" && c.error)
              .map((c) => (
                <li key={c.cutId} className="text-[10px] leading-relaxed text-red-300">
                  Cut {c.order}: {humanizeError(c.error)}
                </li>
              ))}
          </ul>
        )}

        {showFfmpegGuide && (
          <details
            open
            className="mt-2 rounded-md border border-amber-400/30 bg-amber-400/5 px-2.5 py-2"
          >
            <summary className="cursor-pointer text-[11px] font-semibold leading-relaxed text-amber-100">
              1本にまとめるには ffmpeg（無料の動画結合ツール）が必要です
            </summary>

            <div className="mt-2 space-y-2">
              {(installPlatform === "mac" || installPlatform === "unknown") && (
                <div>
                  <p className="text-[10px] font-semibold text-zinc-300">Mac</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1.5 text-[10px] text-zinc-200">
                      brew install ffmpeg
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyInstallCommand("brew install ffmpeg")}
                      className="shrink-0 rounded border border-[#3a3a3a] px-2 py-1 text-[10px] text-zinc-300 hover:border-amber-300/50 hover:text-white"
                    >
                      コピー
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                    Homebrew が無い場合は、先に
                    <a
                      href="https://brew.sh"
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 text-amber-200 underline decoration-amber-200/50 underline-offset-2 hover:text-amber-100"
                    >
                      Homebrew 公式サイト
                    </a>
                    の手順で入れてください。
                  </p>
                </div>
              )}

              {(installPlatform === "windows" || installPlatform === "unknown") && (
                <div>
                  <p className="text-[10px] font-semibold text-zinc-300">Windows</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded bg-black/30 px-2 py-1.5 text-[10px] text-zinc-200">
                      winget install Gyan.FFmpeg
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyInstallCommand("winget install Gyan.FFmpeg")}
                      className="shrink-0 rounded border border-[#3a3a3a] px-2 py-1 text-[10px] text-zinc-300 hover:border-amber-300/50 hover:text-white"
                    >
                      コピー
                    </button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[10px] text-zinc-400">インストールできたら</span>
                <button
                  type="button"
                  onClick={() => void concatOnly()}
                  className="rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-pink-400"
                >
                  もう一度1本にまとめる
                </button>
              </div>
            </div>
          </details>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {runStatus === "idle" && (
            <>
              <button
                type="button"
                disabled={queueFull || runBusy}
                onClick={() => void runStoryVideo()}
                className="rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-50"
                title={queueFull ? "他の生成が終わるまで待ってください" : undefined}
              >
                ストーリー動画を生成
              </button>
            </>
          )}

          {runStatus === "starting" && (
            <span className="text-[11px] text-pink-200">開始しています…</span>
          )}

          {runStatus === "running" && (
            <button
              type="button"
              disabled={cancelRequested}
              onClick={requestCancel}
              className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelRequested ? "中止しています…" : "中止"}
            </button>
          )}

          {runStatus === "concatenating" && (
            <span className="text-[11px] text-pink-200">結合中…</span>
          )}

          {canConcatOnly && !showFfmpegGuide && (
            <button
              type="button"
              onClick={() => void concatOnly()}
              className="rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-pink-400"
            >
              1本につなげる
            </button>
          )}

          {runStatus === "done" && (
            <>
              <span className="text-[11px] font-semibold text-emerald-300">完成</span>
              {finalVideoPath && (
                <button
                  type="button"
                  onClick={() => void revealInFinder(finalVideoPath)}
                  className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/40"
                >
                  Finder で表示
                </button>
              )}
            </>
          )}

          {/*
            全体ランのやり直しは **全カット失敗のときだけ**。1 枚でも成功していると、
            成功済みの動画パスを捨てて全カットを再生成することになり、有料枠を無駄に燃やす。
            部分失敗の導線はカット行の「このカットを再生成」に固定する。
          */}
          {(runStatus === "failedPartial" || runStatus === "concatFailed") &&
            !canConcatOnly &&
            allFailed && (
              <button
                type="button"
                disabled={queueFull || runBusy}
                onClick={() => void runStoryVideo()}
                className="rounded-md border border-pink-500/40 bg-pink-500/10 px-3 py-1.5 text-[11px] font-semibold text-pink-100 hover:bg-pink-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                title={queueFull ? "他の生成が終わるまで待ってください" : undefined}
              >
                ストーリー動画を生成
              </button>
            )}

          {(runStatus === "failedPartial" || runStatus === "concatFailed") &&
            !canConcatOnly &&
            !allFailed && (
              <span className="text-[11px] text-zinc-400">
                失敗したカットを「このカットを再生成」で作り直してください。
              </span>
            )}

          {/*
            A2 (2026-08-05): キューから出る導線は **どの runStatus でも** 出す。
            以前は idle / done のときしか描画されず、running / concatenating /
            failedPartial / concatFailed / starting ではキュー全体すら消せない
            閉じ込めになっていた。

            実行中は走行中の MCP コールを中断できないので、abortAndClear で
            「次の投入を止めて空にする」に倒す (文言もそう書く)。
          */}
          <button
            type="button"
            onClick={() => {
              const busy = isStoryRunBusy(runStatus);
              const doneCount = cuts.filter((c) => c.status === "done").length;
              if (busy || doneCount > 0) {
                const lines = [
                  busy
                    ? "生成中です。すでに始まったカットは止められませんが、これから始まる分は止まります。"
                    : `生成済みの動画が ${doneCount} 本あります。`,
                  "キューを空にすると、この一覧からは消えます。",
                  "",
                  "空にしますか？",
                ];
                if (!window.confirm(lines.join("\n"))) return;
              }
              abortAndClear();
            }}
            className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] text-zinc-300 hover:border-pink-500/40"
          >
            {isStoryRunBusy(runStatus) ? "中止してキューを空にする" : "キューを空にする"}
          </button>
        </div>
      </div>
    </div>
  );
}
