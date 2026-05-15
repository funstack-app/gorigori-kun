import { useSkillMode } from "../lib/store/skillMode";
import { useWorkspace } from "../lib/store/workspace";
import { useToasts } from "../lib/store/toasts";
import type { GoriSkill } from "../lib/skills/catalog";

export function activateSkill(skill: GoriSkill) {
  const skillMode = useSkillMode.getState();
  skillMode.setEnabled(true);
  skillMode.setSelectedSkillId(skill.id);

  const workspace = useWorkspace.getState();
  workspace.setActiveTab("generate");
  if (skill.id === "gori-storyboard") {
    workspace.setPurpose("videoStory");
  }

  useToasts.getState().push({
    kind: skill.availableInApp ? "success" : "info",
    text: skill.availableInApp
      ? `${skill.name} を起動しました。`
      : `${skill.name} を選択しました（実行UIは後続接続）。`,
    ttlMs: 3000,
  });
}

export function SkillBadge({
  skill,
  compact = false,
  onActivated,
}: {
  skill: GoriSkill;
  compact?: boolean;
  onActivated?: () => void;
}) {
  const selectedSkillId = useSkillMode((s) => s.selectedSkillId);
  const enabled = useSkillMode((s) => s.enabled);
  const active = enabled && selectedSkillId === skill.id;

  return (
    <button
      type="button"
      onClick={() => {
        activateSkill(skill);
        onActivated?.();
      }}
      aria-pressed={active}
      title={`${skill.name}\n${skill.launchHint}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-black transition ${
        active
          ? "border-pink-400 bg-pink-500/20 text-pink-100"
          : "border-[#343434] bg-[#101010] text-neutral-300 hover:border-pink-400 hover:text-white"
      }`}
    >
      <span aria-hidden>{skill.icon}</span>
      <span className="whitespace-nowrap">{compact ? skill.shortName : skill.name}</span>
    </button>
  );
}
