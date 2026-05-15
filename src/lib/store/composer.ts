import { create } from "zustand";

const COUNT_LS_KEY = "composer.count";
const ASPECT_LS_KEY = "composer.aspect";
export const ASPECT_OPTIONS = ["9:16", "16:9", "1:1", "4:5"] as const;
export type FrameAspect = (typeof ASPECT_OPTIONS)[number];

function isFrameAspect(value: string | null): value is FrameAspect {
  return !!value && (ASPECT_OPTIONS as readonly string[]).includes(value);
}

function readPersistedCount(): number {
  try {
    const raw = localStorage.getItem(COUNT_LS_KEY);
    if (!raw) return 1;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(24, Math.max(1, n));
  } catch {
    return 1;
  }
}

function readPersistedAspect(): FrameAspect {
  try {
    const raw = localStorage.getItem(ASPECT_LS_KEY);
    return isFrameAspect(raw) ? raw : "9:16";
  } catch {
    return "9:16";
  }
}

function persistAspect(aspect: FrameAspect) {
  try {
    localStorage.setItem(ASPECT_LS_KEY, aspect);
  } catch {
    /* private mode / quota exhausted — non-fatal */
  }
}

function persistCount(n: number) {
  try {
    localStorage.setItem(COUNT_LS_KEY, String(n));
  } catch {
    /* private mode / quota exhausted — non-fatal */
  }
}

export type ReferenceSource = "gallery" | "upload";
export type ReferenceRole =
  | "subject"
  | "look"
  | "background"
  | "product"
  | "pose"
  | "negative";

export type Reference = {
  path: string;
  name: string;
  /**
   * If present, this reference is paired with an inpainting mask written
   * to `maskPath`. The mask is treated as a child of the source — removing
   * the mask leaves the source attached, removing the source removes both.
   */
  maskPath?: string;
  /** Where this reference came from — affects icons / labels in the UI. */
  source?: ReferenceSource;
  /** What the generator should inherit from this reference. */
  role?: ReferenceRole;
};

type ComposerState = {
  text: string;
  references: Reference[];
  count: number;
  aspect: FrameAspect;
  setText: (t: string) => void;
  setCount: (n: number) => void;
  setAspect: (aspect: FrameAspect) => void;
  addReference: (ref: Reference) => void;
  /** Add many at once. De-dups against existing paths. */
  addReferences: (refs: Reference[]) => void;
  removeReference: (path: string) => void;
  setReferenceRole: (path: string, role: ReferenceRole) => void;
  /** Attach a mask PNG to a specific reference. */
  setMaskFor: (path: string, maskPath: string) => void;
  /** Drop just the mask, keep the source attached. */
  clearMaskFor: (path: string) => void;
  takeForSend: () => {
    text: string;
    references: Reference[];
    count: number;
    aspect: FrameAspect;
  };
  reset: () => void;
};

export const useComposer = create<ComposerState>((set, get) => ({
  text: "",
  references: [],
  // Start from the last value the user picked instead of always
  // resetting to 1 — they were tired of re-entering "4" every session.
  count: readPersistedCount(),
  aspect: readPersistedAspect(),

  setText: (text) => set({ text }),
  setCount: (count) => {
    const clamped = Math.min(24, Math.max(1, count));
    persistCount(clamped);
    set({ count: clamped });
  },
  setAspect: (aspect) => {
    persistAspect(aspect);
    set({ aspect });
  },

  addReference: (ref) =>
    set((s) =>
      s.references.some((r) => r.path === ref.path)
        ? s
        : { references: [...s.references, ref] },
    ),
  addReferences: (refs) =>
    set((s) => {
      const known = new Set(s.references.map((r) => r.path));
      const fresh = refs.filter((r) => !known.has(r.path));
      return fresh.length > 0
        ? { references: [...s.references, ...fresh] }
        : s;
    }),
  removeReference: (path) =>
    set((s) => ({ references: s.references.filter((r) => r.path !== path) })),
  setReferenceRole: (path, role) =>
    set((s) => ({
      references: s.references.map((r) =>
        r.path === path ? { ...r, role } : r,
      ),
    })),
  setMaskFor: (path, maskPath) =>
    set((s) => ({
      references: s.references.map((r) =>
        r.path === path ? { ...r, maskPath } : r,
      ),
    })),
  clearMaskFor: (path) =>
    set((s) => ({
      references: s.references.map((r) => {
        if (r.path !== path) return r;
        const { maskPath: _drop, ...rest } = r;
        void _drop;
        return rest;
      }),
    })),

  takeForSend: () => {
    const snapshot = {
      text: get().text,
      references: get().references,
      count: get().count,
      aspect: get().aspect,
    };
    return snapshot;
  },

  // After a successful submit we keep the assembled instruction visible
  // so the user can iterate without rebuilding the same choices.
  reset: () => set({ references: [] }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.composer = useComposer;
}
