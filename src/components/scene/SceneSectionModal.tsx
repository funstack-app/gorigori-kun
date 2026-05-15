import { useEffect, type ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  number: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * 各シーン構築セクション（主役/光/カメラ/スタイル）の編集ダイアログ。
 * 2x2 コンパクトカードからクリックで開く。
 *
 * - 中身は既存の *Section コンポーネントを children として受ける
 * - Esc / 背景クリックで閉じる
 * - 中身は store に直接 commit するので「保存」ボタンは不要（即時反映）
 *   閉じるボタンだけ右上に置く
 */
export function SceneSectionModal({ open, title, number, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-wide text-neutral-500">
              {number}
            </span>
            <h3 className="text-sm font-black text-white">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-neutral-400 hover:text-white"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
