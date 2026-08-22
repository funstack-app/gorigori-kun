import { useEffect, useState } from "react";

import type { FilmPhase, FilmProject } from "../../../lib/film/types";
import {
  useFilmProjectStore,
  type FilmProjectBackup,
  type FilmProjectBackupListResult,
} from "../../../lib/store/filmProject";
import { useToasts } from "../../../lib/store/toasts";
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
  const fileState = useFilmProjectStore((state) => state.filmProjectsFileState);
  const saveError = useFilmProjectStore((state) => state.filmProjectsSaveError);
  const listBackups = useFilmProjectStore((state) => state.listBackups);
  const restoreFromBackup = useFilmProjectStore((state) => state.restoreFromBackup);
  const pushToast = useToasts((state) => state.push);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backups, setBackups] = useState<FilmProjectBackupListResult | null>(null);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function restart() {
    const message = activeProject
      ? `「${activeProject.title}」は削除せずに残します。新しい企画として最初からやり直しますか？`
      : "いまの相談内容を閉じて、新しい企画として最初からやり直しますか？";
    if (!window.confirm(message)) return;
    onStartNew();
  }

  async function openBackups() {
    setBackupsOpen(true);
    setBackupsLoading(true);
    setRestoreError(null);
    setBackups(await listBackups());
    setBackupsLoading(false);
  }

  async function restoreBackup(backup: FilmProjectBackup) {
    const unsavedWarning = saveError || fileState === "corrupted" || fileState === "unreadable"
      ? "\n\nまだ保存できていない画面内の変更はバックアップされず、復元内容に置き換わります。"
      : "";
    const confirmed = window.confirm(
      `${new Date(backup.at).toLocaleString("ja-JP")} のバックアップ（${backup.count}件）へ復元します。\n\n現在の保存済み状態も、書き換え前に自動バックアップされます。${unsavedWarning}\n\n続けますか？`,
    );
    if (!confirmed) return;

    setRestoringPath(backup.path);
    setRestoreError(null);
    try {
      const count = await restoreFromBackup(backup.path);
      setBackupsOpen(false);
      pushToast({
        kind: "success",
        text: `バックアップからフィルム ${count}件を復元しました。`,
        ttlMs: 4000,
      });
    } catch (error) {
      setRestoreError(String(error));
    } finally {
      setRestoringPath(null);
    }
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
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (backupsOpen) setBackupsOpen(false);
            else void openBackups();
          }}
          aria-expanded={backupsOpen}
          className="rounded-md border border-[#343434] bg-[#161616] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:border-pink-500/40 hover:text-pink-200"
        >
          バックアップから復元
        </button>
        {backupsOpen ? (
          <div className="absolute right-0 z-30 mt-2 w-96 overflow-hidden rounded-lg border border-[#343434] bg-[#181818] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-2">
              <div>
                <p className="text-xs font-semibold text-zinc-200">復元する時点を選ぶ</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">新しい順・日時と件数を表示</p>
              </div>
              <button
                type="button"
                onClick={() => setBackupsOpen(false)}
                className="text-[11px] text-zinc-500 hover:text-zinc-200"
              >
                閉じる
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {backupsLoading ? (
                <p className="px-2 py-3 text-xs text-zinc-500">バックアップを確認しています…</p>
              ) : backups?.ok ? (
                backups.items.length > 0 ? (
                  <ul className="space-y-1.5">
                    {backups.items.map((backup) => (
                      <li
                        key={backup.path}
                        className="flex items-center justify-between gap-3 rounded-md bg-[#121212] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-zinc-200">
                            {new Date(backup.at).toLocaleString("ja-JP")}
                          </p>
                          <p className="mt-0.5 text-[10px] text-zinc-500">
                            フィルム {backup.count}件
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={restoringPath !== null}
                          onClick={() => void restoreBackup(backup)}
                          className="shrink-0 rounded-md border border-[#3a3a3a] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 disabled:opacity-40"
                        >
                          {restoringPath === backup.path ? "復元中…" : "これで復元"}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 py-3 text-xs text-zinc-500">
                    まだバックアップがありません。保存のたびに自動で作られます。
                  </p>
                )
              ) : (
                <div className="px-2 py-2 text-xs text-amber-200">
                  <p>バックアップ一覧を取得できませんでした。保存先を確認して再試行してください。</p>
                  {backups && !backups.ok ? (
                    <details className="mt-2 text-[10px] text-zinc-500">
                      <summary className="cursor-pointer">詳しい内容</summary>
                      <p className="mt-1 break-all">{backups.error}</p>
                    </details>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void openBackups()}
                    className="mt-2 rounded-md border border-amber-500/40 px-2.5 py-1.5 text-[11px] font-semibold"
                  >
                    再試行
                  </button>
                </div>
              )}
              {restoreError ? (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  <p>復元できませんでした。保存先を確認して、もう一度お試しください。</p>
                  <details className="mt-1 text-[10px] text-zinc-500">
                    <summary className="cursor-pointer">詳しい内容</summary>
                    <p className="mt-1 break-all">{restoreError}</p>
                  </details>
                </div>
              ) : null}
              <p className="px-2 pb-1 pt-2 text-[10px] leading-4 text-zinc-500">
                復元直前の現在の保存済み状態も自動バックアップされるので、あとから戻せます。
              </p>
            </div>
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
  const saveError = useFilmProjectStore((state) => state.filmProjectsSaveError);
  const retrySave = useFilmProjectStore((state) => state.retrySave);
  const setActiveProjectId = useFilmProjectStore((state) => state.setActiveProjectId);
  const resetPlanningChat = useFilmProjectStore((state) => state.resetPlanningChat);
  const setPhase = useFilmProjectStore((state) => state.setPhase);
  const pushToast = useToasts((state) => state.push);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const [ready, setReady] = useState(false);
  const [showScriptReview, setShowScriptReview] = useState(false);
  const [showEarlyChat, setShowEarlyChat] = useState(false);
  const [retryingSave, setRetryingSave] = useState(false);
  const phase = activeProject?.phase ?? 1;

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
    if (candidate === 1 || candidate === 2) return true;
    if (candidate === 3) return Boolean(activeProject.approvals.blocks);
    if (candidate === 4) return Boolean(activeProject.approvals.look);
    // ⑤⑥は未実装。完了条件を満たしていても偽の画面へ進ませない。
    return false;
  }

  async function retryFailedSave() {
    setRetryingSave(true);
    const ok = await retrySave();
    setRetryingSave(false);
    if (ok) {
      pushToast({ kind: "success", text: "フィルムの変更を保存できました。", ttlMs: 3000 });
    }
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
          {saveError ? (
            <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">フィルムの変更をまだ保存できていません。</p>
                <p className="mt-1 text-xs leading-5 text-red-200/80">
                  画面内の内容は残っています。保存先を確認して、もう一度保存してください。
                </p>
                <details className="mt-1 text-[10px] text-zinc-500">
                  <summary className="cursor-pointer">詳しい内容</summary>
                  <p className="mt-1 break-all">{saveError}</p>
                </details>
              </div>
              <button
                type="button"
                disabled={retryingSave}
                onClick={() => void retryFailedSave()}
                className="rounded-md bg-red-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-400 disabled:opacity-50"
              >
                {retryingSave ? "保存中…" : "再試行"}
              </button>
            </div>
          ) : null}
          {(fileState === "corrupted" || fileState === "unreadable") ? (
            <div className="mx-auto mb-4 max-w-5xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              保存ファイルを安全に読み込めなかったため、いまは正本への保存を止めています。上の「バックアップから復元」から過去の状態を選べます。
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
