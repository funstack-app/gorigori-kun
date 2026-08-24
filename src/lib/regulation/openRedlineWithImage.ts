import { useRedline } from "../redline/store";
import { GORI_SKILLS, type GoriSkillId } from "../skills/catalog";
import { useSkillMode } from "../store/skillMode";
import { useToasts } from "../store/toasts";
import { useWorkspace } from "../store/workspace";

export const REDLINE_SKILL_ID = "gori-redline" satisfies GoriSkillId;

/** 規格チェックの指摘画像を原本へ入れ、既存の skillMode 経路で赤入れ反映を開く。 */
export function openRedlineWithImage(imagePath: string): void {
  const skill = GORI_SKILLS.find((candidate) => candidate.id === REDLINE_SKILL_ID);
  if (!skill) {
    useToasts.getState().push({
      kind: "error",
      text: "赤入れ反映はいま使えません。",
      ttlMs: 4000,
    });
    return;
  }

  useRedline.getState().setOriginalPath(imagePath);
  useWorkspace.getState().setActiveTab("generate");

  const skillMode = useSkillMode.getState();
  skillMode.setEnabled(true);
  skillMode.setSelectedSkillId(skill.id);
}

