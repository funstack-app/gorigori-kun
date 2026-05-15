import { useSkillMode } from "../lib/store/skillMode";

export function SkillModeToggle() {
  const enabled = useSkillMode((s) => s.enabled);
  const setEnabled = useSkillMode((s) => s.setEnabled);

  return (
    <button
      type="button"
      onClick={() => setEnabled(!enabled)}
      aria-pressed={enabled}
      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs font-black transition ${
        enabled
          ? "border-pink-400 bg-pink-500/15 text-pink-100"
          : "border-[#343434] bg-[#101010] text-neutral-400 hover:border-pink-400 hover:text-white"
      }`}
    >
      <span>{enabled ? "● スキルモード ON" : "● スキルモード OFF"}</span>
      <span className="text-[10px] font-bold opacity-70">クリックで切替</span>
    </button>
  );
}
