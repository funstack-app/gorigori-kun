import { useEffect, useMemo, useState } from "react";

/**
 * 要素別プロンプト編集モーダル (STΛCK 指示 2026-05-19)。
 *
 * 経緯:
 * - 旧版は ConstructedPromptPanel 内のプロンプト入力欄を ON/OFF で
 *   切り替える設計だった (textarea が要素別 textarea 列に変わる)
 * - 狭い PC (13インチ等) や左パネル幅が縮まった時に各要素 textarea が
 *   小さすぎて使いづらい問題があった
 * - サイズに関係なく操作できるよう、中央に大きく開くモーダル化する
 * - サイズは OptionPickerModal と同じ max-w-5xl で全モーダル統一
 *
 * 動作:
 * - 開いた時点で `prompt` を `,` で分割して各 piece を個別 textarea に表示
 * - 編集中はローカル state に持ち、保存ボタンで親へ反映
 * - キャンセル / 背景クリック / Esc で破棄して閉じる
 *
 * `element: value` 形式と自由記述だけの行の両方に対応。
 */
type Props = {
  open: boolean;
  prompt: string;
  onClose: () => void;
  onApply: (next: string) => void;
};

type Piece = { raw: string };

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

export function ElementwisePromptModal({ open, prompt, onClose, onApply }: Props) {
  // モーダルを開くたびに最新の prompt で初期化する
  const initial = useMemo(() => splitPrompt(prompt), [prompt]);
  const [pieces, setPieces] = useState<Piece[]>(initial);

  useEffect(() => {
    if (open) {
      setPieces(splitPrompt(prompt));
    }
  }, [open, prompt]);

  // Esc で閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const updatePiece = (idx: number, nextRaw: string) => {
    setPieces((prev) =>
      prev.map((p, i) => (i === idx ? { raw: nextRaw } : p)),
    );
  };

  const removePiece = (idx: number) => {
    setPieces((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length === 0 ? [{ raw: "" }] : next;
    });
  };

  const addPiece = () => {
    setPieces((prev) => [...prev, { raw: "" }]);
  };

  const handleApply = () => {
    onApply(joinPieces(pieces));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#0f0f0f] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-6 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              EDIT
            </p>
            <h3 className="text-sm font-black text-white">要素別プロンプト編集</h3>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              各要素を個別に編集できます。「
              <code className="rounded bg-neutral-800 px-1 text-[10px]">要素名: 値</code>
              」形式が標準ですが、自由記述だけの行も入れられます。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md border border-[#343434] bg-[#101010] px-3 py-1 text-xs font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            × 閉じる
          </button>
        </div>

        {/* 本体: 要素リスト */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-6">
          {pieces.map((piece, idx) => {
            const { label, value } = extractLabel(piece.raw);
            return (
              <div key={idx} className="flex items-start gap-2">
                <span
                  className="mt-2 w-28 shrink-0 truncate text-xs font-bold text-neutral-400"
                  title={label}
                >
                  {label}
                </span>
                <textarea
                  value={piece.raw}
                  onChange={(e) => updatePiece(idx, e.target.value)}
                  rows={Math.min(4, Math.max(2, Math.ceil(piece.raw.length / 60)))}
                  placeholder="要素名: 値"
                  className="min-w-0 flex-1 resize-none rounded-md border border-[#343434] bg-[#101010] px-3 py-2 font-mono text-[12px] leading-5 text-neutral-100 outline-none focus:border-pink-500"
                  title={value ? `${label}: ${value}` : piece.raw}
                />
                <button
                  type="button"
                  onClick={() => removePiece(idx)}
                  className="mt-1 h-8 w-8 shrink-0 rounded text-[14px] text-neutral-500 hover:bg-neutral-800 hover:text-rose-300"
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
            className="mt-2 self-start rounded border border-dashed border-[#444] px-3 py-2 text-xs font-bold text-neutral-400 hover:border-pink-400 hover:text-pink-300"
          >
            + 要素を追加
          </button>
        </div>

        {/* フッター */}
        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-[#343434] bg-[#101010] px-4 text-xs font-bold text-neutral-300 hover:border-[#555] hover:text-white"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="h-9 rounded-md bg-pink-500 px-4 text-xs font-black text-white hover:bg-pink-600"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  );
}
