import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory } from "@tauri-apps/api/path";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { exists, writeTextFile } from "@tauri-apps/plugin-fs";

import { GORI_SKILLS, type GoriSkill } from "../lib/skills/catalog";
import { useToasts } from "../lib/store/toasts";
import { activateSkill } from "./SkillBadge";
import { SkillDetailModal } from "./SkillDetailModal";
import { SkillIcon } from "./SkillIcon";

type SkillImportResult = {
  id: string;
  name: string;
  installedAt: string;
};

function relativeSkillPath(skill: GoriSkill) {
  return skill.path.replace(/^~\//, "");
}

export function SkillsWorkspace({ onUseSkill }: { onUseSkill?: () => void }) {
  const [present, setPresent] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(GORI_SKILLS.map((skill) => [skill.id, null])),
  );
  const [detailSkill, setDetailSkill] = useState<GoriSkill | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

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
          { name: "Skill Markdown", extensions: ["md", "markdown"] },
        ],
      });
      if (!selected) return; // キャンセル
      const path = Array.isArray(selected) ? selected[0] : selected;
      const result = await invoke<SkillImportResult>("skill_import", {
        sourcePath: path,
      });
      toast.push({
        kind: "success",
        text: `スキル「${result.name}」をインポートしました`,
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

  /**
   * 指定スキルの SKILL.md を読んで、ユーザー指定の保存先に書き出す。
   */
  const handleExport = async (skill: GoriSkill) => {
    try {
      const [content, _id] = await invoke<[string, string]>("skill_export_read", {
        skillId: skill.id,
      });
      const savePath = await saveFileDialog({
        defaultPath: `${skill.id}-SKILL.md`,
        filters: [
          { name: "Skill Markdown", extensions: ["md"] },
        ],
      });
      if (!savePath) return; // キャンセル
      await writeTextFile(savePath, content);
      toast.push({
        kind: "success",
        text: `スキル「${skill.name}」をエクスポートしました`,
        ttlMs: 4000,
      });
    } catch (err) {
      toast.push({
        kind: "error",
        text: `エクスポート失敗: ${String(err)}`,
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
            return (
              <article
                key={skill.id}
                className={`flex min-h-[260px] flex-col rounded-2xl border bg-[#181818] p-4 shadow-sm transition ${
                  isLocked
                    ? "border-[#222] opacity-60"
                    : "border-[#2a2a2a] hover:border-pink-400"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#101010] text-pink-300">
                    <SkillIcon id={skill.id} className="h-6 w-6" />
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                      isComingSoon
                        ? "bg-purple-500/15 text-purple-200"
                        : status === false
                          ? "bg-yellow-500/15 text-yellow-200"
                          : "bg-emerald-500/15 text-emerald-200"
                    }`}
                  >
                    {isComingSoon
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
                    onClick={() => !isLocked && useSkill(skill)}
                    className={`w-full rounded-lg px-3 py-2 text-xs font-black transition ${
                      isLocked
                        ? "cursor-not-allowed bg-neutral-700 text-neutral-400"
                        : "bg-pink-500 text-white hover:bg-pink-400"
                    }`}
                    aria-disabled={isLocked}
                    title={isLocked ? "近日公開予定" : undefined}
                  >
                    {isLocked ? "近日公開" : "使う"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailSkill(skill)}
                    className="w-full rounded-lg border border-[#343434] bg-[#101010] px-3 py-2 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
                  >
                    詳細を見る
                  </button>
                  {/* SKILL.md がローカルに実在するなら export 可能 */}
                  {status === true && !isComingSoon && (
                    <button
                      type="button"
                      onClick={() => handleExport(skill)}
                      className="w-full rounded-lg border border-[#242424] bg-transparent px-3 py-1.5 text-[10px] font-bold text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                      title="このスキルの SKILL.md を外部ファイルに書き出します"
                    >
                      エクスポート
                    </button>
                  )}
                  <p className="text-[10px] leading-relaxed text-neutral-500">
                    {skill.launchHint}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {detailSkill && (
        <SkillDetailModal
          skill={detailSkill}
          onClose={() => setDetailSkill(null)}
        />
      )}
    </section>
  );
}
