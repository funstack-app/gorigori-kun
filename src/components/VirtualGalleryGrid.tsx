import {
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Grid, type CellComponentProps } from "react-window";
import { SafeImage, SafeVideo } from "./SafeImage";
import {
  galleryItemMediaType,
  type GalleryItem,
  type Judgement,
} from "../lib/store/images";
import { useImagePreview } from "../lib/store/imagePreview";
import { ContextMenu } from "./ContextMenu";
import { buildGalleryItemMenu } from "./galleryItemMenu";
import { RegisterPresetDialog } from "./RegisterPresetDialog";
import type { LibraryDateGroup } from "./library/libraryGrouping";

const COLUMNS = 3;
const GAP = 8; // px (matches Tailwind gap-2)
const PADDING = 8; // px (matches Tailwind p-2)
const LIBRARY_GAP = 12; // px (matches Tailwind gap-3)
const LIBRARY_GRID_META_HEIGHT = 48;
const LIBRARY_LIST_ROW_HEIGHT = 56;

type GalleryViewMode = "grid" | "list";

type CellProps = {
  items: GalleryItem[];
  selectedPath?: string;
  selection: Set<string>;
  favorites: Set<string>;
  /** path -> 判定 (adopted / rejected)。無ければ候補 (バッジ無し)。 */
  judgements: Map<string, Judgement>;
  onSelectClick: (
    path: string,
    mods: { meta?: boolean; shift?: boolean },
    item: GalleryItem,
  ) => void;
  onToggleFavorite: (path: string) => void;
  onSetJudgement: (path: string, value: Judgement | null) => void;
  /** 拡大プレビューの矢印キー巡回をこのリスト内に限定する（プロジェクト詳細用）。
   *  未指定なら従来通り open(path) のみ = ライブラリ全体 fallback。 */
  previewSiblings?: string[];
  /** プロジェクト詳細から使うとき指定。右クリックメニューが
   *  「プロジェクトへ移動」の代わりに「このプロジェクトから外す」を出す。 */
  projectScope?: { onRemoveFromProject: (path: string) => void };
  /** セルの最小幅(px)。指定時は列数を floor(内寸/minCellWidth) で可変にする
   *  (下限1列)。未指定なら従来の3列固定。 */
  minCellWidth?: number;
  /** ライブラリ本画面用の見た目と操作。未指定なら従来のプロジェクト表示。 */
  variant?: "project" | "library";
  /** ライブラリ本画面の表示形式。variant="library" のときだけ使う。 */
  viewMode?: GalleryViewMode;
  /** グリッドの希望タイル幅(px)。variant="library" のときだけ使う。 */
  tileSize?: number;
  /** ライブラリ本画面が複数選択モードか。 */
  selectionMode?: boolean;
  /** ライブラリの日付グループ。見出しも同じ仮想スクロール内で描画する。 */
  dateGroups?: LibraryDateGroup[];
  /** タイル左上の選択チェック用。 */
  onToggleSelection?: (path: string) => void;
  /** 日付見出し横のチェック用。 */
  onToggleDateSelection?: (paths: string[]) => void;
};

