import { useEffect, useRef, useState } from "react";

import { SafeImage } from "../../SafeImage";
import type {
  ComicPageResult,
  ComicReadingDirection,
  ComicStoryPage,
} from "../../../lib/comic/types";

/**
 * ページ番号を「見開き（最大2ページ）」の列に組み立てる。読み方向には依存しない
 * （左右の並べ替えは表示側が flex-row-reverse で行う）。
 *
 * 右綴じ・左綴じ共通の本の規則:
 *  - 1ページ目は常に単独（表紙側の片面）
 *  - 以降 2-3 / 4-5 … のペア
 *  - 端数（偶数ページで終わる本）の最終ページも単独
 *
 * 例:
 *   1 → [[1]]
 *   4 → [[1], [2,3], [4]]
 *   5 → [[1], [2,3], [4,5]]
 *   6 → [[1], [2,3], [4,5], [6]]
 */
export function buildSpreads(pageCount: number): number[][] {
  if (pageCount <= 0) return [];
  const spreads: number[][] = [[1]];
  for (let page = 2; page <= pageCount; page += 2) {
    spreads.push(page + 1 <= pageCount ? [page, page + 1] : [page]);
  }
  return spreads;
}

export type ComicSpreadPreviewModalProps = {
  /** ページ番号・総数の源。 */
  pages: ComicStoryPage[];
  /** 画像 / 生成中 / 失敗の状態。開いたまま更新されると自動で画像に置き換わる。 */
  results: ComicPageResult[];
  /** 綴じ方向。本として1つ（ページ個別の direction は見ない）。 */
  direction: ComicReadingDirection;
  onClose: () => void;
};

/**
 * 漫画ページの Kindle 風・全画面見開きプレビュー（読み取り専用）。
 *
 * 送りは見開き単位で、キーとクリックゾーンの物理方向は「視覚上ページが読み進む
 * 方向」に一致させる（rtl は左へ読み進むので左＝次）。端ではループしない
 * （本は巻末から巻頭へ飛ばない）。
 */
