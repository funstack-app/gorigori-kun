import { useEffect, useMemo } from "react";
import { useComposer } from "../lib/store/composer";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useThreads } from "../lib/store/threads";
import { useToasts } from "../lib/store/toasts";
import { VirtualGalleryGrid } from "./VirtualGalleryGrid";

export function ImageGallery({
  onEdit,
  embedded = false,
}: {
  onEdit?: (path: string) => void;
  embedded?: boolean;
}) {
  const {
    items,
    selectedPath,
    selection,
    selectClick,
    clearSelection,
    saveToProject,
    startWatcher,
    attachListeners,
    watchDir,
    filter,
    setFilter,
    favorites,
    toggleFavorite,
    loadFavorites,
  } = useImages();
  const pushToast = useToasts((s) => s.push);
  const { cwd } = useThreads();
  const openMaskEditor = useMaskEditor((s) => s.open);
  const openPreview = useImagePreview((s) => s.open);

  useEffect(() => {
    attachListeners();
    startWatcher();
    loadFavorites();
  }, []);

  const visibleItems = useMemo(
    () => (filter === "favorites" ? items.filter((it) => favorites.has(it.path)) : items),
    [items, filter, favorites],
  );
  const selected = useMemo(
    () => items.find((it) => it.path === selectedPath),
    [items, selectedPath],
  );

  return (
    <div
      className={`flex h-full min-h-0 flex-col bg-white ${
        embedded ? "" : "border-l border-neutral-200"
      }`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 bg-stone-50 px-3 py-2 text-xs">
        <span className="font-semibold text-neutral-800">
          画像ライブラリ{" "}
          <span className="text-neutral-500">
            ({filter === "favorites" ? `${visibleItems.length} / ` : ""}
            {items.length})
          </span>
        </span>
        <span className="flex items-center gap-2">
          <div className="flex rounded-md border border-neutral-200 bg-white p-0.5 text-[10px]">
            <button
              onClick={() => setFilter("all")}
              className={`rounded px-2 py-0.5 ${
                filter === "all"
                  ? "bg-neutral-950 text-white"
                  : "text-neutral-500 hover:text-neutral-950"
              }`}
            >
              すべて
            </button>
            <button
              onClick={() => setFilter("favorites")}
              className={`flex items-center gap-1 rounded px-2 py-0.5 ${
                filter === "favorites"
                  ? "bg-rose-50 text-rose-600"
                  : "text-neutral-500 hover:text-rose-600"
              }`}
            >
              お気に入り <span>{favorites.size}</span>
            </button>
          </div>
          <span
            className="flex items-center gap-1.5 text-neutral-500"
            title={watchDir}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                watchDir ? "bg-lime-500" : "bg-neutral-300"
              }`}
            />
            {watchDir ? "監視中" : "未起動"}
          </span>
        </span>
      </div>

      {visibleItems.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <p className="text-center text-xs text-neutral-500">
            {filter === "favorites"
              ? "お気に入りはまだありません。サムネ右上の保存マークで追加できます。"
              : "まだ画像がありません。「夕焼けの東京タワーを 1 枚」のように依頼してみてください。"}
          </p>
        </div>
      ) : (
        <VirtualGalleryGrid
          items={visibleItems}
          selectedPath={selectedPath}
          selection={selection}
          favorites={favorites}
          onSelectClick={selectClick}
          onToggleFavorite={toggleFavorite}
        />
      )}

      {selection.size > 1 && (
        <SelectionActionBar
          selection={selection}
          items={items}
          cwd={useThreads.getState().cwd}
          onClear={clearSelection}
          onAttachAll={() => {
            const refs = items
              .filter((it) => selection.has(it.path))
              .map((it) => ({
                path: it.path,
                name: it.name,
                source: "gallery" as const,
              }));
            useComposer.getState().addReferences(refs);
            clearSelection();
            pushToast({
              kind: "success",
              text: `${refs.length} 枚を入力欄に添付しました`,
              ttlMs: 3500,
            });
          }}
          onSaveAll={async () => {
            const cwd = useThreads.getState().cwd;
            if (!cwd) return;
            const targets = items.filter(
              (it) => selection.has(it.path) && !it.savedTo,
            );
            for (const it of targets) {
              await saveToProject(it.path, cwd);
            }
            pushToast({
              kind: "success",
              text: `${targets.length} 枚をプロジェクトへ保存しました`,
              ttlMs: 3500,
            });
            clearSelection();
          }}
          onFavoriteAll={async () => {
            for (const path of selection) {
              if (!favorites.has(path)) await toggleFavorite(path);
            }
            clearSelection();
          }}
        />
      )}

      {selection.size <= 1 && selected && (
        <div className="border-t border-neutral-200 bg-white p-3 text-xs text-neutral-700">
          <p className="truncate font-mono font-medium text-neutral-900" title={selected.path}>
            {selected.name}
          </p>
          <p className="mt-1 text-neutral-500">
            {new Date(selected.mtimeMs).toLocaleString()} ·{" "}
            {Math.round(selected.size / 1024)} KB
          </p>

          {/* Primary action: AI prompt-based edit. Stretches across the
              panel so the user knows it's the headline action. */}
          {onEdit && (
            <button
              onClick={() => onEdit(selected.path)}
              className="mt-2.5 w-full rounded-md bg-neutral-950 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-neutral-800"
            >
              これを編集
            </button>
          )}

          {/* Secondary row: mask + preview only. Everything else
              (保存 / Finder / お気に入り) lives in the right-click menu
              on the thumbnail. */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() =>
                openMaskEditor({ path: selected.path, name: selected.name })
              }
              className="flex-1 rounded-md border border-lime-400 px-2 py-1 text-xs font-medium text-lime-800 hover:bg-lime-50"
              title="マスクで部分編集"
            >
              マスク
            </button>
            <button
              onClick={() => openPreview(selected.path)}
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 hover:border-neutral-500 hover:text-neutral-950"
              title="拡大表示"
            >
              拡大
            </button>
            {cwd && !selected.savedTo && (
              <button
                onClick={() => saveToProject(selected.path, cwd)}
                className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-700 hover:border-lime-500 hover:text-neutral-950"
                title={`${cwd} へ移動`}
              >
                保存
              </button>
            )}
          </div>

          <p className="mt-2 text-[10px] text-neutral-500">
            サムネを右クリックで全メニュー (名前を付けて保存 / Finder / お気に入り)
          </p>
        </div>
      )}
    </div>
  );
}

function SelectionActionBar({
  selection,
  items,
  cwd,
  onClear,
  onAttachAll,
  onSaveAll,
  onFavoriteAll,
}: {
  selection: Set<string>;
  items: { path: string; savedTo?: string }[];
  cwd?: string;
  onClear: () => void;
  onAttachAll: () => void;
  onSaveAll: () => void;
  onFavoriteAll: () => void;
}) {
  const unsavedCount = items.filter(
    (it) => selection.has(it.path) && !it.savedTo,
  ).length;
  return (
    <div className="border-t border-sky-200 bg-sky-50 px-3 py-2 text-xs text-neutral-700">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-semibold text-sky-800">
          {selection.size} 枚を選択中
        </span>
        <button
          onClick={onClear}
          className="text-neutral-500 hover:text-neutral-950"
          title="選択解除"
        >
          解除
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={onAttachAll}
          className="rounded-md bg-neutral-950 px-2.5 py-1 font-semibold text-white hover:bg-neutral-800"
          title="入力欄に添付して一括編集"
        >
          一括添付
        </button>
        <button
          onClick={onFavoriteAll}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 hover:border-rose-500 hover:text-rose-600"
        >
          一括お気に入り
        </button>
        {cwd && unsavedCount > 0 && (
          <button
            onClick={onSaveAll}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 hover:border-lime-500 hover:text-neutral-950"
            title={`${unsavedCount} 枚をプロジェクトへ移動`}
          >
            一括保存 ({unsavedCount})
          </button>
        )}
      </div>
    </div>
  );
}
