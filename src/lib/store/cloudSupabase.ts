import { create } from "zustand";
import {
  supabaseCloud,
  type CloudUsage,
  type SupabaseConfig,
  type SupabaseSyncResult,
} from "../ipc";

type CloudSupabaseState = {
  config: SupabaseConfig | null;
  usage: CloudUsage | null;
  loading: boolean;
  lastSync: SupabaseSyncResult | null;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  saveConfig: (config: SupabaseConfig) => Promise<void>;
  disconnect: () => Promise<void>;
  syncNow: () => Promise<SupabaseSyncResult>;
};

export const useCloudSupabase = create<CloudSupabaseState>((set, get) => ({
  config: null,
  usage: null,
  loading: false,
  lastSync: null,
  refresh: async () => {
    set({ loading: true });
    try {
      const config = await supabaseCloud.getConfig();
      set({ config });
      if (config) await get().refreshUsage();
      else set({ usage: null });
    } finally {
      set({ loading: false });
    }
  },
  refreshUsage: async () => {
    const usage = await supabaseCloud.usage();
    set({ usage });
  },
  saveConfig: async (config) => {
    await supabaseCloud.saveConfig(config);
    set({ config });
    await get().refreshUsage().catch(() => undefined);
  },
  disconnect: async () => {
    await supabaseCloud.disconnect();
    set({ config: null, usage: null, lastSync: null });
  },
  syncNow: async () => {
    const result = await supabaseCloud.syncNow();
    set({ lastSync: result });
    await get().refreshUsage().catch(() => undefined);
    return result;
  },
}));
