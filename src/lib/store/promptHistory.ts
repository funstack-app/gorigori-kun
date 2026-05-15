import { create } from "zustand";
import { history as historyIpc, type PromptHistoryRow } from "../ipc";

export type { PromptHistoryRow };

type PromptHistoryState = {
  entries: PromptHistoryRow[];
  loading: boolean;
  /** Load the most-recent N entries from SQLite. Idempotent. */
  load: () => Promise<void>;
  /** Insert a freshly-recorded prompt to the top so the sidebar
   *  reflects user actions without waiting for a refetch. */
  prepend: (entry: PromptHistoryRow) => void;
  /** Update the thumb_path on the most-recent entry that has none —
   *  used right after a generated image is recorded. */
  attachThumbToTurn: (turnId: string, path: string) => void;
};

export const usePromptHistory = create<PromptHistoryState>((set, get) => ({
  entries: [],
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const rows = await historyIpc.recent(200);
      set({ entries: Array.isArray(rows) ? rows : [], loading: false });
    } catch (err) {
      console.error("turns_recent failed", err);
      set({ loading: false });
    }
  },

  prepend: (entry) =>
    set((s) => {
      // De-dupe by id in case of re-record races.
      if (s.entries.some((e) => e.id === entry.id)) return s;
      return { entries: [entry, ...s.entries] };
    }),

  attachThumbToTurn: (turnId, path) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === turnId && !e.thumbPath ? { ...e, thumbPath: path } : e,
      ),
    })),
}));

// dev-only: expose store for Playwright UI tests / inspection
if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.promptHistory = usePromptHistory;
}
