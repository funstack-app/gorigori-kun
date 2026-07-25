import { useComposer } from "../lib/store/composer";
import { usePromptHistory } from "../lib/store/promptHistory";

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "たった今";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  const d = Math.floor(h / 24);
  return `${d} 日前`;
}

/**
 * Left rail showing the user's prompt history. Replaces the earlier
 * "session" sidebar — sessions never restored a real chat (codex
 * threads are process-scoped and we never persisted assistant
 * responses), so the abstraction was misleading. This is what the
 * user actually wanted: a list of past prompts you can click to
 * recall, plus a "+ 新規" button that resets the codex thread for a
 * clean chat.
 */
export function PromptHistorySidebar({ open }: { open: boolean }) {
  const { entries, loading } = usePromptHistory();
  const setText = useComposer((s) => s.setText);

  /**
   * Recall a past prompt — copy it back into the composer and stop.
   * History is a string-only recall (we tried replaying past images
   * as chat cards earlier and it racked up bugs faster than I could
   * fix them). To see the actual images, use the right-side gallery.
   */
  const onRecall = (prompt: string) => {
    setText(prompt);
  };

  return (
    <aside
      className={`flex flex-col border-r border-neutral-800 bg-neutral-950 transition-all duration-200 ${
        open ? "w-60" : "w-0 overflow-hidden"
      }`}
      aria-label="入力ヒストリーサイドバー"
    >
      {open && (
        <>
          <div className="border-b border-neutral-800 px-3 py-2">
            <span className="text-xs font-semibold text-neutral-300">
              入力ヒストリー
            </span>
          </div>

          <ul className="flex-1 overflow-y-auto" role="list">
            {entries.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-neutral-500">
                {loading ? "読み込み中…" : "まだ履歴がありません"}
              </li>
            )}
            {entries.map((e) => (
              <PromptRow
                key={e.id}
                prompt={e.prompt}
                count={e.count}
                createdAt={e.createdAt}
                onClick={() => onRecall(e.prompt)}
              />
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/** Toggle button placed in the header; mirrors the SessionToggleButton API
 *  so we can drop-in replace it from App.tsx without touching the header. */
export function PromptHistoryToggleButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-emerald-500/60 hover:text-emerald-300"
      aria-label={open ? "ヒストリーを閉じる" : "ヒストリーを開く"}
      title={open ? "ヒストリーを閉じる" : "ヒストリーを開く"}
    >
      {open ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      )}
    </button>
  );
}

function PromptRow({
  prompt,
  count,
  createdAt,
  onClick,
}: {
  prompt: string;
  count: number;
  createdAt: number;
  onClick: () => void;
}) {
  return (
    <li
      role="listitem"
      onClick={onClick}
      className="group cursor-pointer px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800/60"
      title={prompt}
    >
      <div className="flex min-w-0 flex-col">
        <span className="line-clamp-2 break-all text-neutral-200 group-hover:text-neutral-100">
          {prompt}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-500">
          <span>{timeAgo(createdAt)}</span>
          {count > 1 && (
            <span className="rounded bg-neutral-800 px-1 text-emerald-300/80">
              {count} 枚
            </span>
          )}
        </span>
      </div>
    </li>
  );
}