type LibraryVirtualRow =
  | { kind: "header"; group: LibraryDateGroup }
  | { kind: "items"; items: GalleryItem[] };

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
  /** F-#1: ライブラリ右クリックメニュー → 「プリセット登録」で開くダイアログ。 */
  const [presetTarget, setPresetTarget] = useState<GalleryItem | null>(null);

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

  const isLibrary = props.variant === "library";
  const viewMode = props.viewMode ?? "grid";
  // ProjectGallery は従来計算を完全維持。ライブラリだけ表示幅とスライダー値から列数を決める。
  const columns = isLibrary
    ? viewMode === "list"
      ? 1
      : Math.max(
          1,
          Math.floor(
            (size.width + LIBRARY_GAP) /
              ((props.tileSize ?? 160) + LIBRARY_GAP),
          ) || 1,
        )
    : props.minCellWidth
      ? Math.max(
          1,
          Math.floor((size.width - PADDING * 2) / props.minCellWidth) || 1,
        )
      : COLUMNS;
  const cellSize = isLibrary
    ? size.width > 0
      ? Math.floor(size.width / columns)
      : 100
    : size.width > 0
      ? Math.floor((size.width - PADDING * 2) / columns)
      : 100;
  const rowHeight = isLibrary
    ? viewMode === "list"
      ? LIBRARY_LIST_ROW_HEIGHT
      : Math.ceil(
          Math.max(1, cellSize - LIBRARY_GAP) * (9 / 16) +
            LIBRARY_GRID_META_HEIGHT +
            LIBRARY_GAP,
        )
    : cellSize;
  const libraryRows = useMemo(
    () => buildLibraryRows(props.dateGroups, columns),
    [columns, props.dateGroups],
  );
  const hasDateGroups = isLibrary && props.dateGroups !== undefined;
  const rowCount = hasDateGroups
    ? libraryRows.length
    : Math.ceil(props.items.length / columns);
  const virtualRowHeight = hasDateGroups
    ? (rowIndex: number) =>
        libraryRows[rowIndex]?.kind === "header" ? 48 : rowHeight
    : rowHeight;

  const cellPropsWithMenu: CellPropsInternal = {
    ...props,
    columns,
    libraryRows: hasDateGroups ? libraryRows : undefined,
    libraryFullWidth: size.width,
    onContextMenu: (item, x, y) => setMenu({ item, x, y }),
  };

  return (
    <div
      ref={containerRef}
      data-tour={isLibrary ? "library-grid" : undefined}
      className="min-h-0 flex-1 overflow-hidden"
    >
      {size.width > 0 && size.height > 0 && (
        <Grid<CellPropsInternal>
          columnCount={columns}
          columnWidth={cellSize}
          rowCount={rowCount}
          rowHeight={virtualRowHeight}
          cellComponent={isLibrary ? LibraryCell : Cell}
          cellProps={cellPropsWithMenu}
          overscanCount={isLibrary ? 2 : undefined}
          style={
            isLibrary
              ? { height: size.height, width: size.width }
              : {
                  height: size.height,
                  width: size.width,
                  padding: PADDING / 2,
                }
          }
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildGalleryItemMenu(menu.item, {
            favorites: props.favorites,
            onToggleFavorite: props.onToggleFavorite,
            onRegisterPreset: () => setPresetTarget(menu.item),
            judgement: props.judgements.get(menu.item.path),
            onSetJudgement: props.onSetJudgement,
            projectScope: props.projectScope,
            previewSiblings: props.projectScope ? props.previewSiblings : undefined,
          })}
          onClose={() => setMenu(null)}
        />
      )}
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget.path}
          defaultName={isLibrary ? presetTarget.name : undefined}
          onClose={() => setPresetTarget(null)}
        />
      )}
    </div>
  );
}

type CellPropsInternal = CellProps & {
  /** 実際に描画に使う列数 (minCellWidth 指定時は可変、未指定なら COLUMNS)。 */
  columns: number;
  libraryRows?: LibraryVirtualRow[];
  libraryFullWidth: number;
  onContextMenu: (item: GalleryItem, x: number, y: number) => void;
};

function buildLibraryRows(
  groups: LibraryDateGroup[] | undefined,
  columns: number,
): LibraryVirtualRow[] {
  if (!groups) return [];
  const rows: LibraryVirtualRow[] = [];
  for (const group of groups) {
    rows.push({ kind: "header", group });
    for (let index = 0; index < group.items.length; index += columns) {
      rows.push({ kind: "items", items: group.items.slice(index, index + columns) });
    }
  }
  return rows;
}

