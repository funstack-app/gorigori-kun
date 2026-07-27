import { useEffect, useRef, useState } from "react";

/**
 * スキル画面の冒頭に置く共通の案内。
 *
 * STΛCK 指摘 (2026-07-26): 「スキルを開いても、この画面で何をすればいいか分からない」。
 * 各 Workspace がバラバラに書くと見た目が揃わないので、1つの部品に寄せる。
 *
 * STΛCK 指摘 (2026-07-27): 「貴重なUIを説明で取りすぎている。ヘルプを押すと
 * ポップアップで出てくる方がいい」。常時展開だと画面上部を恒久的に占有し、
 * 一度読んだ後はただの邪魔になる。そこで:
 *   - 既定は「? ヘルプ」の小さいボタン1つだけ (占有はボタン分のみ)
 *   - そのスキルを初めて開いたときだけ自動で開く (初見で何も分からない状態は作らない)
 *   - 一度開いたら記憶し、次回以降は畳んだまま (localStorage)
 *
 * 書く内容は2つだけ:
 *   what — 何を渡すと何が手に入るか (1文)
 *   first — まず何をすればいいか (1文。「まず〜」で始める)
 * note は「できないこと」を正直に伝える必要があるときだけ使う (任意)。
 *
 * 文言は src/lib/skills/catalog.ts の description と矛盾させない。
 * 実装していないことを書かない (表情差分の自動検品 / シーン再現の動画URL /
 * 漫画の吹き出し焼き込みは、いずれも未実装)。
 */

const SEEN_KEY_PREFIX = "gori.skillIntro.seen.";

/** what の文面から安定したキーを作る (スキルごとに別々に「読んだ」を覚えるため)。 */
function introKey(what: string): string {
  let hash = 0;
  for (let i = 0; i < what.length; i += 1) {
    hash = (hash * 31 + what.charCodeAt(i)) | 0;
  }
  return `${SEEN_KEY_PREFIX}${hash}`;
}

export function SkillIntro({
  what,
  first,
  note,
}: {
  what: string;
  first: string;
  note?: string;
}) {
  const key = introKey(what);
  // 初回だけ開いた状態で始める。2回目以降は畳んだまま。
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === null;
    } catch {
      return true;
    }
  });
  const popRef = useRef<HTMLDivElement | null>(null);

  // 開いたことを記録する (次回から畳んだ状態で始まる)
  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(key, "1");
    } catch {
      // 保存できなくても動作には影響しない (毎回開くだけ)
    }
  }, [open, key]);

  // 外側クリック / Escape で閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition",
          open
            ? "border-pink-400/60 bg-pink-500/10 text-pink-200"
            : "border-[#343434] bg-[#181818] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200",
        ].join(" ")}
        aria-expanded={open}
      >
        <span
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[9px]"
          aria-hidden
        >
          ?
        </span>
        ヘルプ
      </button>

      {open ? (
        <div
          ref={popRef}
          className="absolute left-0 top-full z-20 mt-1.5 w-[min(30rem,calc(100vw-3rem))] rounded-lg border border-[#343434] bg-[#1a1a1a] px-3.5 py-3 shadow-xl"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[12px] leading-relaxed text-neutral-300">{what}</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="-mr-1 -mt-1 shrink-0 rounded p-1 text-neutral-500 hover:text-white"
              aria-label="閉じる"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="mt-1.5 text-[12px] font-bold leading-relaxed text-pink-300">{first}</p>
          {note ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">{note}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
