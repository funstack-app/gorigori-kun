import { useEffect, useMemo, useRef, useState } from "react";

import type { AssetLedgerEntry, AssetLedgerType } from "../lib/ipc";
import { useAssetLedger } from "../lib/store/assetLedger";
import { useComposer, type ReferenceRole } from "../lib/store/composer";
import {
  focusToImageStyle,
  presetKind,
  usePresets,
  type Preset,
  type PresetCategory,
} from "../lib/store/presets";
import { SafeImage } from "./SafeImage";
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

export type PresetPickerSection = "asset" | "prompt";
export type PresetPickerAssetType = Extract<
  AssetLedgerType,
  "character" | "scene" | "look" | "prop"
>;

const ASSET_TYPES: Array<{ type: PresetPickerAssetType; label: string }> = [
  { type: "character", label: "キャラ" },
  { type: "scene", label: "シーン" },
  { type: "look", label: "ルック" },
  { type: "prop", label: "小物" },
];

const VIDEO_PATH_PATTERN = /\.(?:mp4|mov|m4v|webm|avi|mkv)(?:[?#].*)?$/i;

/** 区分を替えたとき、前の区分の検索語を持ち越さない。 */
export function changePresetPickerSection(next: PresetPickerSection): {
  section: PresetPickerSection;
  query: string;
} {
  return { section: next, query: "" };
}

/** 台帳全体と表示中の種類を区別し、空欄のままにしない。 */
export function getAssetPickerEmptyMessage(
  totalCount: number,
  visibleCount: number,
  query: string,
): string | null {
  if (totalCount === 0) {
    return "アセットはまだありません。プリセット画面やライブラリから登録できます";
  }
  if (visibleCount > 0) return null;
  return query.trim()
    ? "検索条件に一致するアセットがありません"
    : "この種類のアセットはまだありません";
}

function assetReferenceRole(type: AssetLedgerType): ReferenceRole {
  if (type === "scene") return "background";
  if (type === "look") return "look";
  if (type === "prop") return "product";
  return "subject";
}

function assetMediaPaths(asset: AssetLedgerEntry): string[] {
  return Array.from(
    new Set(
      [asset.primaryImagePath, ...asset.imagePaths]
        .map((path) => path?.trim())
        .filter((path): path is string => Boolean(path)),
    ),
  );
}

function assetReferenceImagePaths(asset: AssetLedgerEntry): string[] {
  return assetMediaPaths(asset).filter((path) => !VIDEO_PATH_PATTERN.test(path));
}

function assetUnavailableReason(asset: AssetLedgerEntry): string | null {
  const mediaPaths = assetMediaPaths(asset);
  if (mediaPaths.some((path) => !VIDEO_PATH_PATTERN.test(path))) return null;
  return mediaPaths.some((path) => VIDEO_PATH_PATTERN.test(path))
    ? "動画は参照画像として添付できません"
    : "参照に使える画像がありません";
}

function matchesAssetQuery(asset: AssetLedgerEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return `${asset.name} ${asset.prompt} ${asset.tags.join(" ")} ${assetMediaPaths(asset).join(" ")}`
    .toLowerCase()
    .includes(normalizedQuery);
}

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
  const assets = useAssetLedger((s) => s.assets);
  const assetLoading = useAssetLedger((s) => s.loading);
  const assetLoaded = useAssetLedger((s) => s.loaded);
  const assetError = useAssetLedger((s) => s.error);
  const loadAssetLedger = useAssetLedger((s) => s.load);
  const assetLoadStarted = useRef(false);
  const [activeSection, setActiveSection] =
    useState<PresetPickerSection>("asset");
  const [activeAssetType, setActiveAssetType] =
    useState<PresetPickerAssetType>("character");
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
    if (!open) {
      assetLoadStarted.current = false;
      return;
    }
    if (assetLoadStarted.current || assetLoaded || assetLoading) return;
    assetLoadStarted.current = true;
    void loadAssetLedger().catch(() => {
      // 読み込みエラーはアセット区分内で表示する。
    });
  }, [open, assetLoaded, assetLoading, loadAssetLedger]);

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

  const visibleAssets = useMemo(
    () =>
      assets
        .filter((asset) => asset.type === activeAssetType)
        .filter((asset) => matchesAssetQuery(asset, query))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [activeAssetType, assets, query],
  );

  const assetTypeCounts = useMemo(() => {
    const countsByType = new Map<PresetPickerAssetType, number>();
    for (const item of ASSET_TYPES) countsByType.set(item.type, 0);
    for (const asset of assets) {
      const type = asset.type as PresetPickerAssetType;
      if (!countsByType.has(type) || !matchesAssetQuery(asset, query)) continue;
      countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
    }
    return countsByType;
  }, [assets, query]);

  const handleSectionChange = (next: PresetPickerSection) => {
    const state = changePresetPickerSection(next);
    setActiveSection(state.section);
    setQuery(state.query);
  };

  const attachAssetReference = (asset: AssetLedgerEntry) => {
    const paths = assetReferenceImagePaths(asset);
    if (paths.length === 0) return;
    useComposer.getState().addReferences(
      paths.map((path, index) => ({
        path,
        name: index === 0 ? asset.name : `${asset.name} ${index + 1}`,
        source: "gallery" as const,
        role: assetReferenceRole(asset.type),
        ...(paths.length > 1
          ? { groupId: `asset:${asset.id}`, groupLabel: asset.name }
          : {}),
      })),
    );
    onClose();
  };

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
  const assetEmptyMessage = getAssetPickerEmptyMessage(
    assets.length,
    visibleAssets.length,
    query,
  );

  return (
    <div
      ref={containerRef}
      style={{ ...style, width: 360 }}
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[#242424] px-3 py-2">
        <h3 className="text-xs font-black text-white">
          {activeSection === "asset" ? "アセット" : "プリセット"}
        </h3>
        <span className="text-[10px] font-medium text-neutral-500">
          {activeSection === "asset"
            ? `${visibleAssets.length} / ${assets.length} 件`
            : activeFilter === null && !query
              ? `${totalCount} 件`
              : `${visibleCount} / ${totalCount} 件`}
        </span>
      </div>
      <div className="shrink-0 space-y-2 border-b border-[#242424] p-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          <CategoryChip
            label="アセット"
            count={assets.length}
            color="#f472b6"
            active={activeSection === "asset"}
            onClick={() => handleSectionChange("asset")}
          />
          <CategoryChip
            label="プロンプト"
            count={presets.length}
            color="#737373"
            active={activeSection === "prompt"}
            onClick={() => handleSectionChange("prompt")}
          />
        </div>
        <input
          type="search"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            activeSection === "asset"
              ? "検索（名前 / 画像名 / メモ）"
              : "検索（名前 / 本文 / メモ / #タグ）"
          }
          className="h-8 w-full rounded-md border border-[#343434] bg-[#101010] px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
        />
        {activeSection === "prompt" && tagSuggestions.length > 0 && (
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
        {activeSection === "asset" ? (
          <div className="flex items-center gap-1 overflow-x-auto pb-2">
            {ASSET_TYPES.map((item) => (
              <CategoryChip
                key={item.type}
                label={item.label}
                count={assetTypeCounts.get(item.type) ?? 0}
                color="#f472b6"
                active={activeAssetType === item.type}
                onClick={() => setActiveAssetType(item.type)}
              />
            ))}
          </div>
        ) : (
          /* カテゴリチップ。お気に入りを最左、その右にすべて、カテゴリ、未分類。
             横スクロールでカテゴリが多くても収まる。 */
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
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {activeSection === "asset" ? (
          assetLoading || (!assetLoaded && !assetError) ? (
            <p className="px-3 py-6 text-center text-[11px] text-neutral-500">
              アセットを読み込んでいます
            </p>
          ) : assetError && !assetLoaded ? (
            <p className="px-3 py-6 text-center text-[11px] text-amber-300">
              アセットを読み込めませんでした
            </p>
          ) : assetEmptyMessage ? (
            <p className="px-3 py-6 text-center text-[11px] text-neutral-500">
              {assetEmptyMessage}
            </p>
          ) : (
            <div className="space-y-1">
              {visibleAssets.map((asset) => (
                <AssetPickerRow
                  key={asset.id}
                  asset={asset}
                  onPick={() => attachAssetReference(asset)}
                />
              ))}
            </div>
          )
        ) : totalCount === 0 ? (
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

/** アセットの1行。選択時は画像だけを制作欄へ渡し、指示文は使わない。 */
function AssetPickerRow({
  asset,
  onPick,
}: {
  asset: AssetLedgerEntry;
  onPick: () => void;
}) {
  const imagePaths = assetReferenceImagePaths(asset);
  const unavailableReason = assetUnavailableReason(asset);
  const previewPath = imagePaths[0] ?? null;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={Boolean(unavailableReason)}
      title={unavailableReason ?? `${asset.name}の画像を参照に追加`}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-[#1f1f1f] disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
    >
      <span className="relative aspect-[16/9] h-10 shrink-0 overflow-hidden rounded-md border border-[#242424] bg-[#0d0d0d]">
        {previewPath ? (
          <SafeImage
            path={previewPath}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[8px] font-bold text-neutral-600">
            {assetMediaPaths(asset).length > 0 ? "動画" : "画像なし"}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold">{asset.name}</span>
        <span
          className={[
            "block truncate text-[10px]",
            unavailableReason ? "text-amber-400/80" : "text-neutral-500",
          ].join(" ")}
        >
          {unavailableReason ?? `参照画像 ${imagePaths.length}枚`}
        </span>
      </span>
    </button>
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
