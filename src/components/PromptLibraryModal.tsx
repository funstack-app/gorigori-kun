import { useEffect, useMemo, useState } from "react";
import {
  comparePrompts,
  useSavedPrompts,
  type PromptSort,
  type SavedPrompt,
} from "../lib/store/savedPrompts";
import { useComposer } from "../lib/store/composer";
import { useToasts } from "../lib/store/toasts";
import { PromptEditorModal } from "./PromptEditorModal";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function PromptLibraryModal({ open, onClose }: Props) {
  const {
    items,
    loaded,
    sort,
    query,
    tag,
    load,
    remove,
    togglePin,
    duplicate,
    bumpUseCount,
    setSort,
    setQuery,
    setTag,
  } = useSavedPrompts();
  const pushToast = useToasts((s) => s.push);

  const [editor, setEditor] = useState<
    | { open: false }
    | { open: true; mode: "create"; initialBody?: string }
    | { open: true; mode: "edit"; prompt: SavedPrompt }
  >({ open: false });

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editor.open) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, editor.open]);

  const filtered = useMemo(() => {
    let list = items;
    if (tag) list = list.filter((p) => p.tags.includes(tag));
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return [...list].sort((a, b) => comparePrompts(a, b, sort));
  }, [items, query, tag, sort]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of items) for (const t of p.tags) set.add(t);
    return Array.from(set).sort();
  }, [items]);

  const insertPrompt = async (p: SavedPrompt, append: boolean) => {
    const composer = useComposer.getState();
    const cur = composer.text;
    const next =
      append && cur.trim().length > 0 ? `${cur.trimEnd()}\n\n${p.body}` : p.body;
    composer.setText(next);
    await bumpUseCount(p.id);
    pushToast({
      kind: "success",
      text: append ? "プロンプトを末尾に追加しました" : "プロンプトを挿入しました",
      ttlMs: 2500,
    });
    onClose();
  };

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="プロンプトライブラリ"
        onClick={() => {
          // Don't dismiss the library underneath while the editor is
          // still showing — clicks routed through the editor's own
          // backdrop must not bubble into a library close.
          if (editor.open) return;
          onClose();
        }}
      >
        <div
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
            <h3 className="text-base font-semibold text-neutral-100">
              📚 プロンプトライブラリ{" "}
              <span className="ml-1 text-xs text-neutral-500">
                ({items.length})
              </span>
            </h3>
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

          <div className="border-b border-neutral-800 bg-neutral-900/40 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="🔎 タイトル / 本文 / タグで検索"
                autoFocus
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 outline-none focus:border-emerald-500"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as PromptSort)}
                className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100"
                aria-label="並び替え"
              >
                <option value="recent">最近更新</option>
                <option value="used">よく使う</option>
                <option value="title">タイトル順</option>
              </select>
              <button
                type="button"
                onClick={() => setEditor({ open: true, mode: "create" })}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                ＋ 新規
              </button>
            </div>

            {allTags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setTag(null)}
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    tag === null
                      ? "bg-emerald-500/20 text-emerald-200"
                      : "border border-neutral-700 text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  すべて
                </button>
                {allTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTag(tag === t ? null : t)}
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      tag === t
                        ? "bg-emerald-500/20 text-emerald-200"
                        : "border border-neutral-700 text-neutral-400 hover:text-neutral-200"
                    }`}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-neutral-500">
                {items.length === 0 ? (
                  <span>
                    まだ保存したプロンプトはありません。
                    <br />
                    入力欄で本文を書いて「保存」を押すか、右上の「＋ 新規」から追加してください。
                  </span>
                ) : (
                  <span>条件に一致するプロンプトがありません。</span>
                )}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {filtered.map((p) => (
                  <PromptRow
                    key={p.id}
                    prompt={p}
                    onInsert={() => insertPrompt(p, false)}
                    onAppend={() => insertPrompt(p, true)}
                    onEdit={() =>
                      setEditor({ open: true, mode: "edit", prompt: p })
                    }
                    onDelete={async () => {
                      // Use Tauri's native ask() — window.confirm()
                      // silently no-ops on some webviews and we'd
                      // delete without intent.
                      let ok = false;
                      try {
                        const { ask } = await import(
                          "@tauri-apps/plugin-dialog"
                        );
                        ok = await ask(`「${p.title}」を削除しますか？`, {
                          title: "プロンプト削除",
                          kind: "warning",
                        });
                      } catch {
                        ok = window.confirm(`「${p.title}」を削除しますか？`);
                      }
                      if (!ok) return;
                      await remove(p.id);
                      pushToast({
                        kind: "success",
                        text: "削除しました",
                        ttlMs: 2500,
                      });
                    }}
                    onTogglePin={() => togglePin(p.id)}
                    onDuplicate={() => duplicate(p.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {editor.open && (
        <PromptEditorModal
          open={editor.open}
          mode={
            editor.mode === "create"
              ? { kind: "create", initialBody: editor.initialBody }
              : { kind: "edit", prompt: editor.prompt }
          }
          onClose={() => setEditor({ open: false })}
        />
      )}
    </>
  );
}

function PromptRow({
  prompt,
  onInsert,
  onAppend,
  onEdit,
  onDelete,
  onTogglePin,
  onDuplicate,
}: {
  prompt: SavedPrompt;
  onInsert: () => void;
  onAppend: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onDuplicate: () => void;
}) {
  const preview = prompt.body.replace(/\s+/g, " ").slice(0, 140);
  return (
    <li
      className={`group rounded-md border px-3 py-2.5 transition ${
        prompt.pinned
          ? "border-amber-700/40 bg-amber-950/15"
          : "border-neutral-800 bg-neutral-950/40 hover:border-neutral-700"
      }`}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onInsert}
          className="min-w-0 flex-1 text-left"
          title="クリックで composer に挿入"
        >
          <div className="flex items-center gap-2">
            {prompt.pinned && (
              <span aria-label="ピン留め" title="ピン留め">
                📌
              </span>
            )}
            <span className="truncate text-sm font-medium text-neutral-100">
              {prompt.title}
            </span>
            {prompt.useCount > 0 && (
              <span className="text-[10px] text-neutral-500">
                · {prompt.useCount} 回使用
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-neutral-400">
            {preview || <em className="text-neutral-600">(空)</em>}
          </p>
          {prompt.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {prompt.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-300"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </button>
        <div className="flex flex-shrink-0 flex-col gap-1 opacity-80 transition group-hover:opacity-100">
          <div className="flex gap-1">
            <RowBtn label="挿入" icon="⤵" onClick={onInsert} primary />
            <RowBtn label="末尾追加" icon="＋" onClick={onAppend} />
          </div>
          <div className="flex gap-1">
            <RowBtn
              label={prompt.pinned ? "ピンを外す" : "ピン留め"}
              icon="📌"
              onClick={onTogglePin}
            />
            <RowBtn label="複製" icon="📋" onClick={onDuplicate} />
            <RowBtn label="編集" icon="✏" onClick={onEdit} />
            <RowBtn label="削除" icon="🗑" onClick={onDelete} danger />
          </div>
        </div>
      </div>
    </li>
  );
}

function RowBtn({
  label,
  icon,
  onClick,
  primary,
  danger,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  const base =
    "flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition";
  const cls = primary
    ? `${base} bg-emerald-600 text-white hover:bg-emerald-500`
    : danger
      ? `${base} border border-neutral-700 text-neutral-300 hover:border-rose-500/60 hover:text-rose-300`
      : `${base} border border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100`;
  return (
    <button type="button" onClick={onClick} className={cls} aria-label={label}>
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
