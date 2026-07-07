import { useEffect, useMemo, useState } from "react";

import { editFonts } from "../../lib/ipc";
import { suggestFonts, type FontMatchHint } from "../../lib/edit/fontMatch";
import type { FontInfo } from "../../lib/edit/types";

type FontPickerProps = {
  value: string;
  onChange: (family: string) => void;
  languageHint?: string | null;
  /** 元書体の特徴。渡すと「近いフォント」を先頭に提示する（完全一致は狙わない）。 */
  matchHint?: FontMatchHint | null;
  /** 近似候補が外れたときの逃げ道（既存「同じ雰囲気でAI差し替え」への導線）。 */
  onRequestAiReplace?: (() => void) | null;
};

export function FontPicker({
  value,
  onChange,
  languageHint,
  matchHint,
  onRequestAiReplace,
}: FontPickerProps) {
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 近似候補（上位3件）。matchHint 未指定・一致ゼロなら空配列で、セクションごと出さない。
  const suggestions = useMemo(
    () => (matchHint ? suggestFonts(fonts, matchHint, 3) : []),
    [fonts, matchHint],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    editFonts
      .list(languageHint)
      .then((list) => {
        if (cancelled) return;
        setFonts(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [languageHint]);

  return (
    <div className="space-y-1">
      <span className="block text-xs font-bold text-neutral-300">フォント</span>
      {suggestions.length > 0 && (
        <div className="space-y-1 rounded-lg border border-pink-500/30 bg-pink-500/5 px-2 py-2">
          <span className="block text-[10px] font-bold text-pink-200">
            元の書体に近いフォント
          </span>
          <div className="flex flex-wrap gap-1">
            {suggestions.map((font) => (
              <button
                key={font.family}
                type="button"
                onClick={() => onChange(font.family)}
                style={{ fontFamily: font.family }}
                className={`rounded border px-2 py-1 text-[11px] transition ${
                  value === font.family
                    ? "border-pink-400 bg-pink-500/20 text-pink-100"
                    : "border-[#343434] bg-[#0b0b0b] text-neutral-200 hover:border-pink-400/60"
                }`}
              >
                {font.displayName}
              </button>
            ))}
          </div>
          {onRequestAiReplace && (
            <button
              type="button"
              onClick={onRequestAiReplace}
              className="text-[10px] font-bold text-neutral-500 underline decoration-dotted hover:text-pink-200"
            >
              思った書体と違う → 同じ雰囲気でAI差し替え
            </button>
          )}
        </div>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        className="w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-sm text-neutral-100 outline-none focus:border-pink-400 disabled:opacity-50"
      >
        {loading && <option>読み込み中…</option>}
        {!loading && fonts.length === 0 && (
          <option value="system-ui">System Default</option>
        )}
        {fonts.map((font) => (
          <option
            key={font.family}
            value={font.family}
            style={{ fontFamily: font.family }}
          >
            {font.displayName}
          </option>
        ))}
      </select>
      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-200">
          フォント一覧取得失敗: {error}
        </p>
      )}
    </div>
  );
}
