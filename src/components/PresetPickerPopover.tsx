import { useEffect, useMemo, useRef, useState } from "react";

import {
  focusToImageStyle,
  presetKind,
  usePresets,
  type Preset,
  type PresetCategory,
} from "../lib/store/presets";
import { CharacterIcon } from "./SkillIcon";

type Props = {
  open: boolean;
  onClose: () => void;
  /** プリセットが選ばれたときに呼ぶ。プロンプト末尾に追記される。 */
  onPick: (preset: Preset) => void;
  /** ボタン要素のアンカー（位置合わせ用）。null なら画面中央 */
  anchorRect?: DOMRect | null;
};

/**
 * プリセット呼び出しポップオーバー。参照ラックの「プリセット」ボタンから開く。
 * - カテゴリ別にグルーピング表示
 * - クリック = プロンプト末尾に追記（onPick 経由）
 * - 検索ボックスで絞り込み（プリセット名 + 本文）
 *
 * 管理（追加/編集/削除）は左サイドバーの「プリセット」ナビで行う想定で、
 * このポップオーバーは「呼び出し専用」に絞る。
 */
/**
 * カテゴリフィルタの選択値。
 * - "_fav" = お気に入りのみ（デフォルトで先頭表示）
 * - null   = すべて
 * - string = カテゴリ ID
 * - "_uncat" = 未分類
 */
type CategoryFilter = string | null | "_fav" | "_uncat";

type ParsedPresetQuery = {
  tagTokens: string[];
  textTokens: string[];
};

function parsePresetQuery(query: string): ParsedPresetQuery {
  const trimmed = query.trim();
  if (!trimmed) return { tagTokens: [], textTokens: [] };

  const tokens = trimmed.split(/\s+/);
  const tagTokens: string[] = [];
  const textTokens: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("#")) {
      if (token.length > 1) tagTokens.push(token.slice(1).toLowerCase());
    } else {
      textTokens.push(token.toLowerCase());
    }
  }
  return { tagTokens, textTokens };
}

function matchesTagTokens(preset: Preset, tagTokens: string[]): boolean {
  if (tagTokens.length === 0) return true;
  const presetTags = (preset.tags ?? []).map((tag) => tag.toLowerCase());
  return tagTokens.every((tagToken) => presetTags.includes(tagToken));
}

function matchesTextTokens(preset: Preset, textTokens: string[]): boolean {
  if (textTokens.length === 0) return true;
  const haystack =
    `${preset.name} ${preset.prompt} ${preset.description ?? ""} ${preset.characterMeta?.attributes ?? ""}`.toLowerCase();
  return textTokens.every((textToken) => haystack.includes(textToken));
}

function getTrailingTagFragment(query: string): string | null {
  if (query.length === 0 || /\s$/.test(query)) return null;
  const tokens = query.trim().split(/\s+/);
  const lastToken = tokens[tokens.length - 1];
  if (!lastToken?.startsWith("#")) return null;
  return lastToken.slice(1).toLowerCase();
}

