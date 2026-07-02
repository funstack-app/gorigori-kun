import { useState } from "react";

/**
 * 編集タブ共通のコンパクトなエラー表示ボックス (Photoshop 風 UI 再構成 2026-07-02)。
 *
 * なぜこの部品か: 以前は LayerSplitter (SAM3) の Python traceback 全文が、共有ストア
 * (useEditor.error) 経由でキャンバスの下部オーバーレイに丸ごと流れ込み、キャンバスが
 * 「事故画面」になっていた。エラー表示を右パネル内の固定サイズ (最大4行 + コピー) の
 * ボックスに統一し、どれだけ長い traceback でもレイアウトを壊さないようにする。
 *
 * - 表示は最大4行 (line-clamp-4) に抑え、あふれる分は隠す。
 * - 全文は「詳細をコピー」でクリップボードへ。UI に長文を展開しない。
 */
export function EditErrorBox({ message }: { message: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!message) return null;

  const copy = () => {
    void navigator.clipboard
      ?.writeText(message)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2">
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-[11px] font-bold leading-4 text-red-200">
        {message}
      </p>
      <button
        type="button"
        onClick={copy}
        className="mt-1.5 rounded border border-red-400/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-200 hover:bg-red-500/20"
      >
        {copied ? "コピーしました" : "詳細をコピー"}
      </button>
    </div>
  );
}

export default EditErrorBox;
