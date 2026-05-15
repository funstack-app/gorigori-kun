import { create } from "zustand";

type Source = { path: string; name: string };

type MaskEditorState = {
  /** When set, the modal is shown editing this image. */
  source?: Source;
  open: (source: Source) => void;
  close: () => void;
};

export const useMaskEditor = create<MaskEditorState>((set) => ({
  source: undefined,
  open: (source) => set({ source }),
  close: () => set({ source: undefined }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.maskEditor = useMaskEditor;
}