function replaceTrailingTagToken(query: string, tag: string): string {
  return query.replace(/(^|\s)#\S*$/, `$1#${tag} `);
}

export function PresetPickerPopover({ open, onClose, onPick, anchorRect }: Props) {
  const categories = usePresets((s) => s.categories);
  const presets = usePresets((s) => s.presets);
  const [query, setQuery] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const parsedQuery = useMemo(() => parsePresetQuery(query), [query]);
  const trailingTagFragment = useMemo(() => getTrailingTagFragment(query), [query]);
  const favoriteCount = useMemo(
    () => presets.filter((p) => p.favorite).length,
    [presets],
  );
  // Bug修正 (2026-05-28): 開いた後のeffectフォールバックではなく、初期表示前に選択を確定する。
  const [filter, setFilter] = useState<CategoryFilter>(() =>
    favoriteCount > 0 ? "_fav" : null,
  );
  const activeFilter: CategoryFilter =
    filter === "_fav" && favoriteCount === 0 ? null : filter;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        onClose();
      }
    };
    // open 直後の同 tick で発火しないよう次フレームで bind
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  /** 各カテゴリの件数（チップ表示用、フィルタ反映前の検索だけ適用） */
  const counts = useMemo(() => {
    const matched = presets.filter(
      (p) =>
        matchesTagTokens(p, parsedQuery.tagTokens) &&
        matchesTextTokens(p, parsedQuery.textTokens),
    );
    const byCat = new Map<string | "_uncat", number>();
    let fav = 0;
    for (const p of matched) {
      const key = p.categoryId ?? "_uncat";
      byCat.set(key, (byCat.get(key) ?? 0) + 1);
      if (p.favorite) fav += 1;
    }
    return { all: matched.length, fav, byCat };
  }, [presets, parsedQuery]);

  const tagSuggestions = useMemo(() => {
    if (trailingTagFragment === null) return [];
    const tags = new Set<string>();
    for (const preset of presets) {
      for (const tag of preset.tags ?? []) {
        const normalized = tag.trim().toLowerCase();
        if (normalized) tags.add(normalized);
      }
    }
    return [...tags]
      .filter((tag) => tag.includes(trailingTagFragment))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 8);
  }, [presets, trailingTagFragment]);

  /** 表示対象（検索 + カテゴリフィルタ適用済み） */
  const grouped = useMemo(() => {
    let filtered = presets;
    if (activeFilter === "_fav") {
      filtered = filtered.filter((p) => p.favorite);
    } else if (activeFilter !== null) {
      filtered = filtered.filter((p) =>
        activeFilter === "_uncat" ? p.categoryId === null : p.categoryId === activeFilter,
      );
    }
    filtered = filtered
      .filter((p) => matchesTagTokens(p, parsedQuery.tagTokens))
      .filter((p) => matchesTextTokens(p, parsedQuery.textTokens));
    const byCategory = new Map<string | null, Preset[]>();
    for (const preset of filtered) {
      const list = byCategory.get(preset.categoryId) ?? [];
      list.push(preset);
      byCategory.set(preset.categoryId, list);
    }
    const sections: { category: PresetCategory | null; items: Preset[] }[] = [];
    for (const cat of categories) {
      const items = byCategory.get(cat.id) ?? [];
      if (items.length > 0) sections.push({ category: cat, items });
    }
    const uncategorized = byCategory.get(null) ?? [];
    if (uncategorized.length > 0) {
      sections.push({ category: null, items: uncategorized });
    }
    return sections;
  }, [categories, presets, parsedQuery, activeFilter]);

  if (!open) return null;

  // anchorRect があればそのすぐ下、なければ画面中央。
  // maxHeight で「アンカー下端〜画面下端」に収め、本体が画面外にはみ出して
  // フッター/末尾が見えなくなるのを防ぐ (2026-06-07 STΛCK報告: 下が見えない)。
  //
  // 企画タブはチャット UI で入力欄が画面下部に固定されるため、アンカー (プリセット
  // ボタン) が画面最下部に来る。下開き固定だとポップオーバーが画面外に飛び出して
  // 選べない (2026-06-11 NRC/f_matsu 報告)。下に 240px 入らず上に余裕がある場合は
  // 上方向に開く。制作/動画タブはボタンが中〜上部なので従来どおり下開きのまま。
  const MIN_POPOVER_HEIGHT = 240;
  const spaceBelow = anchorRect
    ? window.innerHeight - anchorRect.bottom - 8 - 16
    : 0;
  const spaceAbove = anchorRect ? anchorRect.top - 8 - 16 : 0;
  const openUpward =
    !!anchorRect && spaceBelow < MIN_POPOVER_HEIGHT && spaceAbove > spaceBelow;

  const style: React.CSSProperties = anchorRect
    ? openUpward
      ? {
          position: "fixed",
          // アンカー上端を底辺にして上方向に開く。
          bottom: window.innerHeight - anchorRect.top + 8,
          left: Math.max(8, anchorRect.left),
          maxHeight: `max(${MIN_POPOVER_HEIGHT}px, ${spaceAbove}px)`,
          zIndex: 60,
        }
      : {
          position: "fixed",
          top: anchorRect.bottom + 8,
          left: Math.max(8, anchorRect.left),
          // アンカー下端〜画面下端に収める。ただしアンカーが画面下部にあって
          // 残り高さが極小/負になるとリストが潰れるので、最低 240px は確保する。
          maxHeight: `max(${MIN_POPOVER_HEIGHT}px, ${spaceBelow}px)`,
          zIndex: 60,
        }
    : {
        position: "fixed",
        top: "10%",
        left: "50%",
        transform: "translateX(-50%)",
        maxHeight: "80vh",
        zIndex: 60,
      };

  const totalCount = presets.length;
  const visibleCount = grouped.reduce((acc, s) => acc + s.items.length, 0);
  const uncatCount = counts.byCat.get("_uncat") ?? 0;

  return (
    <div
      ref={containerRef}
      style={{ ...style, width: 360 }}
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[#242424] px-3 py-2">
        <h3 className="text-xs font-black text-white">プリセット</h3>
        <span className="text-[10px] font-medium text-neutral-500">
          {activeFilter === null && !query ? `${totalCount} 件` : `${visibleCount} / ${totalCount} 件`}
        </span>
      </div>
      <div className="shrink-0 space-y-2 border-b border-[#242424] p-3">
        <input
          type="search"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="検索（名前 / 本文 / メモ / #タグ）"
          className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
        />
        {tagSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tagSuggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setQuery((current) => replaceTrailingTagToken(current, tag))}
                className="rounded-full border border-[#343434] bg-[#101010] px-2 py-0.5 text-[10px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
        {/* カテゴリチップ。お気に入りを最左、その右にすべて、カテゴリ、未分類。
            横スクロールでカテゴリが多くても収まる。
            pb-2 を入れて、横スクロールバーが下のリストとくっつかないようにする。 */}
        <div className="flex items-center gap-1 overflow-x-auto pb-2">
          <FavoriteChip
            count={counts.fav}
            active={activeFilter === "_fav"}
            onClick={() => setFilter("_fav")}
          />
          <CategoryChip
            label="すべて"
            count={counts.all}
            color="#737373"
            active={activeFilter === null}
            onClick={() => setFilter(null)}
          />
          {categories.map((cat) => (
            <CategoryChip
              key={cat.id}
              label={cat.name}
              count={counts.byCat.get(cat.id) ?? 0}
              color={cat.color}
              active={activeFilter === cat.id}
              onClick={() => setFilter(cat.id)}
            />
          ))}
          {uncatCount > 0 && (
            <CategoryChip
              label="未分類"
              count={uncatCount}
              color="#525252"
              active={activeFilter === "_uncat"}
              onClick={() => setFilter("_uncat")}
            />
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {totalCount === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-neutral-500">
            まだプリセットがありません。<br />
            左サイドバー「プリセット」から登録できます。
          </p>
        ) : grouped.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-neutral-500">
            検索条件に一致するプリセットがありません
          </p>
        ) : (
          grouped.map((section) => (
            <div key={section.category?.id ?? "_uncat"} className="mb-3 last:mb-0">
              <div className="mb-1 flex items-center gap-2 px-1">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: section.category?.color ?? "#525252" }}
                  aria-hidden
                />
                <span className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
                  {section.category?.name ?? "未分類"}
                </span>
              </div>
              <div className="space-y-1">
                {section.items.map((preset) => (
                  <PickerRow
                    key={preset.id}
                    preset={preset}
                    onPick={() => {
                      onPick(preset);
                      onClose();
                    }}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** カテゴリフィルタチップ。色マーカー + 名前 + 件数。アクティブはピンクアウトライン */
function CategoryChip({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold transition",
        active
          ? "border-pink-400 bg-pink-500/10 text-white"
          : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200",
      ].join(" ")}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span>{label}</span>
      <span className={active ? "text-pink-200" : "text-neutral-600"}>{count}</span>
    </button>
  );
}

/**
 * お気に入り専用チップ。最左に固定表示。
 * 件数が 0 でも非表示にしない（クリックでお気に入りビューに切替できるように）。
 */
function FavoriteChip({
  count,
  active,
  onClick,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold transition",
        active
          ? "border-pink-400 bg-pink-500/15 text-white"
          : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-pink-400 hover:text-neutral-200",
      ].join(" ")}
      title="お気に入りのみ表示"
    >
      <span
        className={active ? "text-pink-200" : "text-pink-400"}
        aria-hidden
      >
        ★
      </span>
      <span>お気に入り</span>
      <span className={active ? "text-pink-200" : "text-neutral-600"}>{count}</span>
    </button>
  );
}

/**
 * ピッカーの 1 行。サムネ（あれば 36x36）+ 名前 + プロンプト要約 + ★。
 * クリックでプリセット適用 → ポップオーバー閉じる。
 */
function PickerRow({
  preset,
  onPick,
}: {
  preset: Preset;
  onPick: () => void;
}) {
  const isFavorite = !!preset.favorite;
  const isCharacter = presetKind(preset) === "character";
  // ユーザー指摘: グリッド / リスト / ピッカー（制作タブから呼ばれる）で
  // サムネ見え方を完全統一する。focal point + zoom の両方を反映。
  const imageStyle = focusToImageStyle(preset.thumbnailFocus);
  return (
    <button
      type="button"
      onClick={onPick}
      title={preset.prompt}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-[#1f1f1f]"
    >
      {/* 16:9 サムネ。カード/リストと比率を揃え、編集時に設定した見え方そのまま表示。 */}
      <span className="relative aspect-[16/9] h-10 shrink-0 overflow-hidden rounded-md border border-[#242424] bg-[#0d0d0d]">
        {preset.thumbnail ? (
          <img
            src={preset.thumbnail}
            alt=""
            className="h-full w-full object-cover"
            style={imageStyle}
            loading="lazy"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[8px] font-bold uppercase tracking-wide text-neutral-600">
            No Img
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {isCharacter && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-pink-400/60 bg-pink-500/10 px-1.5 py-px text-[9px] font-black text-pink-300"
              title="キャラクター登録"
            >
              <CharacterIcon className="h-2.5 w-2.5" />
              キャラ
            </span>
          )}
          <span className="block truncate font-bold">{preset.name}</span>
          {isFavorite && (
            <span className="shrink-0 text-[10px] text-pink-400" aria-hidden>
              ★
            </span>
          )}
        </span>
        <span className="block truncate text-[10px] text-neutral-500">
          {preset.prompt}
        </span>
      </span>
    </button>
  );
}
