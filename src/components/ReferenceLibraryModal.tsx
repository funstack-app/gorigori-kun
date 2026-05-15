import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";

import { useComposer } from "../lib/store/composer";
import { useImages } from "../lib/store/images";

// Why: Zustand selector が毎レンダーで新しい Set を返すと
//      React が Maximum update depth exceeded で白画面になる。
//      参照は selector 外で取り、useMemo で派生値を作る。
//      ルール: .claude/rules/templates/codex-worker.md "React + Zustand 安全パターン"

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Library modal — pick references from images previously generated/saved
 * inside this app. Lives next to the Composer so the user never leaves the
 * generation flow.
 *
 * Why: Magnific の「履歴」相当。ローカル PC から探す体験は別経路（追加ボタン）に分離。
 */
export function ReferenceLibraryModal({ open, onClose }: Props) {
  const items = useImages((s) => s.items);
  const addReference = useComposer((s) => s.addReference);
  const references = useComposer((s) => s.references);
  const existingPaths = useMemo(
    () => new Set(references.map((r) => r.path)),
    [references],
  );
  const [query, setQuery] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.name} ${item.path}`.toLowerCase().includes(q),
    );
  }, [items, query]);

  if (!open) return null;

  const handlePick = (path: string, name: string) => {
    addReference({ path, name, source: "gallery" });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
          <h3 className="text-sm font-black text-white">ライブラリから参照を追加</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-neutral-400 hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="border-b border-[#242424] px-4 py-3">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="検索（ファイル名）"
            className="h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-400"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[#343434] bg-[#101010] p-8 text-center text-xs text-neutral-500">
              {items.length === 0
                ? "まだこのアプリで生成した画像がありません"
                : "検索条件に一致する画像がありません"}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {filtered.map((item) => {
                const already = existingPaths.has(item.path);
                return (
                  <button
                    key={item.path}
                    type="button"
                    disabled={already}
                    onClick={() => handlePick(item.path, item.name)}
                    title={already ? "すでに参照に追加済み" : item.name}
                    className={[
                      "group relative aspect-square overflow-hidden rounded-md border bg-[#0b0b0b] transition",
                      already
                        ? "border-pink-400/60 opacity-60"
                        : "border-[#343434] hover:border-pink-400",
                    ].join(" ")}
                  >
                    <img
                      src={convertFileSrc(item.path)}
                      alt={item.name}
                      className="h-full w-full object-cover"
                    />
                    {already && (
                      <span className="absolute inset-x-1 bottom-1 rounded bg-pink-500/80 px-1 py-0.5 text-center text-[9px] font-black text-white">
                        追加済
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
