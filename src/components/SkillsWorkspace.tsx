import { useEffect, useState } from "react";
import { BaseDirectory } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";

import { GORI_SKILLS, type GoriSkill } from "../lib/skills/catalog";
import { activateSkill } from "./SkillBadge";
import { SkillDetailModal } from "./SkillDetailModal";

function relativeSkillPath(skill: GoriSkill) {
  return skill.path.replace(/^~\//, "");
}

export function SkillsWorkspace({ onUseSkill }: { onUseSkill?: () => void }) {
  const [present, setPresent] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(GORI_SKILLS.map((skill) => [skill.id, null])),
  );
  const [detailSkill, setDetailSkill] = useState<GoriSkill | null>(null);

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
  }, []);

  const useSkill = (skill: GoriSkill) => {
    activateSkill(skill);
    onUseSkill?.();
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-[#121212]">
      {/*
        ヘッダーは外側 (App.tsx の BoardHeader) が「スキル」タイトルを出すので、
        ここでは内側にもう一段ヘッダーを置かない。
        説明文も冗長なので省略。
      */}
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
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#101010] text-2xl">
                    {skill.icon}
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
                    title={isLocked ? "β 版以降で公開予定" : undefined}
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
