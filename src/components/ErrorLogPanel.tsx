import { useEffect, useRef, useState } from "react";
import { useErrorLog, type ErrorLogEntry } from "../lib/store/errorLog";
import { ModalPortal } from "./ModalPortal";

/**
 * エラーログパネル。
 *
 * サイドバー「エラーログ」から開く。トーストが消えた後でも
 * 「いつ・どこで・何が」を追えるようにするのが目的 (STΛCK 要望 2026-07-28)。
 *
 * 既存モーダル (PromptEditorModal) と同じ流儀:
 *   背景クリックで閉じる / Esc で閉じる / ダーク配色。
 */

type Props = {
  open: boolean;
  onClose: () => void;
};

function formatTime(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 1件をコピー用のテキストに整形する。 */
function entryToText(entry: ErrorLogEntry): string {
  const head = `[${formatTime(entry.at)}] ${entry.source}: ${entry.message}`;
  return entry.detail ? `${head}\n${entry.detail}` : head;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard が使えない環境は無視 (Toaster と同じ扱い)。
  }
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M15 6V5a1 1 0 00-1-1H5a1 1 0 00-1 1v9a1 1 0 001 1h1" />
    </svg>
  );
}

export function ErrorLogPanel({ open, onClose }: Props) {
  const entries = useErrorLog((s) => s.entries);
  const markRead = useErrorLog((s) => s.markRead);
  const clear = useErrorLog((s) => s.clear);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // 開いたら未読を既読にする。
  useEffect(() => {
    if (open) markRead();
  }, [open, markRead]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // 新しい順に並べる (store は末尾が最新)。
  const ordered = [...entries].reverse();

  return (
    <ModalPortal>
    <div
      ref={dialogRef}
      data-tour="error-log-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="エラーログ"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h3 className="text-base font-semibold text-neutral-100">エラーログ</h3>
          <div data-tour="error-log-actions" className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyText(ordered.map(entryToText).join("\n\n"))}
              disabled={ordered.length === 0}
              className="h-7 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 text-[11px] font-bold text-neutral-200 transition hover:border-pink-500/60 hover:text-pink-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              すべてコピー
            </button>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={ordered.length === 0}
              className="h-7 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 text-[11px] font-bold text-neutral-200 transition hover:border-rose-500/60 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              クリア
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              title="閉じる (Esc)"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 bg-neutral-800 text-neutral-200 transition hover:border-rose-500/60 hover:bg-rose-500/20 hover:text-rose-100"
            >
              ✕
            </button>
          </div>
        </div>

        <div
          data-tour="error-log-list"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {ordered.length === 0 ? (
            <p className="py-10 text-center text-xs text-neutral-500">
              エラーはまだありません
            </p>
          ) : (
            <ul className="space-y-1.5">
              {ordered.map((entry) => {
                const isOpen = expanded === entry.id;
                return (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-neutral-800 bg-neutral-950"
                  >
                    <div className="flex items-start gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : entry.id)}
                        className="min-w-0 flex-1 text-left"
                        title={entry.detail ? "詳細を開く" : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                            {formatTime(entry.at)}
                          </span>
                          <span className="shrink-0 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] font-bold text-pink-300">
                            {entry.source}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-neutral-200">
                          {entry.message}
                        </p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyText(entryToText(entry))}
                        className="mt-0.5 flex h-6 shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-1.5 text-[10px] font-bold text-neutral-400 transition hover:border-pink-500/60 hover:text-pink-100"
                        aria-label="コピー"
                        title="コピー"
                      >
                        <CopyIcon />
                        コピー
                      </button>
                    </div>
                    {isOpen && entry.detail && (
                      <pre className="mx-3 mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/40 p-2 text-[11px] leading-relaxed text-neutral-400">
                        {entry.detail}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
