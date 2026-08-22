/**
 * 切り抜き後のスタンプへ、文字と装飾をまとめてあと入れする画面。
 * 操作順は「①見た目 → ②言葉 → ③適用」に固定し、初めてでも上から進められる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { editFonts } from "../../../lib/ipc";
import {
  DEFAULT_STICKER_TEXT,
  defaultColorsForStickerTextStyle,
  STICKER_TEXT_SIZE_RATIOS,
  STICKER_TEXT_STYLE_PRESETS,
  type StickerTextPosition,
  type StickerTextSizeId,
  type StickerTextSpec,
  type StickerTextStyleId,
} from "../../../lib/sticker/text";
import { SafeImage } from "../../SafeImage";
import type { StickerPickItem } from "./StickerPickPanel";

/** 1枚に入れる文字（未入力なら文字を焼かない）。 */
export type StickerTextEntry = {
  text: string;
  spec: Omit<StickerTextSpec, "text">;
};

type Props = {
  items: StickerPickItem[];
  texts: Readonly<Record<number, string>>;
  onText: (index: number, text: string) => void;
  style: Omit<StickerTextSpec, "text">;
  onStyle: (style: Omit<StickerTextSpec, "text">) => void;
  onApply: () => void;
  onReset: () => void;
  busy: boolean;
  applied: boolean;
};

type FontOption = { family: string; displayName: string };
type FontLoadStatus = "loading" | "ready" | "failed";

const SYSTEM_FONT: FontOption = {
  family: "system-ui",
  displayName: "標準フォント",
};
const FONT_LOAD_TIMEOUT_MS = 5_000;

const SIZE_LABELS: { id: StickerTextSizeId; label: string }[] = [
  { id: "small", label: "小" },
  { id: "medium", label: "中" },
  { id: "large", label: "大" },
];

const POSITION_LABELS: { id: StickerTextPosition; label: string }[] = [
  { id: "top", label: "上" },
  { id: "bottom", label: "下" },
];

