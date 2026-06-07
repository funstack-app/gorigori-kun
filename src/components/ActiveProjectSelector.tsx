import { useEffect, useRef, useState } from "react";

import { useActiveProject } from "../lib/store/activeProject";
import { useProjects } from "../lib/store/projects";
import { useSceneStore } from "../lib/store/scene";
import { useToasts } from "../lib/store/toasts";

/**
 * 作業中プロジェクトを「別の」プロジェクトへ切り替えるときに、前プロジェクトの
 * シーン構築値 (要素別編集の元データ) を破棄する。これを消さないと、別案件に
 * 移っても前案件の構図/光/スタイルが残り、要素別編集に混ざる (#5 残留対策 2026-06-07)。
 *
 * 注意 (2026-06-07 独立レビュー指摘の修正):
 *  - 同じプロジェクトを再選択しただけのときは何もしない。未保存のシーン構築を
 *    無駄に消さないため、現在の activeId と一致したら早期 return する。
 *  - scenePromptOverride は **消さない**。動画タブの i2v プロンプト
 *    (sendCutToVideo が scenePromptOverride.set で入れる) を共有しており、
 *    ここで clear すると動画タブに送ったばかりの i2v プロンプトを巻き込んで
 *    消してしまう。override は元々アプリ再起動でリセットされる設計なので、
 *    プロジェクト切替で無理に消さなくても #5 の主症状(シーン構築値の残留)は
 *    resetScene() だけで解消する。
 */
function switchActiveProject(
  setActive: (id: string | null) => void,
  id: string | null,
  currentId: string | null,
): void {
  if (id === currentId) return; // 同一プロジェクト再選択は無操作
  useSceneStore.getState().resetScene();
  setActive(id);
}

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
  const movePlanChat = useProjects((s) => s.movePlanChat);
  const copyPlanChat = useProjects((s) => s.copyPlanChat);
  const activeId = useActiveProject((s) => s.activeProjectId);
  const setActive = useActiveProject((s) => s.setActive);
  const pushToast = useToasts((s) => s.push);
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  // FB#17: 企画チャットを別プロジェクトへ移動/コピーするサブパネルの開閉。
  const [chatMoveOpen, setChatMoveOpen] = useState(false);
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
  // FB#17: 移動/コピー元は現在のアクティブプロジェクト。チャットが無ければ操作不可。
  const activeChatCount = active?.planChat?.length ?? 0;
  // 移動先候補は自分以外のプロジェクト。
  const moveTargets = active ? projects.filter((p) => p.id !== active.id) : [];

  // ドロップダウンを閉じたらチャット移動サブパネルも畳む。
  useEffect(() => {
    if (!open) setChatMoveOpen(false);
  }, [open]);

  const handleCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    // 新規プロジェクト作成も「別案件を始める」= 切替なので switchActiveProject
    // 経由にして前案件のシーン構築値をクリアする (#5/R-2 残留対策 2026-06-07)。
    switchActiveProject(setActive, created.id, activeId);
    setDraftName("");
    setOpen(false);
  };

  // FB#17: 企画チャットを別プロジェクトへ移動/コピーする。
  const handleChatTransfer = (
    targetId: string,
    mode: "move" | "copy",
  ) => {
    if (!active) return;
    const target = projects.find((p) => p.id === targetId);
    const ok =
      mode === "move"
        ? movePlanChat(active.id, targetId)
        : copyPlanChat(active.id, targetId);
    if (!ok) {
      pushToast({
        kind: "error",
        text: "企画チャットを移動できませんでした（移動できるログがありません）",
        ttlMs: 3000,
      });
      return;
    }
    pushToast({
      kind: "success",
      text:
        mode === "move"
          ? `企画チャットを「${target?.name ?? "別プロジェクト"}」へ移動しました`
          : `企画チャットを「${target?.name ?? "別プロジェクト"}」へコピーしました`,
      ttlMs: 3000,
    });
    setChatMoveOpen(false);
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
                switchActiveProject(setActive, null, activeId);
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
                    switchActiveProject(setActive, project.id, activeId);
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
          {/*
            FB#17: 企画チャットのプロジェクト間移動 / コピー。
            アクティブプロジェクトにチャットログがある時だけ操作可能にする。
          */}
          {active && (
            <div className="border-t border-[#242424] p-2">
              <button
                type="button"
                onClick={() => setChatMoveOpen((prev) => !prev)}
                disabled={activeChatCount === 0 || moveTargets.length === 0}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] font-bold text-neutral-300 hover:bg-[#1f1f1f] hover:text-white disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
                title={
                  activeChatCount === 0
                    ? "このプロジェクトには移動できる企画チャットがありません"
                    : moveTargets.length === 0
                      ? "移動先になる別プロジェクトがありません"
                      : "企画チャットを別プロジェクトへ移動 / コピー"
                }
              >
                <span>企画チャットを別プロジェクトへ移動 / コピー</span>
                <span className="text-[10px] text-neutral-500">
                  {activeChatCount > 0 ? `${activeChatCount} 通 ▾` : "なし"}
                </span>
              </button>
              {chatMoveOpen && activeChatCount > 0 && moveTargets.length > 0 && (
                <div className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-md border border-[#242424] bg-[#101010] p-1">
                  {moveTargets.map((target) => (
                    <div
                      key={target.id}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
                        {target.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleChatTransfer(target.id, "move")}
                        className="rounded border border-pink-400/50 px-2 py-0.5 text-[10px] font-bold text-pink-200 hover:bg-pink-500/15 hover:text-white"
                        title={`チャットを「${target.name}」へ移動（このプロジェクトからは消えます）`}
                      >
                        移動
                      </button>
                      <button
                        type="button"
                        onClick={() => handleChatTransfer(target.id, "copy")}
                        className="rounded border border-[#343434] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
                        title={`チャットを「${target.name}」へコピー（このプロジェクトにも残ります）`}
                      >
                        コピー
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
