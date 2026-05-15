import {
  focusToImageStyle,
  type Preset,
} from "../lib/store/presets";

export type PresetCardProps = {
  preset: Preset;
  onEdit: () => void;
  onRemove: () => void;
  /** お気に入り toggle。 */
  onToggleFavorite?: () => void;
};

/**
 * 一覧表示用カード。
 * focal point の調整は編集モーダル内で完結させる方針に統一したため、
 * カード上の ⊕ ボタンと FocalEditor は廃止した（編集モーダル側でやる）。
 */
export function PresetCard({
  preset,
  onEdit,
  onRemove,
  onToggleFavorite,
}: PresetCardProps) {
  const tags = preset.tags ?? [];
  const visibleTags = tags.slice(0, 3);
  const hiddenTagCount = Math.max(0, tags.length - visibleTags.length);
  const isFavorite = !!preset.favorite;
  const style = focusToImageStyle(preset.thumbnailFocus);

  return (
    <div
      className="group relative flex aspect-[3/4] flex-col overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#101010] transition hover:border-pink-400"
      data-preset-id={preset.id}
    >
      {/* 左上: お気に入り（pink テーマ）。 */}
      {onToggleFavorite && (
        <button
          type="button"
          onClick={onToggleFavorite}
          className={[
            "absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full text-sm leading-none shadow-lg transition",
            isFavorite
              ? "bg-pink-500 text-white opacity-100 hover:bg-pink-400"
              : "bg-black/75 text-neutral-300 opacity-0 hover:bg-pink-500 hover:text-white group-hover:opacity-100",
          ].join(" ")}
          title={isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
        >
          {isFavorite ? "★" : "☆"}
        </button>
      )}
      {/* 右上: 編集 / 削除のみ。サムネ位置調整は編集モーダル側に集約。 */}
      <div className="absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={onEdit}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-xs text-neutral-300 hover:bg-pink-500 hover:text-white"
          title="編集"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-black/75 text-xs text-neutral-300 hover:bg-red-500 hover:text-white"
          title="削除"
        >
          ×
        </button>
      </div>

      <div className="relative aspect-[16/9] w-full overflow-hidden bg-[#1b1b1b]">
        {preset.thumbnail ? (
          <img
            src={preset.thumbnail}
            alt=""
            className="h-full w-full object-cover"
            style={style}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#242424_0%,#171717_100%)] text-[10px] font-bold uppercase tracking-wide text-neutral-600">
            No Thumbnail
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5">
        <div className="min-h-0 flex-1 space-y-1">
          <h5 className="truncate text-[12px] font-black leading-tight text-neutral-100">
            {preset.name}
          </h5>
          <p className="line-clamp-2 font-mono text-[10px] leading-snug text-neutral-400">
            {preset.prompt}
          </p>
        </div>

        {(preset.description || tags.length > 0) && (
          <div className="space-y-1 border-t border-[#242424] pt-1.5">
            {preset.description && (
              <p className="line-clamp-1 text-[10px] text-neutral-500">
                {preset.description}
              </p>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 overflow-hidden">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="max-w-[72px] truncate rounded-full bg-[#1f1f1f] px-1.5 py-0.5 text-[9px] font-bold text-neutral-300"
                    title={tag}
                  >
                    #{tag}
                  </span>
                ))}
                {hiddenTagCount > 0 && (
                  <span className="rounded-full bg-[#2a2a2a] px-1.5 py-0.5 text-[9px] font-bold text-neutral-400">
                    +{hiddenTagCount}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
