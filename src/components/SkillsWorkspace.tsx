import { useEffect, useState } from "react";
import { BaseDirectory } from "@tauri-apps/api/path";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";

import { skills as skillsIpc } from "../lib/ipc";
import { GORI_SKILLS, type GoriSkill } from "../lib/skills/catalog";
import { useSkillMode } from "../lib/store/skillMode";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
import { activateSkill } from "./SkillBadge";
import { SkillIcon } from "./SkillIcon";

function relativeSkillPath(skill: GoriSkill) {
  return skill.path.replace(/^~\//, "");
}

export function SkillsWorkspace({ onUseSkill }: { onUseSkill?: () => void }) {
  const [present, setPresent] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(GORI_SKILLS.map((skill) => [skill.id, null])),
  );
  const [refreshTick, setRefreshTick] = useState(0);

  // 現在 ON になっているスキル ID を購読し、トグル表示の判定に使う
  const activeSkillId = useSkillMode((s) => s.selectedSkillId);
  const skillEnabled = useSkillMode((s) => s.enabled);
  const setSkillEnabled = useSkillMode((s) => s.setEnabled);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      GORI_SKILLS.map(async (skill) => {
        try {
          const ok = await exists(`${relativeSkillPath(skill)}/SKILL.md`, {
            baseDir: BaseDirectory.Home,
          });
          return [skill.id, ok] as const;
        } catch {
          return [skill.id, true] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setPresent(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const useSkill = (skill: GoriSkill) => {
    activateSkill(skill);
    onUseSkill?.();
  };

  // スキルを「停止する」= 作品モード (default UI) に戻す。
  // STΛCK 指示 (2026-05-20):
  //  - チャット履歴 / 引き継ぎセクションは保持 (planChat.messages や
  //    storyboardRun.chatMessages はクリアしない)
  //  - skillMode を OFF にするだけで skillUiMode は自動的に default に戻る
  //    (skillMode.ts の syncUiMode → exitSkill)
  //  - workspace.purpose も "artwork" に戻して旧「ストーリーカット構築」UI が
  //    残らないようにする (activateSkill が videoStory に変えていたため)
  const stopSkill = (skill: GoriSkill) => {
    setSkillEnabled(false);
    setSelectedSkillId(null);
    useWorkspace.getState().setPurpose("artwork");
    useToasts.getState().push({
      kind: "info",
      text: `${skill.name} を停止しました。作品モードに戻ります。`,
      ttlMs: 3000,
    });
  };

  const toast = useToasts.getState();

  /**
   * SKILL.md ファイルをユーザーに選んでもらい、~/.codex/skills/ 配下に複製する。
   * frontmatter の name: フィールドから保存先ディレクトリ名を決める。
   */
  const handleImport = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Skill (Markdown / zip)",
            extensions: ["md", "markdown", "zip"],
          },
        ],
      });
      if (!selected) return; // キャンセル
      const path = Array.isArray(selected) ? selected[0] : selected;
      // 拡張子で単一 Markdown / zip 一括インポートを呼び分ける。
      const isZip = path.toLowerCase().endsWith(".zip");
      const result = isZip
        ? await skillsIpc.importZip(path)
        : await skillsIpc.importMarkdown(path);
      toast.push({
        kind: "success",
        text: isZip
          ? `スキル「${result.name}」をインポートしました (${result.fileCount} ファイル)`
          : `スキル「${result.name}」をインポートしました`,
        ttlMs: 4000,
      });
      // 再読み込み (実在チェックを更新)
      setRefreshTick((n) => n + 1);
    } catch (err) {
      toast.push({
        kind: "error",
        text: `インポート失敗: ${String(err)}`,
        ttlMs: 6000,
      });
    }
  };


  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      {/*
        ヘッダー右側にスキル import / export ツールバーを置く。
        外側 (App.tsx の BoardHeader) が「スキル」タイトルを出すので
        ここではタイトル文言は出さない。
      */}
      <div className="flex items-center justify-end gap-2 px-5 pt-4">
        <button
          type="button"
          onClick={handleImport}
          className="flex items-center gap-1.5 rounded-lg border border-[#343434] bg-[#1e1e1e] px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-pink-400 hover:text-white"
          title="SKILL.md ファイルを取り込んで、このアプリで使えるようにします"
        >
          <span>スキルをインポート</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {GORI_SKILLS.map((skill) => {
            const status = present[skill.id];
            const isComingSoon = skill.comingSoon === true;
            const isLocked = !skill.availableInApp;
            const isActive = skillEnabled && activeSkillId === skill.id;
            return (
              <article
                key={skill.id}
                className={`flex min-h-[260px] flex-col rounded-2xl border bg-[#181818] p-4 shadow-sm transition ${
                  isLocked
                    ? "border-[#222] opacity-60"
                    : isActive
                      ? "border-pink-500 ring-1 ring-pink-500/40"
                      : "border-[#2a2a2a] hover:border-pink-400"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#101010] text-pink-300">
                    <SkillIcon id={skill.id} className="h-6 w-6" />
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                      isActive
                        ? "bg-pink-500/20 text-pink-100"
                        : isComingSoon
                          ? "bg-purple-500/15 text-purple-200"
                          : status === false
                            ? "bg-yellow-500/15 text-yellow-200"
                            : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {isActive
                      ? "使用中"
                      : isComingSoon
                        ? "近日公開"
                        : status === false
                          ? "未検出"
                          : "接続済み"}
                  </span>
                </div>

                <h4 className="mt-4 text-sm font-black text-white">{skill.name}</h4>
                <p className="mt-2 min-h-[54px] text-xs leading-relaxed text-neutral-400">
                  {skill.description}
                </p>
                <p className="mt-3 truncate rounded-lg border border-[#242424] bg-[#101010] px-2 py-1.5 font-mono text-[10px] text-neutral-500">
                  {skill.path}
                </p>

                <div className="mt-auto space-y-2 pt-4">
                  <button
                    type="button"
                    disabled={isLocked}
                    onClick={() => {
                      if (isLocked) return;
                      if (isActive) {
                        stopSkill(skill);
                      } else {
                        useSkill(skill);
                      }
                    }}
                    className={`w-full rounded-lg px-3 py-2 text-xs font-black transition ${
                      isLocked
                        ? "cursor-not-allowed bg-neutral-700 text-neutral-400"
                        : isActive
                          ? "border border-pink-400 bg-pink-500/15 text-pink-100 hover:bg-pink-500/25"
                          : "bg-pink-500 text-white hover:bg-pink-400"
                    }`}
                    aria-disabled={isLocked}
                    aria-pressed={isActive}
                    title={
                      isLocked
                        ? "近日公開予定"
                        : isActive
                          ? "停止して作品モードに戻る"
                          : undefined
                    }
                  >
                    {isLocked
                      ? "近日公開"
                      : isActive
                        ? "停止する (作品モードへ)"
                        : "使う"}
                  </button>
                  {/* 「詳細を見る」「エクスポート」は STΛCK 指示 (2026-06-06) で撤去。
                      スキルカードは「使う」ボタンと一言説明だけに簡素化する。 */}
                  <p className="text-[10px] leading-relaxed text-neutral-500">
                    {skill.launchHint}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
