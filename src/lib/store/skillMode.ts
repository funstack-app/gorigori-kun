import { create } from "zustand";
import { resolveUiMode, useSkillUiMode } from "./skillUiMode";

type SkillModeState = {
  enabled: boolean;
  selectedSkillId: string | null;
  candidatesPerCut: 1 | 3;
  setEnabled: (v: boolean) => void;
  setSelectedSkillId: (id: string | null) => void;
  setCandidatesPerCut: (n: 1 | 3) => void;
};

/*
 * STΛCK 指示 (2026-05-20): 「スキル ON で UI 切替」仕様を有効化するため、
 * 旧 skillMode (skill 実行制御用) と新 skillUiMode (UI 切替) を連動させる。
 *
 * - enabled=true + selectedSkillId が変わる → skillUiMode に enterSkill 伝搬
 * - enabled=false に戻る → skillUiMode を exitSkill (default 復帰)
 *
 * 旧ストアの互換を保ちつつ、新ストアが自動的に正しいモードに収束する。
 */
function syncUiMode(enabled: boolean, skillId: string | null) {
  const ui = useSkillUiMode.getState();
  if (enabled && skillId) {
    const mode = resolveUiMode(skillId);
    ui.enterSkill(skillId, mode);
  } else {
    ui.exitSkill();
  }
}

export const useSkillMode = create<SkillModeState>((set, get) => ({
  enabled: false,
  selectedSkillId: null,
  candidatesPerCut: 1,
  setEnabled: (enabled) => {
    set({ enabled });
    syncUiMode(enabled, get().selectedSkillId);
  },
  setSelectedSkillId: (selectedSkillId) => {
    set({ selectedSkillId });
    syncUiMode(get().enabled, selectedSkillId);
  },
  setCandidatesPerCut: (candidatesPerCut) => set({ candidatesPerCut }),
}));
