import { useEffect, useRef, useState } from "react";
import { Grid, type CellComponentProps } from "react-window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type GalleryItem } from "../lib/store/images";
import { useImagePreview } from "../lib/store/imagePreview";
import { ContextMenu } from "./ContextMenu";
import { buildGalleryItemMenu } from "./galleryItemMenu";

const COLUMNS = 3;
const GAP = 8; // px (matches Tailwind gap-2)
const PADDING = 8; // px (matches Tailwind p-2)

type CellProps = {
  items: GalleryItem[];
  selectedPath?: string;
  selection: Set<string>;
  favorites: Set<string>;
  onSelectClick: (
    path: string,
    mods: { meta?: boolean; shift?: boolean },
  ) => void;
  onToggleFavorite: (path: string) => void;
};

/**
 * Virtualized image grid. Renders only rows currently in view, so it stays
 * fast even when the gallery has thousands of images. 3 fixed columns,
 * square cells sized to the container width. Each cell carries its own gap
 * padding (react-window doesn't understand CSS gap), so the visible spacing
 * matches the original gap-2 + p-2 design.
 */
type MenuState = { x: number; y: number; item: GalleryItem } | null;

export function VirtualGalleryGrid(props: CellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [menu, setMenu] = useState<MenuState>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const cellSize =
    size.width > 0 ? Math.floor((size.width - PADDING * 2) / COLUMNS) : 100;
  const rowCount = Math.ceil(props.items.length / COLUMNS);

  const cellPropsWithMenu: CellPropsInternal = {
    ...props,
    onContextMenu: (item, x, y) => setMenu({ item, x, y }),
  };

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden">
      {size.width > 0 && size.height > 0 && (
        <Grid<CellPropsInternal>
          columnCount={COLUMNS}
          columnWidth={cellSize}
          rowCount={rowCount}
          rowHeight={cellSize}
          cellComponent={Cell}
          cellProps={cellPropsWithMenu}
          style={{
            height: size.height,
            width: size.width,
            padding: PADDING / 2,
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildGalleryItemMenu(menu.item, {
            favorites: props.favorites,
            onToggleFavorite: props.onToggleFavorite,
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

type CellPropsInternal = CellProps & {
  onContextMenu: (item: GalleryItem, x: number, y: number) => void;
};

function Cell({
  columnIndex,
  rowIndex,
  style,
  items,
  selectedPath,
  selection,
  favorites,
  onSelectClick,
  onToggleFavorite,
  onContextMenu,
}: CellComponentProps<CellPropsInternal>) {
  const i = rowIndex * COLUMNS + columnIndex;
  const it = items[i];
  if (!it) return <div style={style} />;
  const isFav = favorites.has(it.path);
  const isInMultiSelection = selection.has(it.path);
  const isPrimary = selectedPath === it.path;
  // Visual: blue ring when in multi-selection (more than one selected),
  // emerald ring when this is the active "primary" focus.
  const ringClass =
    selection.size > 1 && isInMultiSelection
      ? "ring-2 ring-sky-500"
      : isPrimary
        ? "ring-2 ring-lime-500 ring-offset-2 ring-offset-white"
        : "ring-1 ring-neutral-200 hover:ring-neutral-400";
  return (
    <div style={{ ...style, padding: GAP / 2 }}>
      <div
        className={`group relative h-full w-full overflow-hidden rounded-md transition ${ringClass}`}
      >
        <button
          draggable
          onDragStart={(e) => {
            const payload = JSON.stringify({
              path: it.path,
              name: it.name,
              source: "gallery",
              role: "subject",
            });
            e.dataTransfer.setData("application/x-gori-reference", payload);
            e.dataTransfer.setData("application/json", payload);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={(e) =>
            onSelectClick(it.path, {
              meta: e.metaKey || e.ctrlKey,
              shift: e.shiftKey,
            })
          }
          onDoubleClick={() => useImagePreview.getState().open(it.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(it, e.clientX, e.clientY);
          }}
          className="block h-full w-full"
          title={it.name}
          aria-label={`${it.name} — ダブルクリック=拡大 / 右クリック=メニュー / Cmd+クリック=複数選択`}
        >
          <img
            src={convertFileSrc(it.path)}
            alt={it.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </button>
        {isInMultiSelection && (
          <span
            className={`pointer-events-none absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white shadow ${
              selection.size > 1 && !isPrimary ? "bg-sky-500" : "bg-lime-500"
            }`}
          >
            ✓
          </span>
        )}
        {it.savedTo && (
          <span className="pointer-events-none absolute right-7 top-1 rounded bg-lime-600/90 px-1 text-[10px] text-white">
            保存済み
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(it.path);
          }}
          aria-label={isFav ? "お気に入りから外す" : "お気に入りに追加"}
          className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-xs shadow ${
            isFav
              ? "bg-rose-500 text-white"
              : "bg-black/60 text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-500 hover:text-white"
          }`}
        >
          ♥
        </button>
      </div>
    </div>
  );
}
