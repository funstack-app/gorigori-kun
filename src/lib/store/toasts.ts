import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "error";

export type Toast = {
  id: string;
  kind: ToastKind;
  text: string;
  /** Auto-dismiss delay in ms. 0 / undefined = sticky. */
  ttlMs?: number;
};

type ToastsState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export const useToasts = create<ToastsState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = t.id ?? crypto.randomUUID();
    // error は手動で閉じるまで残す (sticky)。配布版で原因調査するときに
    // 一瞬で消えるとユーザーが文言を読めず、デバッグ手がかりが取れない。
    const defaultTtl = t.kind === "error" ? 0 : 5000;
    const item: Toast = { ...t, id, ttlMs: t.ttlMs ?? defaultTtl };
    set((s) => ({ toasts: [...s.toasts, item] }));
    if (item.ttlMs && item.ttlMs > 0) {
      setTimeout(() => get().dismiss(id), item.ttlMs);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
