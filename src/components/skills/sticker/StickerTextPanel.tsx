/**
 * 工程⑤ 文字入れ（2026-08-05 STΛCK直指示）。
 *
 * ## AIに描かせず、エンジンで描く
 *
 * 生成プロンプトは `NO_TEXT_CLAUSE` で文字を禁じたままにする（設計書 §1.3。
 * 審査NG「テキストのみ画像」と日本語崩れの実測）。文字は**抜いたあとの透過PNGへ
 * Canvas 2D で焼く**（`lib/sticker/text.ts`）。決定論なので崩れない。
 *
 * ## フォントは同梱しない
 *
 * 編集タブと同じ `FontPicker` をそのまま使う。中身は `editFonts.list`
 * （Rust の `edit_fonts_list`）が返す**システムにインストール済みのフォント**。
 * 同梱すると配布サイズが増えるうえ、ライセンスの判断が要る。
 *
 * ## 一等地にボタンを増やさない（UI配置文法）
 *
 * 採否一覧のタイルには「使う / 直す」しか置かない。文字入れは
 * **採否のあとの1セクション**として置き、開いている間だけ操作面が出る。
 */
import { useEffect, useMemo, useState } from "react";

import { FontPicker } from "../../edit/FontPicker";
import { SafeImage } from "../../SafeImage";
import {
  DEFAULT_STICKER_TEXT,
  STICKER_TEXT_SIZE_RATIOS,
  type StickerTextPosition,
  type StickerTextSizeId,
  type StickerTextSpec,
} from "../../../lib/sticker/text";
import type { StickerPickItem } from "./StickerPickPanel";

/** 1枚に入れる文字（未入力なら文字を焼かない）。 */
export type StickerTextEntry = {
  text: string;
  spec: Omit<StickerTextSpec, "text">;
};

type Props = {
  items: StickerPickItem[];
  /** index → 入力中の文字。空文字・未登録は「入れない」。 */
  texts: Readonly<Record<number, string>>;
  onText: (index: number, text: string) => void;
  /** 全カット共通の見た目（フォント・色・大きさ・位置・フチ）。 */
  style: Omit<StickerTextSpec, "text">;
  onStyle: (style: Omit<StickerTextSpec, "text">) => void;
  /** 入力した文字を焼き込む。焼き込み後の画像が採否リストの正本になる。 */
  onApply: () => void;
  /** 焼き込みを取り消して文字なしへ戻す。 */
  onReset: () => void;
  busy: boolean;
  /** 1枚でも文字を焼き込んだ状態か（「元に戻す」を出す条件）。 */
  applied: boolean;
};

const SIZE_LABELS: { id: StickerTextSizeId; label: string }[] = [
  { id: "small", label: "小" },
  { id: "medium", label: "中" },
  { id: "large", label: "大" },
];

