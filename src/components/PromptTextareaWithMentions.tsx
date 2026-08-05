import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Reference } from "../lib/store/composer";
import { SafeImage } from "./SafeImage";

type CaretPos = { left: number; top: number; lineHeight: number };

/**
 * textarea の caret 位置（px, textarea 左上原点）を測る。
 * mirror div を使う古典手法。textarea のスタイルを写した hidden div に
 * caret 直前までの text を入れて、最後尾の <span> の位置を測る。
 */
function measureCaretPosition(
  textarea: HTMLTextAreaElement,
  index: number,
): CaretPos {
  const style = window.getComputedStyle(textarea);
  const div = document.createElement("div");
  const props = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderStyle",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "MozTabSize",
  ] as const;
  for (const prop of props) {
    div.style[prop as any] = style[prop as any];
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.top = "0";
  div.style.left = "-9999px";

  const before = textarea.value.substring(0, index);
  div.textContent = before;
  const span = document.createElement("span");
  span.textContent = textarea.value.substring(index) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const lineHeight = parseFloat(style.lineHeight || "16") || 16;
  const left = span.offsetLeft - textarea.scrollLeft;
  const top = span.offsetTop - textarea.scrollTop;
  document.body.removeChild(div);
  return { left, top, lineHeight };
}

type Props = {
  value: string;
  onChange: (next: string) => void;
  references: Reference[];
  rows?: number;
  /** true のとき rows を無視して親の高さに合わせて伸ばす（h-full）。
   *  外側の flex-1 ラッパーで縦長領域を取りたい場面で使う。 */
  fullHeight?: boolean;
  placeholder?: string;
  className?: string;
  /** Optional decoration（コピー / リセット等）を textarea 右上に重ねるための slot。 */
  topRightSlot?: React.ReactNode;
};

type Suggestion = {
  index: number; // @img{index}
  label: string; // "img{index}"
  path: string;
  name: string;
};

/**
 * Magnific 風 @ メンション付き textarea。
 *
 * Why: ユーザーが「@」を打ったタイミングで参照ラックの画像候補を
 * suggest する。プロンプト本文中に @img1 のような mention を埋めると
 * バックエンド側（および将来の企画→生成フロー）で参照画像と紐づけやすい。
 *
 * 操作:
 * - @ 入力 + 直前文字が「単語境界」のとき suggest popover を開く
 * - 続けて文字（英数）を打つとフィルタリング
 * - ↑↓ で選択移動、Enter / Tab で確定、Esc で閉じる
 * - 候補をマウスクリックでも確定可
 *
 * 候補の中身は references の登録順で連番（@img1 / @img2 ...）。
 */