function Cell({
  columnIndex,
  rowIndex,
  style,
  items,
  selectedPath,
  selection,
  favorites,
  judgements,
  columns,
  previewSiblings,
  onSelectClick,
  onToggleFavorite,
  onContextMenu,
}: CellComponentProps<CellPropsInternal>) {
  const i = rowIndex * columns + columnIndex;
  const it = items[i];
  if (!it) return <div style={style} />;
  const isFav = favorites.has(it.path);
  const judgement = judgements.get(it.path);
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
            onSelectClick(
              it.path,
              {
                meta: e.metaKey || e.ctrlKey,
                shift: e.shiftKey,
              },
              it,
            )
          }
          onDoubleClick={() =>
            useImagePreview.getState().open(it.path, previewSiblings)
          }
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(it, e.clientX, e.clientY);
          }}
          className="block h-full w-full"
          title={`${it.name}\nダブルクリックまたは右下の検索ボタンで拡大`}
          aria-label={`${it.name} — ダブルクリック=拡大 / 右クリック=メニュー / Cmd+クリック=複数選択`}
        >
          <GalleryMedia item={it} className="h-full w-full object-cover" />
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
        {judgement && (
          <span
            className={`pointer-events-none absolute bottom-1 left-1 rounded px-1 text-[10px] font-bold text-white shadow ${
              judgement === "adopted" ? "bg-pink-500/90" : "bg-neutral-600/90"
            }`}
          >
            {judgement === "adopted" ? "採用" : "ボツ"}
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
          <HeartIcon filled={isFav} />
        </button>
        {/*
          F-#3 修正 (2026-05-19): むぎさん要望対応。「クリックで拡大できる」発見性向上。
          ホバー時に右下に虫眼鏡アイコンを表示し、クリックすると拡大プレビューを開く。
          シングルクリック=選択 / ダブルクリック=拡大 のキーバインドは維持。
          虫眼鏡ボタンは1クリックで拡大できる導線として併設。
        */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            useImagePreview.getState().open(it.path, previewSiblings);
          }}
          aria-label="拡大表示"
          title="クリックで拡大表示"
          className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-neutral-200 opacity-0 transition group-hover:opacity-100 hover:bg-pink-500 hover:text-white"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** ライブラリ本画面用セル。従来の見た目とクリック動作を保ったまま仮想化する。 */
function LibraryCell({
  columnIndex,
  rowIndex,
  style,
  items,
  selection,
  favorites,
  judgements,
  columns,
  viewMode = "grid",
  selectionMode = false,
  onSelectClick,
  onToggleSelection,
  onToggleFavorite,
  onToggleDateSelection,
  onContextMenu,
  libraryRows,
  libraryFullWidth,
}: CellComponentProps<CellPropsInternal>) {
  const virtualRow = libraryRows?.[rowIndex];
  if (virtualRow?.kind === "header") {
    if (columnIndex > 0) return <div style={style} />;
    const paths = virtualRow.group.items.map((item) => item.path);
    const selectedCount = paths.filter((path) => selection.has(path)).length;
    const allSelected = paths.length > 0 && selectedCount === paths.length;
    const partlySelected = selectedCount > 0 && !allSelected;
    return (
      <div
        style={{ ...style, width: libraryFullWidth, zIndex: 2 }}
        className="flex items-center pr-3"
      >
        <div className="flex w-full items-center gap-3 border-b border-white/10 pb-2 pt-2">
          <button
            type="button"
            onClick={() => onToggleDateSelection?.(paths)}
            className={[
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition",
              allSelected || partlySelected
                ? "border-pink-400 bg-pink-500 text-white"
                : "border-white/20 bg-white/[0.04] text-transparent hover:border-pink-400",
            ].join(" ")}
            aria-label={`${virtualRow.group.label}の${paths.length}件を一括選択`}
            aria-pressed={allSelected}
          >
            {partlySelected ? <MinusIcon /> : <CheckIcon />}
          </button>
          <h3 className="text-[12px] font-bold text-neutral-200">
            {virtualRow.group.label}
          </h3>
          <span className="text-[10px] tabular-nums text-neutral-600">
            {virtualRow.group.items.length}件
          </span>
        </div>
      </div>
    );
  }

  const i = rowIndex * columns + columnIndex;
  const item =
    virtualRow?.kind === "items" ? virtualRow.items[columnIndex] : items[i];
  if (!item) return <div style={style} />;

  const isSelected = selection.has(item.path);
  const isFavorite = favorites.has(item.path);
  const judgement = judgements.get(item.path);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (selectionMode && onToggleSelection) {
      onToggleSelection(item.path);
      return;
    }
    if (!selectionMode) {
      useImagePreview.getState().open(item.path);
      return;
    }
    onSelectClick(
      item.path,
      { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey },
      item,
    );
  };
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onContextMenu(item, event.clientX, event.clientY);
  };

  if (viewMode === "list") {
    return (
      <div className="relative" style={{ ...style, paddingBottom: 4 }}>
        <button
          type="button"
          onContextMenu={handleContextMenu}
          onClick={handleClick}
          className={[
            "flex h-full w-full items-center gap-3 rounded-md border bg-[#1a1a1a] px-2 py-1.5 text-left transition",
            isSelected
              ? "border-pink-400 ring-1 ring-pink-500/40"
              : "border-[#2a2a2a] hover:border-pink-400",
          ].join(" ")}
        >
          <GalleryMedia item={item} className="h-10 w-16 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-neutral-200">
              {item.name}
            </p>
            <p className="truncate text-[10px] text-neutral-500">
              {selectionMode
                ? isSelected
                  ? "選択中（クリックで外す）"
                  : "クリックで選択"
                : "クリックで拡大プレビュー"}
            </p>
          </div>
          {judgement && (
            <span
              className={[
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold text-white",
                judgement === "adopted"
                  ? "bg-pink-500/90"
                  : "bg-neutral-600/90",
              ].join(" ")}
            >
              {judgement === "adopted" ? "採用" : "ボツ"}
            </span>
          )}
          {selectionMode && isSelected && (
            <span className="shrink-0 text-pink-400" aria-hidden>
              <CheckIcon />
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => onToggleFavorite(item.path)}
          className={[
            "absolute right-9 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg transition",
            isFavorite
              ? "bg-pink-500 text-white"
              : "text-neutral-500 hover:bg-white/10 hover:text-pink-300",
          ].join(" ")}
          aria-label={isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
        >
          <HeartIcon filled={isFavorite} />
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        ...style,
        paddingRight: LIBRARY_GAP,
        paddingBottom: LIBRARY_GAP,
      }}
    >
      <div
        className={[
          "group relative h-full overflow-hidden rounded-xl border bg-[#1a1a1a] text-left transition",
          isSelected
            ? "border-pink-400 ring-2 ring-pink-500/40"
            : "border-[#2a2a2a] hover:border-pink-400",
        ].join(" ")}
      >
        <button
          type="button"
          onContextMenu={handleContextMenu}
          onClick={handleClick}
          className="block h-full w-full text-left"
        >
          <GalleryMedia item={item} className="aspect-[16/9] w-full object-cover" />
          <div className="p-2">
            <p className="truncate text-[11px] font-bold text-neutral-200">
              {item.name}
            </p>
            <p className="mt-1 text-[10px] text-neutral-500">
              {selectionMode
                ? isSelected
                  ? "選択中（クリックで外す）"
                  : "クリックで選択"
                : "クリックで拡大プレビュー"}
            </p>
          </div>
        </button>
        {selectionMode && (
          <button
            type="button"
            onClick={() => onToggleSelection?.(item.path)}
            className={[
              "absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border-2",
              isSelected
                ? "border-pink-400 bg-pink-500 text-white"
                : "border-white/70 bg-black/60 text-transparent",
            ].join(" ")}
            aria-label={isSelected ? "選択から外す" : "選択する"}
          >
            <CheckIcon />
          </button>
        )}
        {!selectionMode && (
          <button
            type="button"
            onClick={() => onToggleSelection?.(item.path)}
            className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border-2 border-white/60 bg-black/60 text-transparent opacity-0 transition hover:border-pink-400 group-hover:opacity-100"
            aria-label="選択する"
          >
            <CheckIcon />
          </button>
        )}
        <button
          type="button"
          onClick={() => onToggleFavorite(item.path)}
          className={[
            "absolute right-2 bottom-[52px] flex h-7 w-7 items-center justify-center rounded-full shadow transition",
            isFavorite
              ? "bg-pink-500 text-white"
              : "bg-black/60 text-neutral-300 opacity-0 hover:bg-pink-500 hover:text-white group-hover:opacity-100",
          ].join(" ")}
          aria-label={isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
        >
          <HeartIcon filled={isFavorite} />
        </button>
        {galleryItemMediaType(item) === "video" && (
          <span className="pointer-events-none absolute bottom-[54px] left-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-bold text-white backdrop-blur">
            動画
          </span>
        )}
        {judgement && (
          <span
            className={[
              "pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold text-white shadow",
              judgement === "adopted"
                ? "bg-pink-500/90"
                : "bg-neutral-600/90",
            ].join(" ")}
          >
            {judgement === "adopted" ? "採用" : "ボツ"}
          </span>
        )}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="m5 10 3 3 7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M5 10h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} className="h-3.5 w-3.5" aria-hidden>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function GalleryMedia({ item, className }: { item: GalleryItem; className: string }) {
  if (galleryItemMediaType(item) === "video") {
    if (item.thumbnailPath) {
      return (
        <SafeImage
          path={item.thumbnailPath}
          alt={item.name}
          className={className}
          loading="lazy"
        />
      );
    }
    // 仮想グリッドで画面内の要素だけが mount される。自動再生せず metadata のみ
    // 読むため、大量動画でも全ファイルを同時に開かない。
    return (
      <SafeVideo
        path={item.path}
        className={`${className} pointer-events-none bg-black`}
      />
    );
  }
  return (
    <SafeImage
      path={item.path}
      thumbnail
      alt={item.name}
      className={className}
      loading="lazy"
    />
  );
}
