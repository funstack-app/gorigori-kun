import { useEffect, useState } from "react";

import { getAssetFactoryGateState } from "../../../lib/film/assetFactory";
import type { FilmPhase, FilmProject } from "../../../lib/film/types";
import { useFilmProjectStore } from "../../../lib/store/filmProject";
import { AssetFactoryPanel } from "./AssetFactoryPanel";
import { DesignPhasePanel } from "./DesignPhasePanel";
import { FilmChatPanel } from "./FilmChatPanel";
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

function formatUpdatedAt(project: FilmProject): string {
  const messages = project.chatMessages ?? [];
  const lastMessage = messages[messages.length - 1];
  const value = project.updatedAt ?? lastMessage?.createdAt;
  if (!value) return "更新日時なし";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新日時なし";
  return date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ProjectControls({
  activeProject,
  onStartNew,
  onSwitch,
}: {
  activeProject: FilmProject | null;
  onStartNew: () => void;
  onSwitch: (projectId: string) => void;
}) {
  const projects = useFilmProjectStore((state) => state.projects);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  function restart() {
    const message = activeProject
      ? `「${activeProject.title}」は削除せずに残します。新しい企画として最初からやり直しますか？`
      : "いまの相談内容を閉じて、新しい企画として最初からやり直しますか？";
    if (!window.confirm(message)) return;
    onStartNew();
  }

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      <div className="mr-2 hidden min-w-0 text-right sm:block">
        <p className="max-w-56 truncate text-xs font-semibold text-zinc-200">
          {activeProject?.title ?? "新しい企画を相談中"}
        </p>
        <p className="text-[10px] text-zinc-500">
          {activeProject ? `工程 ${activeProject.phase} / 6` : "まだ保存前"}
        </p>
      </div>
      <button
        type="button"
        onClick={onStartNew}
        className="rounded-md border border-[#343434] bg-[#161616] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200"
      >
        新しいプロジェクト
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setSwitcherOpen((open) => !open)}
          disabled={projects.length === 0}
          aria-expanded={switcherOpen}
          className="rounded-md border border-[#343434] bg-[#161616] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          切替
        </button>
        {switcherOpen ? (
          <div className="absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-lg border border-[#343434] bg-[#181818] shadow-2xl">
            <div className="border-b border-[#2a2a2a] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              保存済みプロジェクト
            </div>
            <ul className="max-h-80 overflow-y-auto p-1.5">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSwitch(project.id);
                      setSwitcherOpen(false);
                    }}
                    className={[
                      "w-full rounded-md px-3 py-2.5 text-left transition",
                      project.id === activeProject?.id
                        ? "bg-pink-500/10 text-pink-100"
                        : "text-zinc-200 hover:bg-[#242424]",
                    ].join(" ")}
                  >
                    <span className="block truncate text-xs font-semibold">{project.title}</span>
                    <span className="mt-1 flex justify-between gap-3 text-[10px] text-zinc-500">
                      <span>工程 {project.phase} / 6</span>
                      <span>{formatUpdatedAt(project)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={restart}
        className="rounded-md px-2 py-2 text-xs text-zinc-500 transition hover:bg-[#202020] hover:text-zinc-200"
      >
        この企画をやり直す
      </button>
    </div>
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
  const fileState = useFilmProjectStore((state) => state.filmProjectsFileState);
  const setActiveProjectId = useFilmProjectStore((state) => state.setActiveProjectId);
  const resetPlanningChat = useFilmProjectStore((state) => state.resetPlanningChat);
  const setPhase = useFilmProjectStore((state) => state.setPhase);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const [ready, setReady] = useState(false);
  const [showScriptReview, setShowScriptReview] = useState(false);
  const [showEarlyChat, setShowEarlyChat] = useState(false);
  const phase = activeProject?.phase ?? 1;
  const canEnterLaterPhases = activeProject
    ? getAssetFactoryGateState(activeProject.assets).canProceed
    : false;

  useEffect(() => {
    let active = true;
    void initialize().finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [initialize]);

  useEffect(() => {
    setShowScriptReview(false);
    setShowEarlyChat(false);
  }, [activeProjectId]);

  function startNewProject() {
    setActiveProjectId(null);
    resetPlanningChat();
    setShowScriptReview(false);
    setShowEarlyChat(false);
  }

  function switchProject(projectId: string) {
    setActiveProjectId(projectId);
    setShowScriptReview(false);
    setShowEarlyChat(false);
  }

  function phaseEnabled(candidate: FilmPhase): boolean {
    if (!activeProject) return candidate === 1;
    if (candidate <= activeProject.phase) return true;
    if (candidate === 2) return true;
    if (candidate === 3) return Boolean(activeProject.approvals.blocks);
    if (candidate === 4) return Boolean(activeProject.approvals.look);
    return canEnterLaterPhases;
  }

  function selectPhase(nextPhase: FilmPhase) {
    if (!phaseEnabled(nextPhase)) return;
    if (nextPhase === 1) {
      setShowScriptReview(false);
      setShowEarlyChat(true);
      return;
    }
    if (nextPhase === 2) {
      setShowScriptReview(true);
      setShowEarlyChat(false);
      return;
    }
    setShowScriptReview(false);
    setShowEarlyChat(false);
    setPhase(nextPhase);
  }

  const showChat =
    !activeProject || showEarlyChat || (!showScriptReview && phase <= 2);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212] text-zinc-100">
      <header className="flex items-center gap-3 border-b border-[#242424] px-5 py-3.5">
        <span className="text-pink-400">
          <FilmMarkIcon />
        </span>
        <div>
          <h1 className="text-sm font-semibold">フィルム</h1>
          <p className="text-xs text-zinc-500">AIと話して、完成まで迷わず進める映像制作</p>
        </div>
        <ProjectControls
          activeProject={activeProject}
          onStartNew={startNewProject}
          onSwitch={switchProject}
        />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <FilmPhaseRail
          phase={phase}
          onSelect={selectPhase}
          isEnabled={phaseEnabled}
        />
        <main className="relative min-h-0 flex-1 overflow-y-auto px-8 py-6">
          {(fileState === "corrupted" || fileState === "unreadable") ? (
            <div className="mx-auto mb-4 max-w-5xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              保存ファイルを安全に読み込めなかったため、いまは正本への保存を止めています。
            </div>
          ) : null}

          {!ready ? (
            <div className="flex min-h-96 items-center justify-center text-sm text-zinc-500">
              保存した企画を読み込んでいます…
            </div>
          ) : showScriptReview && activeProject ? (
            <div>
              <div className="mx-auto mb-4 flex max-w-4xl justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowScriptReview(false);
                    setShowEarlyChat(true);
                  }}
                  className="rounded-md border border-[#343434] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200"
                >
                  チャットに戻る
                </button>
              </div>
              <ScriptPhasePanel project={activeProject} />
            </div>
          ) : showChat ? (
            <div className="flex h-full min-h-[680px] flex-col">
              {activeProject ? (
                <div className="mx-auto mb-3 flex w-full max-w-5xl justify-end">
                  <button
                    type="button"
                    onClick={() => setShowScriptReview(true)}
                    className="rounded-md border border-[#343434] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200"
                  >
                    成果物を見る・直接編集する
                  </button>
                </div>
              ) : null}
              <FilmChatPanel project={activeProject} />
            </div>
          ) : phase === 3 && activeProject ? (
            <DesignPhasePanel project={activeProject} />
          ) : phase === 4 && activeProject ? (
            <AssetFactoryPanel project={activeProject} />
          ) : phase >= 5 ? (
            <LockedPhasePanel phase={phase as Exclude<FilmPhase, 1 | 2 | 3 | 4>} />
          ) : (
            <FilmChatPanel project={activeProject} />
          )}
        </main>
      </div>
    </section>
  );
}
