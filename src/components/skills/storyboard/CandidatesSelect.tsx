/**
 * 同時生成枚数 (1 カットあたりの take 数) のセレクタ。
 * P10 (2026-05-20 STΛCK 指示): 絵コンテ生成 / 本生成それぞれで 1 / 2 / 3 から
 * 選べるようにする。
 */
type Props = {
  value: 1 | 2 | 3;
  onChange: (n: 1 | 2 | 3) => void;
  label?: string;
  disabled?: boolean;
};

export function CandidatesSelect({ value, onChange, label = "枚数", disabled }: Props) {
  return (
    <label
      className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#161616] px-2 py-1 text-[11px] text-zinc-300"
      title="1 カットあたりの同時生成枚数"
    >
      <span className="text-zinc-500">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) as 1 | 2 | 3)}
        className="cursor-pointer bg-transparent text-pink-200 outline-none disabled:cursor-not-allowed disabled:text-zinc-500"
      >
        <option value={1}>1枚</option>
        <option value={2}>2枚</option>
        <option value={3}>3枚</option>
      </select>
    </label>
  );
}
