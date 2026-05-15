import { create } from "zustand";

type SkillModeState = {
  enabled: boolean;
  selectedSkillId: string | null;
  candidatesPerCut: 1 | 3;
  setEnabled: (v: boolean) => void;
  setSelectedSkillId: (id: string | null) => void;
  setCandidatesPerCut: (n: 1 | 3) => void;
};

export const useSkillMode = create<SkillModeState>((set) => ({
  enabled: false,
  selectedSkillId: null,
  candidatesPerCut: 1,
  setEnabled: (enabled) => set({ enabled }),
  setSelectedSkillId: (selectedSkillId) => set({ selectedSkillId }),
  setCandidatesPerCut: (candidatesPerCut) => set({ candidatesPerCut }),
}));
