import { useEffect, useState } from "react";
import { BaseDirectory } from "@tauri-apps/api/path";
import { readTextFile, exists } from "@tauri-apps/plugin-fs";

import type { GoriSkill } from "../lib/skills/catalog";

type SkillDetailModalProps = {
  skill: GoriSkill;
  onClose: () => void;
};

/**
 * スキルの詳細を表示するモーダル。
 * ~/.codex/skills/{skill}/SKILL.md を読み込んで表示する。
 * 存在しないスキル(マルチアングル等、未実装)はカタログの説明だけ表示。
 */
export function SkillDetailModal({ skill, onClose }: SkillDetailModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const relative = `${skill.path.replace(/^~\//, "")}/SKILL.md`;
        const ok = await exists(relative, { baseDir: BaseDirectory.Home });
        if (!ok) {
          if (!cancelled) {
            setContent(null);
            setLoading(false);
          }
          return;
        }
        const text = await readTextFile(relative, { baseDir: BaseDirectory.Home });
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [skill]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-[#343434] bg-[#1a1a1a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-[#2a2a2a] px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#101010] text-2xl">
              {skill.icon}
            </div>
            <div>
              <h2 className="text-base font-black text-white">{skill.name}</h2>
              <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
                {skill.path}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#343434] bg-[#101010] px-2.5 py-1 text-xs font-bold text-neutral-400 hover:border-pink-400 hover:text-white"
          >
            閉じる
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4">
          <section className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#101010] p-3">
            <h3 className="text-xs font-black text-neutral-300">概要</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-200">
              {skill.description}
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-black text-neutral-300">
              詳細仕様 (SKILL.md)
            </h3>
            {loading && (
              <p className="text-xs text-neutral-500">読み込み中…</p>
            )}
            {!loading && error && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                読み込み失敗: {error}
              </p>
            )}
            {!loading && !error && content == null && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-[11px] text-amber-200">
                <p className="font-bold">SKILL.md が見つかりません</p>
                <p className="mt-1 text-neutral-400">
                  このスキルはまだ実装中です。アプリ側の準備ができ次第、
                  ~/.codex/skills/ に SKILL.md が配置されます。
                </p>
              </div>
            )}
            {!loading && !error && content != null && (
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-3 font-mono text-[11px] leading-relaxed text-neutral-200">
                {content}
              </pre>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
