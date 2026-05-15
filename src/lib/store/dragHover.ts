import { create } from "zustand";

type State = {
  active: boolean;
  setActive: (a: boolean) => void;
};

export const useDragHover = create<State>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.dragHover = useDragHover;
}
