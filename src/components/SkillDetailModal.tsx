import { useEffect, useState } from "react";

import { skills as skillsIpc } from "../lib/ipc";
import { SkillIcon } from "./SkillIcon";

type SkillDetailModalProps = {
  skillId: string;
  title: string;
  description: string;
  /** Rust が返した実パス。無ければヘッダーのパス行を出さない。 */
  installedPath: string | null;
  onClose: () => void;
};

/**
 * スキルの詳細を表示するモーダル。
 *
 * ygn (2026-08-03): 読み込みはすべて IPC 経由にした。フロントで
 * `~/.codex/skills/...` を組み立てると、実体のある専用 CODEX_HOME と食い違う。
 * 実在判定も「エラーメッセージの文字列一致」ではなく listInstalled との
 * 照合 (決定論) で行う。
 */
export function SkillDetailModal({
  skillId,
  title,
  description,
  installedPath,
  onClose,
}: SkillDetailModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await skillsIpc.listInstalled();
        if (!list.some((s) => s.id === skillId)) {
          if (!cancelled) {
            setContent(null);
            setLoading(false);
          }
          return;
        }
        const [text] = await skillsIpc.readSkillMd(skillId);
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
  }, [skillId]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-80px)] min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[#343434] bg-[#1a1a1a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-[#2a2a2a] px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#101010] text-pink-300">
              <SkillIcon id={skillId} className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-base font-black text-white">{title}</h2>
              {installedPath && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
                  {installedPath}
                </p>
              )}
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#101010] p-3">
            <h3 className="text-xs font-black text-neutral-300">概要</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-200">
              {description}
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
                  このスキルの手順書ファイルが見つかりませんでした。削除された可能性があります。もう一度インポートしてください。
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
