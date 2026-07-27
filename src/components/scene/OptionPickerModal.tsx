import { useEffect, useRef, useState } from "react";
import {
  COMPOSITION_GROUP_LABELS,
  type CompositionGroup,
  type SceneOption,
} from "../../lib/scene/catalog";
import { CinePlaceholder } from "./CinePlaceholder";

type Props = {
  open: boolean;
  title: string;
  options: SceneOption[];
  selectedValue: string;
  onPick: (value: string) => void;
  onClose: () => void;
};

/**
 * Full-screen modal for picking a SceneOption from a grid of large
 * thumbnail cards. Modeled after RenderZero / Magnific style pickers.
 * If `option.thumbnail` is set, shows the image. Otherwise shows a
 * placeholder cinematic gradient with the label centered.
 */
export function OptionPickerModal({
  open,
  title,
  options,
  selectedValue,
  onPick,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filtered =
    filter.trim().length === 0
      ? options
      : options.filter((option) => {
          const target = `${option.value} ${option.hint ?? ""}`.toLowerCase();
          return target.includes(filter.trim().toLowerCase());
        });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {/*
        STΛCK 指示 (2026-05-19): 外側 overflow-y-auto を外して内側スクロールに
        一本化。旧版は二重スクロール構造でヘッダ・フィルター・本体が一緒に
        縦スクロールされ、画面外に見切れる現象が発生していた。
      */}
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#262626] px-6 py-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">
              Select
            </p>
            <h2 className="text-lg font-black text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#343434] bg-[#181818] px-3 py-1.5 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            ✕ 閉じる
          </button>
        </div>

        <div className="border-b border-[#262626] px-6 py-3">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="フィルター…"
            className="w-full rounded-md border border-[#343434] bg-[#181818] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-pink-500"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {filtered.length === 0 ? (
            <p className="text-center text-sm text-neutral-500">
              該当する選択肢はありません
            </p>
          ) : (
            /*
              2026-07-27: group を持つ選択肢 (構図) は役割ごとに見出しで束ねる。
              「どこに何を入れればいいか分からない」という指摘への対応で、
              どこまで写す / どこから撮る / どう見せる の3つに分けて示す。
              group を持たない一覧 (スタイル等) は従来どおり素のグリッド。
            */
            <div className="space-y-6">
              {groupOptions(filtered).map(({ key, title: groupTitle, hint, items }) => (
                <div key={key}>
                  {groupTitle ? (
                    <div className="mb-2 flex items-baseline gap-2">
                      <h3 className="text-sm font-black text-neutral-200">{groupTitle}</h3>
                      <span className="text-[11px] text-neutral-500">{hint}</span>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {items.map((option) => (
                      <PickerCard
                        key={option.value}
                        option={option}
                        selected={option.value === selectedValue}
                        onSelect={() => {
                          onPick(option.value);
                          onClose();
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 選択肢を役割グループごとに束ねる。
 *
 * group を持たない一覧 (スタイル・ライティング等) は1つの無名グループにまとめ、
 * 見出しを出さずに従来どおり素のグリッドで描く。
 * group 付き (構図) は distance → angle → framing の順に見出し付きで並べる。
 * 「指定なし」(group 無し) は先頭の無名グループとして必ず最初に出す。
 */
function groupOptions(options: SceneOption[]): Array<{
  key: string;
  title: string | null;
  hint: string;
  items: SceneOption[];
}> {
  const hasGroups = options.some((o) => o.group);
  if (!hasGroups) {
    return [{ key: "all", title: null, hint: "", items: options }];
  }

  const order: CompositionGroup[] = ["distance", "angle", "framing"];
  const out: Array<{ key: string; title: string | null; hint: string; items: SceneOption[] }> = [];

  const ungrouped = options.filter((o) => !o.group);
  if (ungrouped.length > 0) {
    out.push({ key: "_none", title: null, hint: "", items: ungrouped });
  }
  for (const g of order) {
    const items = options.filter((o) => o.group === g);
    if (items.length === 0) continue;
    const label = COMPOSITION_GROUP_LABELS[g];
    out.push({ key: g, title: label.title, hint: label.hint, items });
  }
  return out;
}

function PickerCard({
  option,
  selected,
  onSelect,
}: {
  option: SceneOption;
  selected: boolean;
  onSelect: () => void;
}) {
  // 動画は最初から「停止フレーム」を表示し、ホバーで再生する。
  // 先頭フレームを確実に描画させるため、メタデータ読込後に currentTime を
  // 僅かに進めて1フレーム目をデコードさせる。
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovering, setHovering] = useState(false);

  const showFirstFrame = () => {
    const el = videoRef.current;
    if (el && el.currentTime === 0) {
      // 0.001 でも進めると先頭フレームが描画される (黒画面防止)
      el.currentTime = 0.001;
    }
  };

  const handleEnter = () => {
    if (!option.video) return;
    setHovering(true);
    const el = videoRef.current;
    if (el) {
      void el.play().catch(() => {
        // 自動再生がブロックされた場合は静かに無視
      });
    }
  };

  const handleLeave = () => {
    setHovering(false);
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0.001; // 先頭フレームに戻す
    }
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={[
        "group relative flex flex-col overflow-hidden rounded-lg border-2 text-left transition",
        selected
          ? "border-pink-400 bg-[#1a1a1a] shadow-lg"
          : "border-[#262626] bg-[#181818] hover:border-pink-500/50",
      ].join(" ")}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-gradient-to-br from-neutral-700 to-neutral-900">
        {option.video ? (
          <>
            {/*
              STΛCK 指示 (2026-05-29): 動画は最初から「停止フレーム」を常時表示し、
              ホバーで再生する。preload="metadata" で先頭フレームだけ読み込み、
              ホバー前は play しないので一覧でも軽い。
            */}
            <video
              ref={videoRef}
              src={option.video}
              muted
              loop
              playsInline
              preload="metadata"
              onLoadedMetadata={showFirstFrame}
              className="absolute inset-0 h-full w-full object-cover"
            />
            {/* 動画ありを示す再生バッジ (ホバー前のヒント、再生中は消す) */}
            <span
              className={[
                "pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white transition-opacity",
                hovering ? "opacity-0" : "opacity-100",
              ].join(" ")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="inline-block">
                <path d="M8 5l11 7-11 7V5z" />
              </svg>{" "}
              ホバーで再生
            </span>
          </>
        ) : option.thumbnail ? (
          <img
            src={option.thumbnail.src}
            alt={option.thumbnail.alt}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <PlaceholderArt label={option.value} />
        )}
      </div>
      <div className="border-t border-[#262626] p-3">
        <div className="text-base font-bold text-white">{option.value}</div>
        {option.hint && (
          <div className="mt-1 text-sm text-neutral-300">{option.hint}</div>
        )}
      </div>
      {selected && (
        <span className="absolute right-2 top-2 rounded-full bg-pink-500 px-2 py-0.5 text-[10px] font-bold text-white">
          選択中
        </span>
      )}
    </button>
  );
}

function PlaceholderArt({ label }: { label: string }) {
  return <CinePlaceholder label={label} size="lg" />;
}