const POSITION_LABELS: { id: StickerTextPosition; label: string }[] = [
  { id: "top", label: "上" },
  { id: "bottom", label: "下" },
];

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
  /**
   * 全カットに同じ文字を入れるための入力欄（量産用）。
   *
   * 40枚に1枚ずつ打つのは現実的でない一方、スタンプは「ありがとう」「OK」など
   * カットごとに違う言葉を入れるのが普通。**両方置く** — 一括は下書きとして
   * 流し込み、あとから1枚ずつ直せるようにする（上書きしたあとも個別欄は生きる）。
   */
  const [bulk, setBulk] = useState("");

  const filledCount = useMemo(
    () => items.filter((i) => (texts[i.index] ?? "").trim().length > 0).length,
    [items, texts],
  );

  const currentSizeId = useMemo<StickerTextSizeId>(() => {
    const found = SIZE_LABELS.find(
      (s) => STICKER_TEXT_SIZE_RATIOS[s.id] === style.sizeRatio,
    );
    return found?.id ?? "medium";
  }, [style.sizeRatio]);

  return (
    <section className="rounded-lg border border-[#2a2a2a] bg-[#141414] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[12px] font-black text-neutral-200">文字を入れる</h3>
        <span className="text-[11px] text-neutral-500">
          入れたい言葉だけ書いてください（空のカットには入りません）
        </span>
        <span className="ml-auto text-[11px] text-neutral-400">
          {filledCount} / {items.length} 枚
        </span>
      </div>

      {/* 見た目の設定は全カット共通。1枚ずつ変えられるようにすると設定が40組になる。 */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <FontPicker
            value={style.fontFamily}
            onChange={(fontFamily) => onStyle({ ...style, fontFamily })}
            languageHint="ja"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-16 text-[11px] text-neutral-500">大きさ</span>
            <div className="flex gap-1">
              {SIZE_LABELS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    onStyle({ ...style, sizeRatio: STICKER_TEXT_SIZE_RATIOS[s.id] })
                  }
                  className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                    currentSizeId === s.id
                      ? "bg-[#2a2a2a] text-neutral-100"
                      : "border border-[#2f2f2f] text-neutral-500 hover:bg-[#1a1a1a]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-16 text-[11px] text-neutral-500">位置</span>
            <div className="flex gap-1">
              {POSITION_LABELS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onStyle({ ...style, position: p.id })}
                  className={`rounded px-2.5 py-1 text-[11px] font-bold transition ${
                    style.position === p.id
                      ? "bg-[#2a2a2a] text-neutral-100"
                      : "border border-[#2f2f2f] text-neutral-500 hover:bg-[#1a1a1a]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-16 text-[11px] text-neutral-500">文字の色</span>
            <input
              type="color"
              value={style.color}
              onChange={(e) => onStyle({ ...style, color: e.target.value })}
              className="h-7 w-12 cursor-pointer rounded border border-[#2f2f2f] bg-[#0e0e0e]"
            />
            {/*
              白フチは既定ON。透過PNGの上に乗るので、トーク画面の背景（白・黒・写真）
              次第で文字が消える。これは実務標準であって好みではない。
            */}
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              <input
                type="checkbox"
                checked={style.outline}
                onChange={(e) => onStyle({ ...style, outline: e.target.checked })}
                className="accent-pink-500"
              />
              フチをつける
            </label>
            {style.outline && (
              <input
                type="color"
                value={style.outlineColor}
                onChange={(e) => onStyle({ ...style, outlineColor: e.target.value })}
                title="フチの色"
                className="h-7 w-12 cursor-pointer rounded border border-[#2f2f2f] bg-[#0e0e0e]"
              />
            )}
          </div>
        </div>
      </div>

      {/* 量産用の一括入力。流し込んだあとも1枚ずつ直せる。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          disabled={busy}
          placeholder="全部に同じ言葉を入れる（例: ありがとう）"
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
          全部に入れる
        </button>
      </div>

      {/* 1枚ずつの入力。絵を見ながら言葉を決められるよう、サムネと並べる。 */}
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
        {items.map((item) => (
          <li
            key={item.index}
            className="flex items-center gap-2 rounded border border-[#242424] bg-[#101010] p-2"
          >
            <SafeImage
              path={item.imagePath}
              alt={item.label}
              className="h-10 w-10 shrink-0 bg-[#0d0d0d] object-contain"
            />
            <input
              type="text"
              value={texts[item.index] ?? ""}
              onChange={(e) => onText(item.index, e.target.value)}
              disabled={busy}
              placeholder={item.label}
              className="min-w-0 flex-1 rounded border border-[#2f2f2f] bg-[#0e0e0e] px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-[#3f3f3f] focus:outline-none disabled:opacity-40"
            />
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={busy || filledCount === 0}
          className="rounded bg-[#2a2a2a] px-4 py-2 text-[12px] font-bold text-neutral-100 transition hover:bg-[#333] disabled:opacity-40"
        >
          {busy ? "入れています…" : `${filledCount} 枚に文字を入れる`}
        </button>
        {/*
          焼き直せることが要件（「後から直せる」）。元画像を保持しているので、
          文字を変えて押し直せば常に**文字なしの状態から**焼き直される。
        */}
        {applied && (
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="rounded border border-[#2f2f2f] px-3 py-1.5 text-[11px] text-neutral-400 transition hover:bg-[#1e1e1e] disabled:opacity-40"
          >
            文字を消す（元に戻す）
          </button>
        )}
        <span className="text-[11px] text-neutral-500">
          入れ直すときは、文字を書き換えてもう一度押してください。
        </span>
      </div>
    </section>
  );
}

/** 既定の見た目。呼び出し側の初期値に使う。 */
export function defaultStickerTextStyle(): Omit<StickerTextSpec, "text"> {
  return { ...DEFAULT_STICKER_TEXT };
}

/** 未使用の import を避けるための再エクスポート（呼び出し側が型を使う）。 */
export type { StickerTextSpec };

/** 入力欄の初期化に使う（`useEffect` 依存で使い回す）。 */
export function useResetTextsOnItemsChange(
  items: StickerPickItem[],
  reset: () => void,
) {
  const key = items.map((i) => i.index).join(",");
  useEffect(() => {
    reset();
    // reset は呼び出し側で `useCallback` 済みの前提。key が変わったときだけ走らせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
