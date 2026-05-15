import { create } from "zustand";
import type { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "settings.json";
const STORE_KEY = "config";

export type AppSettings = {
  codexBinaryPath?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultCwd?: string;
  approvalPolicy?: "never" | "on-request" | "everything";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
};

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
};

let storeHandle: Store | null = null;

async function getStore(): Promise<Store | null> {
  if (storeHandle) return storeHandle;
  try {
    const { load: loadStore } = await import("@tauri-apps/plugin-store");
    storeHandle = await loadStore(STORE_FILE, { defaults: {}, autoSave: true });
    return storeHandle;
  } catch (err) {
    console.warn("settings store unavailable", err);
    return null;
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: {},
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const store = await getStore();
    if (!store) {
      set({ loaded: true });
      return;
    }
    try {
      const data = (await store.get<AppSettings>(STORE_KEY)) ?? {};
      set({ settings: data, loaded: true });
    } catch (err) {
      console.warn("settings load failed", err);
      set({ loaded: true });
    }
  },
  save: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    const store = await getStore();
    if (!store) return;
    try {
      await store.set(STORE_KEY, next);
      await store.save();
    } catch (err) {
      console.warn("settings save failed", err);
    }
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.settings = useSettings;
}