async function listFontsWithTimeout(): Promise<FontOption[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fonts = await Promise.race([
      editFonts.list("ja"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("font list timeout")),
          FONT_LOAD_TIMEOUT_MS,
        );
      }),
    ]);
    const unique = new Map<string, FontOption>();
    unique.set(SYSTEM_FONT.family, SYSTEM_FONT);
    for (const font of fonts) {
      if (!unique.has(font.family)) {
        unique.set(font.family, {
          family: font.family,
          displayName: font.displayName || font.family,
        });
      }
    }
    return Array.from(unique.values());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function StylePreview({
  styleId,
  selected,
}: {
  styleId: StickerTextStyleId;
  selected: boolean;
}) {
  const edge = selected ? "#f472b6" : "#555555";
  return (
    <svg viewBox="0 0 76 38" aria-hidden="true" className="h-10 w-full">
      {styleId === "roundBubble" && (
        <ellipse cx="38" cy="19" rx="28" ry="14" fill="#ffffff" stroke={edge} strokeWidth="2" />
      )}
      {styleId === "roundedBubble" && (
        <rect x="8" y="6" width="60" height="26" rx="7" fill="#ffffff" stroke={edge} strokeWidth="2" />
      )}
      {styleId === "shoutBubble" && (
        <path
          d="M38 2 44 8 54 4 56 12 69 13 63 20 70 27 57 27 54 35 44 30 38 36 32 30 22 35 19 27 6 27 13 20 7 13 20 12 22 4 32 8Z"
          fill="#ffffff"
          stroke={edge}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}
      {styleId === "captionBand" && (
        <rect x="4" y="9" width="68" height="24" fill="#ffffff" stroke={edge} strokeWidth="2" />
      )}
      <text
        x="38"
        y="25"
        textAnchor="middle"
        fontSize="16"
        fontWeight="900"
        fill="#222222"
        stroke={styleId === "outline" ? "#ffffff" : "none"}
        strokeWidth={styleId === "outline" ? "4" : "0"}
        paintOrder="stroke fill"
      >
        Aa
      </text>
    </svg>
  );
}

export function StickerTextPanel({
  items,
  texts,
  onText,
  style,
  onStyle,
  onApply,
  onReset,
  busy,
  applied,
}: Props) {
  const [bulk, setBulk] = useState("");
  const [fonts, setFonts] = useState<FontOption[]>([SYSTEM_FONT]);
  const [fontStatus, setFontStatus] = useState<FontLoadStatus>("loading");
  const fontRequestId = useRef(0);
  const styleRef = useRef(style);

  useEffect(() => {
    styleRef.current = style;
  }, [style]);

  const reloadFonts = useCallback(async () => {
    const requestId = ++fontRequestId.current;
    setFontStatus("loading");
    try {
      const loaded = await listFontsWithTimeout();
      if (fontRequestId.current !== requestId) return;
      setFonts(loaded);
      setFontStatus("ready");
    } catch {
      if (fontRequestId.current !== requestId) return;
      // 一覧が失敗しても、文字入れそのものは標準フォントですぐ使える。
      const currentFamily = styleRef.current.fontFamily;
      setFonts(
        currentFamily === SYSTEM_FONT.family
          ? [SYSTEM_FONT]
          : [
              SYSTEM_FONT,
              { family: currentFamily, displayName: currentFamily },
            ],
      );
      setFontStatus("failed");
    }
  }, []);

  useEffect(() => {
    void reloadFonts();
    return () => {
      fontRequestId.current += 1;
    };
  }, [reloadFonts]);

  const filledCount = useMemo(
    () => items.filter((item) => (texts[item.index] ?? "").trim().length > 0).length,
    [items, texts],
  );

  const currentSizeId = useMemo<StickerTextSizeId>(() => {
    const found = SIZE_LABELS.find(
      (size) => STICKER_TEXT_SIZE_RATIOS[size.id] === style.sizeRatio,
    );
    return found?.id ?? "medium";
  }, [style.sizeRatio]);

  return (
    <section className="rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[12px] font-black text-neutral-200">文字と吹き出しをあと入れ</h3>
        <span className="text-[11px] text-neutral-500">
          切り抜いた画像はそのまま残るので、何度でも入れ直せます
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-[#292929] bg-[#101010] p-3">
        <h4 className="text-[12px] font-black text-neutral-200">① スタイルを選ぶ</h4>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {STICKER_TEXT_STYLE_PRESETS.map((preset) => {
            const selected = style.styleId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  const colors = defaultColorsForStickerTextStyle(preset.id);
                  onStyle({
                    ...style,
                    ...colors,
                    styleId: preset.id,
                    outline: true,
                  });
                }}
                disabled={busy}
                className={`rounded-lg border p-2 text-left transition disabled:opacity-40 ${
                  selected
                    ? "border-pink-400/70 bg-pink-400/10 text-neutral-100"
                    : "border-[#303030] bg-[#161616] text-neutral-400 hover:bg-[#1d1d1d]"
                }`}
              >
                <StylePreview styleId={preset.id} selected={selected} />
                <span className="mt-1 block text-center text-[10px] font-bold leading-tight">
                  {preset.label}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-neutral-500" htmlFor="sticker-text-font">
              フォント
            </label>
            <select
              id="sticker-text-font"
              value={style.fontFamily}
              onChange={(event) => onStyle({ ...style, fontFamily: event.target.value })}
              disabled={busy}
              className="rounded border border-[#2f2f2f] bg-[#0e0e0e] px-2.5 py-1.5 text-[11px] text-neutral-200 focus:border-[#4a4a4a] focus:outline-none disabled:opacity-40"
            >
              {fonts.map((font) => (
                <option key={font.family} value={font.family}>
                  {font.displayName}
                </option>
              ))}
            </select>
            {fontStatus === "loading" && (
              <span className="text-[10px] text-neutral-500">
                標準フォントは使えます。ほかのフォントを探しています。
              </span>
            )}
            {fontStatus === "failed" && (
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-amber-200/80">
                <span>標準フォントで使えます。</span>
                <button
                  type="button"
                  onClick={() => void reloadFonts()}
                  className="rounded border border-[#3a3a3a] px-2 py-1 text-neutral-300 hover:bg-[#1d1d1d]"
                >
                  フォント一覧を再読み込み
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-14 text-[11px] text-neutral-500">大きさ</span>
              {SIZE_LABELS.map((size) => (
                <button
                  key={size.id}
                  type="button"
                  onClick={() => onStyle({
                    ...style,
                    sizeRatio: STICKER_TEXT_SIZE_RATIOS[size.id],
                  })}
                  className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                    currentSizeId === size.id
                      ? "bg-[#2a2a2a] text-neutral-100"
                      : "border border-[#2f2f2f] text-neutral-500 hover:bg-[#1a1a1a]"
                  }`}
                >
                  {size.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-14 text-[11px] text-neutral-500">位置</span>
              {POSITION_LABELS.map((position) => (
                <button
                  key={position.id}
                  type="button"
                  onClick={() => onStyle({ ...style, position: position.id })}
                  className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                    style.position === position.id
                      ? "bg-[#2a2a2a] text-neutral-100"
                      : "border border-[#2f2f2f] text-neutral-500 hover:bg-[#1a1a1a]"
                  }`}
                >
                  {position.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-4">
          {style.styleId !== "outline" && (
            <label className="flex items-center gap-2 text-[11px] text-neutral-400">
              地色
              <input
                type="color"
                value={style.backgroundColor}
                onChange={(event) => onStyle({ ...style, backgroundColor: event.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-[#2f2f2f] bg-[#0e0e0e]"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-[11px] text-neutral-400">
            文字色
            <input
              type="color"
              value={style.color}
              onChange={(event) => onStyle({ ...style, color: event.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-[#2f2f2f] bg-[#0e0e0e]"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-neutral-400">
            フチ色
            <input
              type="color"
              value={style.outlineColor}
              onChange={(event) => onStyle({ ...style, outlineColor: event.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-[#2f2f2f] bg-[#0e0e0e]"
            />
          </label>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-[#292929] bg-[#101010] p-3">
        <div className="flex flex-wrap items-center gap-3">
          <h4 className="text-[12px] font-black text-neutral-200">② 言葉を入れる</h4>
          <span className="ml-auto text-[11px] text-neutral-400">
            {filledCount} / {items.length} 枚
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={bulk}
            onChange={(event) => setBulk(event.target.value)}
            disabled={busy}
            placeholder="全部に同じ言葉（例: ありがとう）"
            className="min-w-0 flex-1 rounded border border-[#2f2f2f] bg-[#0e0e0e] px-3 py-1.5 text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:border-[#3f3f3f] focus:outline-none disabled:opacity-40"
          />
          <button
            type="button"
            onClick={() => {
              for (const item of items) onText(item.index, bulk);
            }}
            disabled={busy || bulk.trim().length === 0}
            className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-300 transition hover:bg-[#1e1e1e] disabled:opacity-40"
          >
            同じ言葉を全部へ
          </button>
        </div>

        <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          {items.map((item) => (
            <li
              key={item.index}
              className="flex items-center gap-2 rounded border border-[#242424] bg-[#0d0d0d] p-2"
            >
              <SafeImage
                path={item.imagePath}
                alt={item.label}
                className="h-10 w-10 shrink-0 bg-[#0d0d0d] object-contain"
              />
              <input
                type="text"
                value={texts[item.index] ?? ""}
                onChange={(event) => onText(item.index, event.target.value)}
                disabled={busy}
                placeholder={item.label}
                className="min-w-0 flex-1 rounded border border-[#2f2f2f] bg-[#0e0e0e] px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-[#3f3f3f] focus:outline-none disabled:opacity-40"
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 rounded-lg border border-[#292929] bg-[#101010] p-3">
        <h4 className="text-[12px] font-black text-neutral-200">③ 全部に適用</h4>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onApply}
            disabled={busy || (filledCount === 0 && !applied)}
            className="rounded bg-pink-500 px-4 py-2 text-[12px] font-black text-white transition hover:bg-pink-400 disabled:opacity-40"
          >
            {busy ? "適用中…" : "全部に適用"}
          </button>
          {applied && (
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e] disabled:opacity-40"
            >
              文字と装飾をすべて外す
            </button>
          )}
          <span className="text-[11px] text-neutral-500">
            適用後も言葉やスタイルを変えて、もう一度押せます。
          </span>
        </div>
      </div>
    </section>
  );
}

export function defaultStickerTextStyle(): Omit<StickerTextSpec, "text"> {
  return { ...DEFAULT_STICKER_TEXT };
}

export type { StickerTextSpec };

export function useResetTextsOnItemsChange(
  items: StickerPickItem[],
  reset: () => void,
) {
  const key = items.map((item) => item.index).join(",");
  useEffect(() => {
    reset();
    // reset は呼び出し側で useCallback 済みの前提。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
