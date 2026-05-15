import { create } from "zustand";

type EditTabState = {
  selectedImagePath: string | null;
  maskPath: string | null;
  instruction: string;
  setSelectedImagePath: (path: string | null) => void;
  setMaskPath: (path: string | null) => void;
  setInstruction: (instruction: string) => void;
};

export const useEditTab = create<EditTabState>((set) => ({
  selectedImagePath: null,
  maskPath: null,
  instruction: "",
  setSelectedImagePath: (selectedImagePath) =>
    set({ selectedImagePath, maskPath: null }),
  setMaskPath: (maskPath) => set({ maskPath }),
  setInstruction: (instruction) => set({ instruction }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.editTab = useEditTab;
}
