import { useEffect, useRef, useState } from "react";
import {
  useSavedPrompts,
  type SavedPrompt,
} from "../lib/store/savedPrompts";
import { useToasts } from "../lib/store/toasts";

const BODY_SOFT_CAP = 32_000;

// Use \u escapes for the invisible characters so the source stays
// plain ASCII and tools (file, grep, diff) treat it as text.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const BIDI_FORMAT = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

function normalizeTag(input: string): string {
  return input.replace(CONTROL_CHARS, "").replace(BIDI_FORMAT, "").trim();
}

type Mode =
  | { kind: "create"; initialBody?: string }
  | { kind: "edit"; prompt: SavedPrompt };

type Props = {
  open: boolean;
  mode: Mode;
  onClose: () => void;
};

export function PromptEditorModal({ open, mode, onClose }: Props) {
  const save = useSavedPrompts((s) => s.save);
  const pushToast = useToasts((s) => s.push);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode.kind === "edit") {
      setTitle(mode.prompt.title);
      setBody(mode.prompt.body);
      setTags(mode.prompt.tags);
    } else {
      setTitle("");
      setBody(mode.initialBody ?? "");
      setTags([]);
    }
    setTagInput("");
  }, [open, mode]);

  // Esc to close + Tab focus trap. The library underneath has its own
  // gate to ignore Esc while we're open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const commit = async () => {
    const t = title.trim();
    if (!t) {
      pushToast({ kind: "warn", text: "タイトルを入力してください" });
      return;
    }
    if (!body.trim()) {
      pushToast({ kind: "warn", text: "プロンプト本文を入力してください" });
      return;
    }
    if (body.length > BODY_SOFT_CAP) {
      pushToast({
        kind: "warn",
        text: `本文が長すぎます (${body.length} / ${BODY_SOFT_CAP} 文字以内)`,
      });
      return;
    }
    await save(
      mode.kind === "edit"
        ? {
            id: mode.prompt.id,
            title: t,
            body,
            tags,
            pinned: mode.prompt.pinned,
            useCount: mode.prompt.useCount,
          }
        : {
            title: t,
            body,
            tags,
            pinned: false,
            useCount: 0,
          },
    );
    pushToast({
      kind: "success",
      text:
        mode.kind === "edit"
          ? "プロンプトを更新しました"
          : "プロンプトを保存しました",
      ttlMs: 3000,
    });
    onClose();
  };

  const addTag = () => {
    const v = normalizeTag(tagInput);
    if (!v) {
      setTagInput("");
      return;
    }
    if (!tags.includes(v)) setTags([...tags, v]);
    setTagInput("");
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="プロンプト編集"
      onClick={onClose}
    >
      <div
        className="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-neutral-100">
            {mode.kind === "edit" ? "プロンプトを編集" : "プロンプトを保存"}
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

        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="block text-xs text-neutral-300">タイトル</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 夕焼けの東京タワー (アニメ風)"
              autoFocus
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
          </label>

          <label className="block">
            <span className="block text-xs text-neutral-300">本文</span>
            <textarea
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="プロンプト本文を入力..."
              className="mt-1 w-full resize-y rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-emerald-500"
            />
            <span
              className={`mt-1 block text-[11px] ${
                body.length > BODY_SOFT_CAP
                  ? "text-rose-400"
                  : "text-neutral-500"
              }`}
            >
              {body.length} / {BODY_SOFT_CAP} 文字
            </span>
          </label>

          <div className="block">
            <span className="block text-xs text-neutral-300">
              タグ (Enter で追加)
            </span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                >
                  #{t}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    aria-label={`${t} を外す`}
                    className="text-emerald-400 hover:text-rose-400"
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                aria-label="タグを追加"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  } else if (
                    e.key === "Backspace" &&
                    tagInput === "" &&
                    tags.length > 0
                  ) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                placeholder={tags.length === 0 ? "風景, 夕焼け, ..." : ""}
                className="min-w-[100px] flex-1 bg-transparent text-xs text-neutral-100 outline-none"
              />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={commit}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            {mode.kind === "edit" ? "更新" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
