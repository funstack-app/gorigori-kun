import { useEffect, useRef, useState } from "react";

import { useActiveProject } from "../lib/store/activeProject";
import { useProjects } from "../lib/store/projects";

/**
 * 「現在作業中のプロジェクト」を選ぶセレクター。
 *
 * 選択中: 企画チャットのログ + 採用→生成された画像が、自動的にこの
 * プロジェクトに紐付いて保存される。
 *
 * 未選択 (なし): 何も保存されない（従来通り）。
 *
 * UI:
 *  - チップ風のボタン → 押すとポップオーバーでプロジェクト一覧
 *  - 既存プロジェクト選択 / 新規プロジェクト作成 / 「なし」に戻す
 *  - 上部に常駐させて、企画タブでも生成タブでも見える
 */
export function ActiveProjectSelector() {
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const activeId = useActiveProject((s) => s.activeProjectId);
  const setActive = useActiveProject((s) => s.setActive);
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const t = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const active = activeId ? projects.find((p) => p.id === activeId) ?? null : null;

  const handleCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    setActive(created.id);
    setDraftName("");
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={[
          "flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-bold transition",
          active
            ? "border-pink-400 bg-pink-500/10 text-white hover:border-pink-300"
            : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-pink-400 hover:text-neutral-200",
        ].join(" ")}
        title="現在作業中のプロジェクト（企画ログと生成画像が自動保存される）"
      >
        <span className={active ? "text-pink-300" : "text-neutral-500"}>◱</span>
        <span className="max-w-[140px] truncate">
          {active ? active.name : "プロジェクト未選択"}
        </span>
        <span className="text-[10px] text-neutral-500">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-[#2a2a2a] bg-[#161616] shadow-2xl">
          <div className="border-b border-[#242424] px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              作業中のプロジェクト
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-neutral-500">
              選ぶと企画ログと採用→生成画像がこのプロジェクトに自動保存されます。
            </p>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                setActive(null);
                setOpen(false);
              }}
              className={[
                "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition",
                activeId === null
                  ? "bg-[#1f1f1f] text-white"
                  : "text-neutral-400 hover:bg-[#181818] hover:text-neutral-200",
              ].join(" ")}
            >
              <span>（保存しない）</span>
              {activeId === null && <span className="text-[10px] text-pink-300">●</span>}
            </button>
            {projects.length === 0 ? (
              <p className="px-3 py-3 text-center text-[11px] text-neutral-500">
                まだプロジェクトがありません
              </p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    setActive(project.id);
                    setOpen(false);
                  }}
                  className={[
                    "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition",
                    project.id === activeId
                      ? "bg-pink-500/10 text-white"
                      : "text-neutral-300 hover:bg-[#1f1f1f] hover:text-white",
                  ].join(" ")}
                >
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {project.items.length} 件
                  </span>
                  {project.id === activeId && (
                    <span className="text-[10px] text-pink-300">●</span>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[#242424] p-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              新しいプロジェクトを作る
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  const isComposing =
                    (event.nativeEvent as KeyboardEvent).isComposing ||
                    event.keyCode === 229;
                  if (event.key === "Enter" && !isComposing) {
                    event.preventDefault();
                    handleCreate();
                  } else if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="プロジェクト名"
                className="h-7 flex-1 rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                作成して使う
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
