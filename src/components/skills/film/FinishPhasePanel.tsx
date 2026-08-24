import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { collectAdoptedTakePaths } from "../../../lib/film/finishTakes";
import type { FilmProject } from "../../../lib/film/types";
import { videoConcat } from "../../../lib/ipc";
import { registerGeneratedMedia } from "../../../lib/store/images";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";

type FinishTransition = "cut" | "crossfade";

export function FinishPhasePanel({ project }: { project: FilmProject }) {
  const script = Array.isArray(project.script) ? null : project.script;
  const blocks = script?.blocks ?? [];
  const adoptedPaths = collectAdoptedTakePaths(blocks, project.takes);
  const skippedCount = blocks.length - adoptedPaths.length;
  const saveFinishedFilm = useFilmProjectStore((state) => state.saveFinishedFilm);
  const pushToast = useToasts((state) => state.push);
  const [transition, setTransition] = useState<FinishTransition>("cut");
  const [inFlight, setInFlight] = useState(false);
  const [outputPath, setOutputPath] = useState<string | null>(project.finished?.path ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTransition("cut");
    setInFlight(false);
    setOutputPath(project.finished?.path ?? null);
    setError(null);
  }, [project.id]);

  async function finishFilm() {
    if (inFlight || adoptedPaths.length === 0) return;
    setInFlight(true);
    setError(null);
    try {
      let path: string;
      let appliedTransition: FinishTransition;
      if (adoptedPaths.length === 1) {
        path = adoptedPaths[0];
        appliedTransition = "cut";
      } else {
        const result = await videoConcat.story(adoptedPaths, transition);
        path = result.path;
        appliedTransition = result.transitionApplied;
      }

      await registerGeneratedMedia({
        paths: [path],
        mediaType: "video",
        prompt: `${project.title} 完成`,
        providerId: "film",
        providerLabel: "AIフィルム",
      });
      const saved = saveFinishedFilm(project.id, {
        path,
        transition: appliedTransition,
        at: Date.now(),
      });
      if (!saved) throw new Error("完成動画をフィルムへ保存できませんでした");

      setOutputPath(path);
      pushToast({
        kind: "success",
        text: "完成動画をライブラリ・履歴へ登録しました。",
        ttlMs: 4000,
      });
    } catch (caught) {
      setError(String(caught));
    } finally {
      setInFlight(false);
    }
  }

  if (!script || blocks.length === 0) {
    return (
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm text-amber-200">
        OK済みのブロック台本がありません。②脚本でブロックを確定してください。
      </div>
    );
  }

  const ffmpegMissing = error?.includes("ffmpeg-not-found:") ?? false;
  const buttonLabel = adoptedPaths.length === 1
    ? "この1本を完成として登録"
    : "1本に書き出す";

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">⑥ 仕上げ</p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">採用した映像を、1本の完成動画にする</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          ⑤で採用したテイクだけを、脚本のブロック順につないで完成として登録します。
        </p>
      </header>

      <section className="rounded-xl border border-[#303030] bg-[#141414] p-4">
        <h3 className="text-sm font-semibold text-zinc-100">ブロック一覧</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {blocks.map((block) => {
            const adoptedTake = project.takes.find(
              (take) => take.blockId === block.id && take.adopted,
            );
            return (
              <div key={block.id} className="rounded-lg border border-[#303030] bg-[#181818] px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-pink-300">
                    {block.sceneId}/{block.id} ・ {block.durationSeconds}秒
                  </span>
                  <span className={adoptedTake
                    ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300"
                    : "rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300"}
                  >
                    {adoptedTake ? "採用済み" : "未採用"}
                  </span>
                </div>
                {adoptedTake ? (
                  <p className="mt-2 truncate text-xs text-zinc-500" title={adoptedTake.path}>
                    {adoptedTake.path}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-amber-200">⑤で採用してください</p>
                )}
              </div>
            );
          })}
        </div>
        {skippedCount > 0 ? (
          <p className="mt-3 text-xs leading-5 text-amber-200">
            未採用 {skippedCount} ブロックはスキップして繋ぎます
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-[#303030] bg-[#171717] p-4">
        <h3 className="text-sm font-semibold text-zinc-100">繋ぎ方</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {(["cut", "crossfade"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={inFlight}
              onClick={() => setTransition(value)}
              className={[
                "rounded-md border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
                transition === value
                  ? "border-pink-500 bg-pink-500/10 text-pink-200"
                  : "border-[#3a3a3a] text-zinc-300 hover:border-pink-500/50",
              ].join(" ")}
            >
              {value === "cut" ? "カット" : "クロスフェード(0.5s)"}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={adoptedPaths.length === 0 || inFlight}
          onClick={() => void finishFilm()}
          className="mt-4 rounded-md bg-pink-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {inFlight ? "書き出し中…" : buttonLabel}
        </button>
      </section>

      {ffmpegMissing ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p className="font-semibold">動画を1本にする部品（ffmpeg）が見つかりません。</p>
          <p className="mt-1 text-xs leading-5">
            テイクは保存済みです。ffmpegを入れたあと、もう一度「1本に書き出す」を押してください。
          </p>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p>完成動画を登録できませんでした。もう一度お試しください。</p>
          <details className="mt-1 text-[10px] text-zinc-500">
            <summary className="cursor-pointer">詳しい内容</summary>
            <p className="mt-1 break-all">{error}</p>
          </details>
        </div>
      ) : null}

      {outputPath ? (
        <section className="rounded-xl border border-[#303030] bg-[#171717] p-4">
          <h3 className="text-sm font-semibold text-zinc-100">完成動画</h3>
          <video
            controls
            src={convertFileSrc(outputPath)}
            className="mt-3 max-h-[32rem] w-full rounded-lg bg-black object-contain"
          />
          <p className="mt-2 break-all text-[11px] text-zinc-500">{outputPath}</p>
        </section>
      ) : null}
    </div>
  );
}
