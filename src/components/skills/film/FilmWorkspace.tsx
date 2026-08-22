import { useEffect, useState, type FormEvent } from "react";

import { getAssetFactoryGateState } from "../../../lib/film/assetFactory";
import {
  DEFAULT_VIDEO_SERVICE_ID,
  findVideoServiceProfile,
  VIDEO_SERVICE_PROFILES,
  type VideoServiceId,
} from "../../../lib/film/serviceProfiles";
import type { FilmPhase } from "../../../lib/film/types";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { AssetFactoryPanel } from "./AssetFactoryPanel";
import { DesignPhasePanel } from "./DesignPhasePanel";
import { FilmPhaseRail } from "./FilmPhaseRail";
import { ScriptPhasePanel } from "./ScriptPhasePanel";

const LOCKED_PHASES: Record<Exclude<FilmPhase, 1 | 2 | 3 | 4>, { stage: string; name: string }> = {
  5: { stage: "S5", name: "生成" },
  6: { stage: "S6", name: "仕上げ" },
};

function FilmMarkIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4" />
    </svg>
  );
}

function PlanningPanel() {
  const projects = useFilmProjectStore((state) => state.projects);
  const activeProjectId = useFilmProjectStore((state) => state.activeProjectId);
  const fileState = useFilmProjectStore((state) => state.filmProjectsFileState);
  const createProject = useFilmProjectStore((state) => state.createProject);
  const setPhase = useFilmProjectStore((state) => state.setPhase);
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;

  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState("");
  const [videoServiceId, setVideoServiceId] = useState<VideoServiceId>(
    DEFAULT_VIDEO_SERVICE_ID,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !theme.trim()) return;
    createProject(title, theme, videoServiceId);
  }

  if (activeProject) {
    const activeVideoService = findVideoServiceProfile(activeProject.videoServiceId);
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">
            ① 企画
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-zinc-100">企画を固定しました</h2>
          <p className="mt-2 text-sm text-zinc-400">
            この一枚を基準に、後ろの工程で判断がぶれないように進めます。
          </p>
        </div>

        <section className="rounded-xl border border-[#242424] bg-[#171717] p-6">
          <dl className="grid gap-5">
            <div>
              <dt className="text-xs font-medium text-zinc-500">作品タイトル</dt>
              <dd className="mt-1 text-lg font-semibold text-zinc-100">
                {activeProject.title}
              </dd>
            </div>
            <div className="border-t border-[#242424] pt-5">
              <dt className="text-xs font-medium text-zinc-500">一番伝えたいこと</dt>
              <dd className="mt-1 text-sm leading-6 text-zinc-200">{activeProject.theme}</dd>
            </div>
            <div className="border-t border-[#242424] pt-5">
              <dt className="text-xs font-medium text-zinc-500">アセット（画像）</dt>
              <dd className="mt-1 text-sm text-zinc-200">GPT Image 2（アプリ内コア）</dd>
            </div>
            <div className="border-t border-[#242424] pt-5">
              <dt className="text-xs font-medium text-zinc-500">動画</dt>
              <dd className="mt-1 text-sm text-zinc-200">
                {activeVideoService?.label ?? activeProject.videoServiceId}
              </dd>
            </div>
          </dl>
        </section>

        <button
          type="button"
          onClick={() => setPhase(2)}
          className="inline-flex w-fit items-center gap-2 rounded-md bg-pink-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-400/70"
        >
          ②脚本へ進む
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-4 w-4"
          >
            <path d="m7 4 6 6-6 6" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-pink-400">
          ① 企画
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-zinc-100">映像の中心を決める</h2>
        <p className="mt-2 text-sm text-zinc-400">
          先に設計を固めてから作ることで、途中で作品の軸がずれるのを防ぎます。
        </p>
      </div>

      {(fileState === "corrupted" || fileState === "unreadable") && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          保存ファイルを安全に読み込めなかったため、いまは正本への保存を止めています。
        </div>
      )}

      <label className="grid gap-2">
        <span className="text-sm font-medium text-zinc-200">作品タイトル</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          autoFocus
          placeholder="例：最後のバスを待つ夜"
          className="h-11 rounded-md border border-[#2a2a2a] bg-[#171717] px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-pink-500 focus:ring-1 focus:ring-pink-500/50"
        />
      </label>

      <label className="grid gap-2">
        <span className="text-sm font-medium text-zinc-200">
          この映像で一番伝えたいこと
        </span>
        <input
          value={theme}
          onChange={(event) => setTheme(event.target.value)}
          required
          placeholder="例：言えなかった言葉も、誰かを支えている"
          className="h-11 rounded-md border border-[#2a2a2a] bg-[#171717] px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-pink-500 focus:ring-1 focus:ring-pink-500/50"
        />
        <span className="text-xs text-zinc-500">
          この一行が、脚本・見た目・素材・仕上げまで、すべての判断の親になります。
        </span>
      </label>

      <section className="grid gap-3">
        <h3 className="text-sm font-medium text-zinc-200">アセット（画像）を何で作るか</h3>
        <div className="rounded-xl border border-pink-500 bg-pink-500/10 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-pink-400 bg-pink-500 text-white">
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-3 w-3"
              >
                <path d="m5 10 3 3 7-7" />
              </svg>
            </span>
            <div>
              <p className="text-sm font-semibold text-pink-100">
                GPT Image 2（アプリ内コア）
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                画像アセットはこのサービスで作ります。
              </p>
            </div>
          </div>
        </div>
        <p className="text-xs text-zinc-500">他の画像サービスは今後追加します。</p>
      </section>

      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium text-zinc-200">動画を何で作るか</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {VIDEO_SERVICE_PROFILES.map((profile) => {
            const selected = videoServiceId === profile.id;
            const recommended = profile.id === DEFAULT_VIDEO_SERVICE_ID;
            return (
              <button
                key={profile.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setVideoServiceId(profile.id)}
                className={`rounded-xl border p-4 text-left transition ${
                  selected
                    ? "border-pink-500 bg-pink-500/10"
                    : "border-[#2a2a2a] bg-[#171717] hover:border-[#444]"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={selected ? "text-sm font-semibold text-pink-100" : "text-sm font-semibold text-zinc-100"}>
                    {profile.label}
                  </span>
                  {recommended ? (
                    <span className="rounded-full bg-pink-500/15 px-2 py-0.5 text-[10px] font-semibold text-pink-300">
                      推奨
                    </span>
                  ) : null}
                  {!profile.measured ? (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                      未実測
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs leading-5 text-zinc-300">{profile.blurb}</p>
                {recommended ? (
                  <p className="mt-1 text-[11px] leading-5 text-pink-200/80">
                    推奨理由：実測資産が最も多く、既存の実測則の母体だからです。
                  </p>
                ) : null}
                <p className="mt-2 text-[11px] leading-5 text-zinc-500">
                  ブロック上限：
                  {profile.maxBlockSeconds === null
                    ? "未定（脚本では仮に15秒）"
                    : `${profile.maxBlockSeconds}秒`}
                </p>
                <p className="text-[11px] leading-5 text-zinc-500">
                  参照：{profile.referenceNotation}
                </p>
                <p className={`mt-2 text-[11px] leading-5 ${profile.measured ? "text-zinc-500" : "text-amber-200/80"}`}>
                  {profile.notes}
                </p>
              </button>
            );
          })}
        </div>
      </fieldset>

      <button
        type="submit"
        disabled={!title.trim() || !theme.trim()}
        className="inline-flex w-fit items-center justify-center rounded-md bg-pink-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-400/70 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        フィルムプロジェクトを作成
      </button>
    </form>
  );
}

function LockedPhasePanel({ phase }: { phase: Exclude<FilmPhase, 1 | 2 | 3 | 4> }) {
  const detail = LOCKED_PHASES[phase];
  return (
    <div className="mx-auto flex w-full max-w-2xl items-center justify-center py-16">
      <section className="w-full rounded-xl border border-[#242424] bg-[#171717] p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#303030] bg-[#121212] text-zinc-500">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <rect x="5" y="10" width="14" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <h2 className="mt-4 text-lg font-semibold text-zinc-200">{detail.name}</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          この工程は次のアップデートで実装されます（{detail.stage}: {detail.name}）
        </p>
      </section>
    </div>
  );
}

export function FilmWorkspace() {
  const initialize = useFilmProjectStore((state) => state.initialize);
  const projects = useFilmProjectStore((state) => state.projects);
  const activeProjectId = useFilmProjectStore((state) => state.activeProjectId);
  const setPhase = useFilmProjectStore((state) => state.setPhase);
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const [uncreatedPhase, setUncreatedPhase] = useState<FilmPhase>(1);
  const phase = activeProject?.phase ?? uncreatedPhase;
  const canEnterLaterPhases = activeProject
    ? getAssetFactoryGateState(activeProject.assets).canProceed
    : false;

  useEffect(() => {
    void initialize();
  }, [initialize]);

  function selectPhase(nextPhase: FilmPhase) {
    if (activeProject) {
      if (nextPhase >= 5 && !canEnterLaterPhases) return;
      setPhase(nextPhase);
    } else {
      setUncreatedPhase(nextPhase);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212] text-zinc-100">
      <header className="flex items-center gap-3 border-b border-[#242424] px-5 py-3.5">
        <span className="text-pink-400">
          <FilmMarkIcon />
        </span>
        <div>
          <h1 className="text-sm font-semibold">フィルム</h1>
          <p className="text-xs text-zinc-500">設計を固めてから、完成まで運ぶ映像制作</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <FilmPhaseRail
          phase={phase}
          onSelect={selectPhase}
          isEnabled={(candidate) => candidate < 5 || canEnterLaterPhases}
        />
        <main className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          {phase === 1 ? (
            <PlanningPanel />
          ) : phase === 2 && activeProject ? (
            <ScriptPhasePanel project={activeProject} />
          ) : phase === 3 && activeProject ? (
            <DesignPhasePanel project={activeProject} />
          ) : phase === 4 && activeProject ? (
            <AssetFactoryPanel project={activeProject} />
          ) : phase >= 5 ? (
            <LockedPhasePanel phase={phase as Exclude<FilmPhase, 1 | 2 | 3 | 4>} />
          ) : (
            <PlanningPanel />
          )}
        </main>
      </div>
    </section>
  );
}
