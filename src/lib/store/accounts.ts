import { create } from "zustand";

import {
  auth,
  higgsfield,
  mcp,
  secrets,
  type McpServer,
  type SecretKey,
} from "../ipc";

export type CodexPlan = "free" | "plus" | "pro" | "team";
export type CodexAccountState = {
  loggedIn: boolean;
  email?: string;
  plan: CodexPlan;
};
export type HiggsfieldAccountState = {
  installed: boolean;
  authenticated: boolean;
  plan?: string;
  credits?: number;
  baseline?: number;
};
export type SecretsState = {
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  hasReplicate: boolean;
  hasFalAi: boolean;
  hasStability: boolean;
  hasGoogle: boolean;
  hasBfl: boolean;
  hasIdeogram: boolean;
  hasRecraft: boolean;
  hasRunway: boolean;
  hasLuma: boolean;
  hasPika: boolean;
  hasElevenlabs: boolean;
  hasMagnific: boolean;
  hasUnsplash: boolean;
  hasPexels: boolean;
  hasPixabay: boolean;
  hasTripo: boolean;
  hasMeshy: boolean;
};
export type McpServerState = McpServer;

type AccountsState = {
  codex: CodexAccountState;
  higgsfield: HiggsfieldAccountState;
  secrets: SecretsState;
  mcp: McpServerState[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  refreshSecrets: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  refreshHiggsfield: () => Promise<void>;
  loginCodex: () => Promise<void>;
  setCodexPlan: (plan: CodexPlan) => void;
  setSecretPresence: (key: SecretKey, present: boolean) => void;
  setMcpServers: (servers: McpServerState[]) => void;
};

const CODEX_PLAN_LS_KEY = "codex.plan.v1";

function loadCodexPlan(): CodexPlan {
  try {
    const raw = localStorage.getItem(CODEX_PLAN_LS_KEY);
    if (raw === "free" || raw === "plus" || raw === "pro" || raw === "team") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "pro";
}

function saveCodexPlan(plan: CodexPlan) {
  try {
    localStorage.setItem(CODEX_PLAN_LS_KEY, plan);
  } catch {
    /* ignore */
  }
}

function hasKey(keys: SecretKey[], key: SecretKey) {
  return keys.includes(key);
}

const SECRET_FIELD_MAP = [
  ["openai_api_key", "hasOpenAIKey"],
  ["anthropic_api_key", "hasAnthropicKey"],
  ["replicate_api_token", "hasReplicate"],
  ["fal_api_key", "hasFalAi"],
  ["stability_api_key", "hasStability"],
  ["google_api_key", "hasGoogle"],
  ["bfl_api_key", "hasBfl"],
  ["ideogram_api_key", "hasIdeogram"],
  ["recraft_api_key", "hasRecraft"],
  ["runway_api_key", "hasRunway"],
  ["luma_api_key", "hasLuma"],
  ["pika_api_key", "hasPika"],
  ["elevenlabs_api_key", "hasElevenlabs"],
  ["magnific_api_key", "hasMagnific"],
  ["unsplash_access_key", "hasUnsplash"],
  ["pexels_api_key", "hasPexels"],
  ["pixabay_api_key", "hasPixabay"],
  ["tripo_api_key", "hasTripo"],
  ["meshy_api_key", "hasMeshy"],
] as const satisfies readonly (readonly [SecretKey, keyof SecretsState])[];

function createEmptySecrets(): SecretsState {
  return SECRET_FIELD_MAP.reduce(
    (acc, [, field]) => ({ ...acc, [field]: false }),
    {} as SecretsState,
  );
}

function secretsFromKeys(keys: SecretKey[]): SecretsState {
  return SECRET_FIELD_MAP.reduce(
    (acc, [key, field]) => ({ ...acc, [field]: hasKey(keys, key) }),
    {} as SecretsState,
  );
}

export const useAccounts = create<AccountsState>((set, get) => ({
  codex: { loggedIn: false, plan: loadCodexPlan() },
  higgsfield: { installed: false, authenticated: false },
  secrets: createEmptySecrets(),
  mcp: [],
  loading: false,

  refresh: async () => {
    set({ loading: true, error: undefined });
    const results = await Promise.allSettled([
      (async () => {
        try {
          const result = await auth.read();
          const account = result.account ?? null;
          set((state) => ({
            codex: {
              ...state.codex,
              loggedIn: Boolean(account),
              email: account?.email,
            },
          }));
        } catch (err) {
          set({ error: String(err) });
        }
      })(),
      get().refreshHiggsfield(),
      get().refreshSecrets(),
      get().refreshMcp(),
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      set({ error: String(rejected.reason) });
    }
    set({ loading: false });
  },

  refreshSecrets: async () => {
    const keys = await secrets.list();
    set({ secrets: secretsFromKeys(keys) });
  },

  refreshMcp: async () => {
    const servers = await mcp.list();
    set({ mcp: servers });
  },

  refreshHiggsfield: async () => {
    const status = await higgsfield.status();
    if (!status.installed || !status.authenticated) {
      set({ higgsfield: { installed: status.installed, authenticated: false } });
      return;
    }
    let plan: string | undefined;
    let credits: number | undefined;
    try {
      const account = await higgsfield.account();
      plan = account.subscriptionPlanType;
      credits = account.credits;
    } catch {
      /* status is still useful even if account metadata is unavailable */
    }
    set((state) => ({
      higgsfield: {
        installed: true,
        authenticated: true,
        plan,
        credits,
        baseline:
          credits === undefined
            ? state.higgsfield.baseline
            : state.higgsfield.baseline === undefined ||
                credits > state.higgsfield.baseline
              ? credits
              : state.higgsfield.baseline,
      },
    }));
  },

  loginCodex: async () => {
    await auth.loginChatGPT();
    await get().refresh();
  },

  setCodexPlan: (plan) => {
    saveCodexPlan(plan);
    set((state) => ({ codex: { ...state.codex, plan } }));
  },

  setSecretPresence: (key, present) =>
    set((state) => ({
      secrets: {
        ...state.secrets,
        ...SECRET_FIELD_MAP.reduce<Partial<SecretsState>>(
          (acc, [secretKey, field]) =>
            secretKey === key ? { ...acc, [field]: present } : acc,
          {},
        ),
      },
    })),

  setMcpServers: (servers) => set({ mcp: servers }),
}));

if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
  (window as any).__stores ??= {};
  (window as any).__stores.accounts = useAccounts;
}
