import { GORI_SKILLS } from "../lib/skills/catalog";
import { useSkillMode } from "../lib/store/skillMode";

export const AVAILABLE_SKILLS = GORI_SKILLS;

export function SkillSelector() {
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const setSelectedSkillId = useSkillMode((s) => s.setSelectedSkillId);

  return (
    <label className="block space-y-1.5 text-xs">
      <span className="font-bold text-neutral-300">スキル選択</span>
      <select
        value={selectedSkillId ?? ""}
        onChange={(event) => setSelectedSkillId(event.target.value || null)}
        className="w-full rounded-lg border border-[#343434] bg-[#0b0b0b] px-3 py-2 text-neutral-100 outline-none focus:border-pink-400"
      >
        <option value="">選択してください</option>
        {AVAILABLE_SKILLS.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.icon} {skill.name}
          </option>
        ))}
      </select>
      {selectedSkillId && (
        <p className="rounded border border-[#2a2a2a] bg-[#101010] px-2 py-1 text-[11px] text-neutral-400">
          {AVAILABLE_SKILLS.find((skill) => skill.id === selectedSkillId)?.description}
        </p>
      )}
    </label>
  );
}