export function PromptTextareaWithMentions({
  value,
  onChange,
  references,
  rows = 3,
  fullHeight,
  placeholder,
  className,
  topRightSlot,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{
    /** @ の textarea index (0-based) */
    start: number;
    /** 「@」直後の入力された検索クエリ */
    query: string;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [caret, setCaret] = useState<CaretPos | null>(null);

  // mention 中は @ 位置を実測してパネルをそのすぐ下に出す
  useLayoutEffect(() => {
    if (!mention || !textareaRef.current) {
      setCaret(null);
      return;
    }
    // @ の直後（mention.start + 1）の caret 位置を測る
    setCaret(measureCaretPosition(textareaRef.current, mention.start + 1));
  }, [mention]);

  const allCandidates = useMemo<Suggestion[]>(
    () =>
      references.map((ref, index) => ({
        index: index + 1,
        label: `img${index + 1}`,
        path: ref.path,
        name: ref.name,
      })),
    [references],
  );

  const filtered = useMemo<Suggestion[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    if (!q) return allCandidates;
    return allCandidates.filter((cand) =>
      cand.label.toLowerCase().includes(q) ||
      cand.name.toLowerCase().includes(q),
    );
  }, [mention, allCandidates]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query, mention?.start]);

  /**
   * Caret 位置から、現在開かれている @ メンション開始位置を逆走査で見つける。
   * 直前に空白 / 改行 / 文頭が来るまで戻り、最初に見つかった @ を mention.start とする。
   */
  const detectMention = useCallback(
    (text: string, caret: number) => {
      // caret より前の最後の @ を探す
      for (let i = caret - 1; i >= 0; i -= 1) {
        const ch = text[i];
        if (ch === "@") {
          // @ の直前が単語境界（文頭 or 空白）でなければ無効
          const prev = i === 0 ? " " : text[i - 1];
          if (/\s/.test(prev) || prev === undefined) {
            const query = text.slice(i + 1, caret);
            // クエリに空白が混じったら mention 終了とみなす
            if (/\s/.test(query)) return null;
            return { start: i, query };
          }
          return null;
        }
        if (/\s/.test(ch)) {
          // 空白で打ち切り
          return null;
        }
      }
      return null;
    },
    [],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      onChange(next);
      const caret = event.target.selectionStart ?? next.length;
      setMention(detectMention(next, caret));
    },
    [onChange, detectMention],
  );

  const closeMention = useCallback(() => setMention(null), []);

  const insertMention = useCallback(
    (suggestion: Suggestion) => {
      if (!mention || !textareaRef.current) return;
      const ta = textareaRef.current;
      const caret = ta.selectionStart ?? value.length;
      const before = value.slice(0, mention.start);
      const after = value.slice(caret);
      const inserted = `@${suggestion.label}`;
      const next = `${before}${inserted}${after}`;
      onChange(next);
      // 次のフレームで caret を mention 末尾へ
      requestAnimationFrame(() => {
        const cursor = before.length + inserted.length;
        ta.focus();
        ta.setSelectionRange(cursor, cursor);
      });
      closeMention();
    },
    [mention, value, onChange, closeMention],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mention || filtered.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((idx) => (idx + 1) % filtered.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((idx) => (idx - 1 + filtered.length) % filtered.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        // 候補がある場合だけ補完。候補が空なら通常の改行/タブを通す
        const target = filtered[activeIndex];
        if (target) {
          event.preventDefault();
          insertMention(target);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
      }
    },
    [mention, filtered, activeIndex, insertMention, closeMention],
  );

  return (
    <div className={fullHeight ? "relative flex h-full w-full min-h-0 flex-col" : "relative"}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // クリックで候補確定する余地を残すため少し遅延して閉じる
          setTimeout(closeMention, 120);
        }}
        // fullHeight 指定時は親フレックスで縦に張り出させる。
        // textarea は flex-1 + min-h-0 で親の残り全部を埋める。
        // h-full は flex の縮約計算と競合するので付けない。
        rows={fullHeight ? undefined : rows}
        placeholder={placeholder}
        className={
          fullHeight
            ? `${(className ?? "").replace(/\bh-full\b/g, "")} block min-h-0 flex-1`
            : className
        }
      />
      {topRightSlot && (
        <div className="absolute right-4 top-4 flex items-center gap-1">
          {topRightSlot}
        </div>
      )}
      {mention && filtered.length > 0 && caret && (
        <SuggestionList
          items={filtered}
          activeIndex={activeIndex}
          onPick={insertMention}
          onHover={setActiveIndex}
          caret={caret}
        />
      )}
    </div>
  );
}

/**
 * Magnific の @ サジェストと同じ形:
 * - @ caret のすぐ下に出る小型ポップオーバー
 * - 縦リスト、各行に [円形サムネ] [太字ラベル] [右端アイコン]
 * - 行は rounded-xl のカプセル、ホバー/アクティブで濃く立ち上がる
 */
function SuggestionList({
  items,
  activeIndex,
  onPick,
  onHover,
  caret,
}: {
  items: Suggestion[];
  activeIndex: number;
  onPick: (s: Suggestion) => void;
  onHover: (idx: number) => void;
  caret: CaretPos;
}) {
  const left = Math.max(0, caret.left);
  const top = caret.top + caret.lineHeight + 4;
  return (
    <div
      style={{ left, top, width: 240 }}
      className="absolute z-30 rounded-xl border border-[#2a2a2a] bg-[#141414] p-1 shadow-2xl"
    >
      {items.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <button
            key={item.path}
            type="button"
            title={item.name}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
            onMouseEnter={() => onHover(idx)}
            className={[
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
              active
                ? "bg-[#1f1f1f] text-white"
                : "text-neutral-300 hover:bg-[#1a1a1a]",
            ].join(" ")}
          >
            <SafeImage
              path={item.path}
              alt=""
              className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-[#2a2a2a]"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-bold">
              {item.label}
            </span>
            <SuggestionTypeIcon />
          </button>
        );
      })}
    </div>
  );
}

/** Magnific の右端アイコン（picture-frame） */
function SuggestionTypeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-neutral-500"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
