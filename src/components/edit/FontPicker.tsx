import { useEffect, useState } from "react";

import { editFonts } from "../../lib/ipc";
import type { FontInfo } from "../../lib/edit/types";

type FontPickerProps = {
  value: string;
  onChange: (family: string) => void;
  languageHint?: string | null;
};

export function FontPicker({ value, onChange, languageHint }: FontPickerProps) {
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
