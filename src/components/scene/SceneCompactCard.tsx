type Props = {
  number: string;
  title: string;
  summary: string;
  onClick: () => void;
};

/**
 * 2x2 グリッドの 1 マス。現在の選択サマリを小さく見せて、
 * クリックでモーダル編集を開く。Magnific の参照ラックと同じ思想:
 *   「選んだ結果は常にコンパクトに見せ、編集はモーダル」
 */
export function SceneCompactCard({ number, title, summary, onClick }: Props) {
  const isEmpty = summary === "未設定";
  return (
    <button
      type="button"
      onClick={onClick}
      className="scene-compact-card group flex w-full flex-col items-start gap-1 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2.5 text-left transition hover:border-pink-400 hover:bg-[#141414]"
    >
      <div className="flex items-center gap-2">
        <span className="scene-compact-num text-[10px] font-black uppercase tracking-wide text-neutral-500">
          {number}
        </span>
        <span className="scene-compact-title text-xs font-black text-white">
          {title}
        </span>
      </div>
      <p
        className={[
          "scene-compact-summary line-clamp-2 text-[11px] font-medium leading-snug",
          isEmpty ? "text-neutral-600" : "text-neutral-300",
        ].join(" ")}
      >
        {summary}
      </p>
    </button>
  );
}
