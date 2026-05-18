import { useEffect, useMemo, useState } from "react";

/**
 * 要素別プロンプト編集 UI。
 *
 * F-#5 修正 (2026-05-19): Ta4low さん要望。シーン構築 UI で構図/光/カメラ
 * 等が分かれているのに、最終プロンプト欄は 1 つに合算されているので
 * 「同じ構図で光だけ変えたい」が手で書き換えるしかない。
 *
 * このコンポーネントは `effectivePrompt` (例: "subject: a cat, lighting: studio, camera: 50mm")
 * を `,` で分割して、各 piece を個別 textarea に分けて表示する。
 * 各 piece の編集は `onChange` で結合して呼び出し元 (ConstructedPromptPanel) に伝える。
 *
 * 設計上の割り切り:
 * - piece の分割は単純な `,` で行う。プロンプトに `,` を含めたい場合は
 *   通常モード (textarea 一個) で書く前提
 * - `element: value` パターンも `自由記述だけ` の piece も受け入れる
 * - 編集中に新しい piece を増やす (末尾に空の textarea) ことは可能、
 *   削除も可能
 */
type Props = {
  prompt: string;
  onChange: (next: string) => void;
};

type Piece = {
  /** カンマ区切りの 1 要素全体 (例: "lighting: natural light") */
  raw: string;
};

function splitPrompt(prompt: string): Piece[] {
  return prompt
    .split(",")
    .map((s) => ({ raw: s.trim() }))
    .filter((p, idx, arr) => p.raw.length > 0 || idx === arr.length - 1);
}

function joinPieces(pieces: Piece[]): string {
  return pieces
    .map((p) => p.raw.trim())
    .filter((s) => s.length > 0)
    .join(", ");
}

function extractLabel(raw: string): { label: string; value: string } {
  const idx = raw.indexOf(":");
  if (idx < 0) return { label: "自由記述", value: raw };
  return {
    label: raw.slice(0, idx).trim(),
    value: raw.slice(idx + 1).trim(),
  };
}

export function ElementwisePromptEditor({ prompt, onChange }: Props) {
  // ローカルで piece 列を持ち、編集中は親に逐次同期する。
  // prompt が外部から変化したら同期し直す。
  const initialPieces = useMemo(() => splitPrompt(prompt), [prompt]);
  const [pieces, setPieces] = useState<Piece[]>(initialPieces);

  // prompt (外部) ↔ pieces (ローカル) を join したものが等しければ何もしない。
  // 等しくないなら外部が真とみなして再同期 (プリセット選択や自動戻し等)。
  useEffect(() => {
    const joined = joinPieces(pieces);
    if (joined !== prompt.trim()) {
      setPieces(splitPrompt(prompt));
    }
    // pieces を依存にすると無限ループ。意図的に外す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  const updatePiece = (idx: number, nextRaw: string) => {
    const nextPieces = pieces.map((p, i) =>
      i === idx ? { raw: nextRaw } : p,
    );
    setPieces(nextPieces);
    onChange(joinPieces(nextPieces));
  };

  const removePiece = (idx: number) => {
    const next = pieces.filter((_, i) => i !== idx);
    const adjusted = next.length === 0 ? [{ raw: "" }] : next;
    setPieces(adjusted);
    onChange(joinPieces(adjusted));
  };

  const addPiece = () => {
    const next = [...pieces, { raw: "" }];
    setPieces(next);
    // 空 piece の追加は join 結果に影響しないので onChange は呼ばない
  };

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
      <p className="text-[10px] text-neutral-500">
        各要素を個別に編集できます。「{`lighting: studio`}」のように
        <code className="mx-0.5 rounded bg-neutral-800 px-1 text-[10px]">要素名: 値</code>
        の形式が標準ですが、自由記述だけの行も入れられます。
      </p>
      {pieces.map((piece, idx) => {
        const { label, value } = extractLabel(piece.raw);
        return (
          <div key={idx} className="flex items-start gap-1.5">
            <span className="mt-1.5 w-20 shrink-0 truncate text-[10px] font-bold text-neutral-400" title={label}>
              {label}
            </span>
            <textarea
              value={piece.raw}
              onChange={(e) => updatePiece(idx, e.target.value)}
              rows={Math.min(3, Math.max(1, Math.ceil(piece.raw.length / 40)))}
              placeholder="要素名: 値"
              className="min-w-0 flex-1 resize-none rounded-md border border-[#343434] bg-[#101010] px-2 py-1 font-mono text-[11px] leading-5 text-neutral-100 outline-none focus:border-pink-500"
              title={value ? `${label}: ${value}` : piece.raw}
            />
            <button
              type="button"
              onClick={() => removePiece(idx)}
              className="mt-1 h-6 w-6 shrink-0 rounded text-[12px] text-neutral-500 hover:bg-neutral-800 hover:text-rose-300"
              title="この要素を削除"
              aria-label="要素削除"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addPiece}
        className="mt-1 self-start rounded border border-dashed border-[#444] px-2 py-1 text-[10px] font-bold text-neutral-400 hover:border-pink-400 hover:text-pink-300"
      >
        + 要素を追加
      </button>
    </div>
  );
}
