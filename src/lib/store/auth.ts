import { create } from "zustand";

import {
  auth as authIpc,
  onNotification,
  type AuthAccount,
  type RpcNotification,
} from "../ipc";

export type RateBucket = {
  usedPercent: number;
  resetsAt: number; // unix seconds
  windowDurationMins: number;
};

export type RateLimits = {
  primary?: RateBucket | null;
  secondary?: RateBucket | null;
  planType?: string | null;
};

type AuthState = {
  account: AuthAccount;
  rateLimits?: RateLimits;
  loading: boolean;
  loginInProgress: "none" | "chatgpt" | "apiKey";
  error?: string;
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  loginWithApiKey: (apiKey: string) => Promise<void>;
  loginWithChatGPT: () => Promise<void>;
  logout: () => Promise<void>;
  /** Subscribe to login/account notifications. Idempotent. */
  attachListeners: () => Promise<void>;
};

let attached = false;
let listenerHandle: undefined | (() => void);

export const useAuth = create<AuthState>((set, get) => ({
  account: null,
  loading: false,
  loginInProgress: "none",

  attachListeners: async () => {
    if (attached) return;
    attached = true;
    listenerHandle?.();
    listenerHandle = await onNotification((n: RpcNotification) => {
      if (
        n.method === "account/updated" ||
        n.method === "account/login/completed" ||
        n.method === "account/logout/completed"
      ) {
        // 通知起点の再取得は silent (2026-07-30)。loading を立てると AuthGate が
        // Splash に切り替わり、スキャフォールド全体が unmount→remount して起動時
        // effect カスケードが再演される (Maximum update depth の増幅経路)。
        // silent でも account は更新されるので、login/logout 完了時の画面遷移
        // (LoginPanel 表示/解除) は account の変化だけで成立する。
        get().refresh({ silent: true });
      }
      if (n.method === "account/rateLimits/updated") {
        const r = (n.params as any)?.rateLimits ?? {};
        set({
          rateLimits: {
            primary: r.primary ?? null,
            secondary: r.secondary ?? null,
            planType: r.planType ?? null,
          },
        });
      }
    });
  },

  // silent=true の時は loading フラグを立てない (AuthGate の Splash 差し替えを
  // 防ぐ)。生成前の認証再チェックなど、画面遷移を伴わせたくない確認で使う。
  // (Bug修正 2026-05-28: 生成時の白フラッシュ根治)
  refresh: async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      set({ loading: true, error: undefined });
    }
    try {
      const r = await authIpc.read();
      set({
        account: r.account ?? null,
        loading: false,
        loginInProgress: "none",
      });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  loginWithApiKey: async (apiKey: string) => {
    set({ loginInProgress: "apiKey", error: undefined });
    try {
      await authIpc.loginApiKey(apiKey);
      // login/start may be sync — the notification path above handles update
      await get().refresh();
    } catch (err) {
      set({ loginInProgress: "none", error: String(err) });
      throw err;
    }
  },

  loginWithChatGPT: async () => {
    set({ loginInProgress: "chatgpt", error: undefined });
    try {
      await authIpc.loginChatGPT();
      // browser is open; we wait for account/login/completed via listener
    } catch (err) {
      set({ loginInProgress: "none", error: String(err) });
      throw err;
    }
  },

  logout: async () => {
    set({ loading: true, error: undefined });
    try {
      await authIpc.logout();
      set({ account: null, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },
}));

if (typeof import.meta !== "undefined" && (import.meta as any).hot) {
  (import.meta as any).hot.dispose(() => {
    listenerHandle?.();
    listenerHandle = undefined;
    attached = false;
  });
}