export function ComicSpreadPreviewModal({
  pages,
  results,
  direction,
  onClose,
}: ComicSpreadPreviewModalProps) {
  const [spreadIndex, setSpreadIndex] = useState(0);
  const [zoom, setZoom] = useState(100);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const pageCount = pages.length;
  const spreads = buildSpreads(pageCount);
  // ページ数が減る方向に props が変わっても範囲外を掴まない。
  const safeIndex = Math.min(spreadIndex, Math.max(spreads.length - 1, 0));
  const spread = spreads[safeIndex] ?? [];
  const rtl = direction === "rtl";
  const zoomed = zoom > 100;

  // 端でループしない。範囲外は何もしないだけ（クラッシュさせない）。
  const goNext = () =>
    setSpreadIndex((prev) => Math.min(prev + 1, spreads.length - 1));
  const goPrev = () => setSpreadIndex((prev) => Math.max(prev - 1, 0));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // テキスト入力中は編集キャレット移動を優先（ImagePreviewModal と同型）。
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) {
        return;
      }
      e.preventDefault();
      // rtl: ← が次（左へ読み進む） / ltr: → が次。
      const forward = rtl ? e.key === "ArrowLeft" : e.key === "ArrowRight";
      if (forward) goNext();
      else goPrev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // goNext/goPrev はクロージャ更新で足りる（依存に入れると毎レンダー張替え）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtl, spreads.length, onClose]);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // 画面左半分 / 右半分のどちらが「次」か。rtl は左が次。
  const leftIsNext = rtl;
  const atFirst = safeIndex === 0;
  const atLast = safeIndex >= spreads.length - 1;
  const label =
    spread.length === 2
      ? `${spread[0]}-${spread[1]} / ${pageCount}ページ`
      : `${spread[0] ?? 0} / ${pageCount}ページ`;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="漫画プレビュー"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs text-neutral-400">
          {rtl ? "右→左（日本式）" : "左→右"}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <span>{zoom}%</span>
            <input
              type="range"
              min={100}
              max={200}
              step={10}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              aria-label="プレビュー拡大率"
              className="h-1 w-24 cursor-pointer accent-pink-500"
            />
          </label>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="プレビューを閉じる"
            className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white"
          >
            ✕ 閉じる
          </button>
        </div>
      </div>

      <div
        className={`relative flex flex-1 px-4 ${
          zoomed
            ? "items-start justify-start overflow-auto"
            : "items-center justify-center overflow-hidden"
        }`}
      >
        <div
          className={`flex shrink-0 items-center justify-center ${
            rtl ? "flex-row-reverse" : "flex-row"
          } ${zoomed ? "m-auto" : "h-full max-h-full"}`}
          style={zoomed ? { height: `${zoom}%` } : undefined}
        >
          {spread.map((pageNumber) => (
            <SpreadPage
              key={pageNumber}
              pageNumber={pageNumber}
              result={results.find((item) => item.page === pageNumber)}
            />
          ))}
        </div>

        {/*
          クリックゾーン。画像の上に透明な左右2分割を重ねる。端では
          cursor-default にして「押しても進まない」ことを見た目でも示す。
        */}
        <button
          type="button"
          onClick={leftIsNext ? goNext : goPrev}
          disabled={leftIsNext ? atLast : atFirst}
          aria-label={leftIsNext ? "次の見開き" : "前の見開き"}
          className="group absolute inset-y-0 left-0 flex w-1/2 items-center justify-start pl-4 disabled:cursor-default"
        >
          <span className="text-3xl text-white/0 transition group-hover:text-white/30 group-disabled:text-white/0">
            ‹
          </span>
        </button>
        <button
          type="button"
          onClick={leftIsNext ? goPrev : goNext}
          disabled={leftIsNext ? atFirst : atLast}
          aria-label={leftIsNext ? "前の見開き" : "次の見開き"}
          className="group absolute inset-y-0 right-0 flex w-1/2 items-center justify-end pr-4 disabled:cursor-default"
        >
          <span className="text-3xl text-white/0 transition group-hover:text-white/30 group-disabled:text-white/0">
            ›
          </span>
        </button>
      </div>

      <div className="flex items-center justify-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={leftIsNext ? goNext : goPrev}
          disabled={leftIsNext ? atLast : atFirst}
          aria-label={leftIsNext ? "次の見開き" : "前の見開き"}
          className="text-xl text-neutral-400 transition hover:text-white disabled:cursor-default disabled:text-neutral-700"
        >
          ‹
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(spreads.length - 1, 0)}
          step={1}
          value={safeIndex}
          onChange={(event) => setSpreadIndex(Number(event.target.value))}
          disabled={spreads.length <= 1}
          aria-label="見開きページを移動"
          className="h-1 w-40 cursor-pointer accent-pink-500 disabled:cursor-default"
        />
        <button
          type="button"
          onClick={leftIsNext ? goPrev : goNext}
          disabled={leftIsNext ? atFirst : atLast}
          aria-label={leftIsNext ? "前の見開き" : "次の見開き"}
          className="text-xl text-neutral-400 transition hover:text-white disabled:cursor-default disabled:text-neutral-700"
        >
          ›
        </button>
        <span className="text-xs font-medium text-neutral-300">{label}</span>
      </div>
    </div>
  );
}

/**
 * 見開き内の1ページ。未生成/生成中/失敗もページカードと同じ語彙で 3:4 の枠を
 * 保って描く（詰めるとペア構造とページ番号の対応が壊れるため）。
 */
function SpreadPage({
  pageNumber,
  result,
}: {
  pageNumber: number;
  result?: ComicPageResult;
}) {
  return (
    <div className="flex aspect-[3/4] h-full max-h-full items-center justify-center overflow-hidden bg-[#0f0f0f]">
      {result?.generating ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-pink-300 border-t-transparent" />
          <span className="text-[12px] font-bold text-pink-300">生成中…</span>
        </div>
      ) : result?.imagePath ? (
        <SafeImage
          path={result.imagePath}
          alt={`ページ ${pageNumber}`}
          className="h-full w-full object-contain"
        />
      ) : result?.error ? (
        <span className="px-1 text-center text-[11px] text-rose-400">失敗</span>
      ) : (
        <span className="text-[11px] text-neutral-600">未生成</span>
      )}
    </div>
  );
}
