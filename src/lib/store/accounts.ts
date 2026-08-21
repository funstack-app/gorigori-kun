import { create } from "zustand";

import {
  auth,
  higgsfieldMcp,
  magnific,
  mcp,
  remoteMcp,
  secrets,
  type McpServer,
  type SecretKey,
} from "../ipc";
import { useHiggsfieldModel } from "./higgsfieldModel";
import { useMagnificModel } from "./magnificModel";

/**
 * 未認証を観測したらモデル選択を掃除する (2026-06-10 実機FB)。
 * 接続を解除しても localStorage に選択モデルが残ると、トリガーボタンが
 * 「Magnific 2 models」のまま固まり、生成も未接続エラーで必ず失敗する。
 * 接続解除ボタン経由・アプリ外での解除・再起動後の stale 選択の全経路を
 * refresh 時にここで一括で塞ぐ。
 */
function clearHiggsfieldSelectionIfStale() {
  const s = useHiggsfieldModel.getState();
  if (s.selectedModels.length > 0) s.setSelectedModels([]);
}

function clearMagnificSelectionIfStale() {
  const s = useMagnificModel.getState();
  if (s.selectedModels.length > 0) s.clear();
}

export type CodexPlan = "free" | "plus" | "pro" | "team";
export type CodexAccountState = {
  loggedIn: boolean;
  email?: string;
  plan: CodexPlan;
};
// Higgsfield リモートMCP拡張 (2026-06-10 段階7)。CLI同梱方式から MCP接続方式へ移行。
// installed (拡張パック導入有無) の概念を廃止し、Magnific と同型の {registered, authenticated}
// ベースにする。plan/credits は Rust 側 account 実装待ちのため当面 optional (未配線)。
export type HiggsfieldAccountState = {
  registered: boolean;
  authenticated: boolean;
  plan?: string;
  credits?: number;
  baseline?: number;
};
// Magnific オプショナル拡張 (2026-06-08)。未接続なら registered=false で degrade。
export type MagnificAccountState = {
  registered: boolean;
  authenticated: boolean;
};
export type RemoteMcpAccountState = Record<
  string,
  { registered: boolean; authenticated: boolean }
>;
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
  // hasUnsplash は法務対応 (2026-05-21) で撤去。
  hasPexels: boolean;
  hasPixabay: boolean;
  hasTripo: boolean;
  hasMeshy: boolean;
};
export type McpServerState = McpServer;

type AccountsState = {
  codex: CodexAccountState;
  higgsfield: HiggsfieldAccountState;
  magnific: MagnificAccountState;
  remoteMcp: RemoteMcpAccountState;
  secrets: SecretsState;
  mcp: McpServerState[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  refreshSecrets: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  refreshHiggsfield: () => Promise<void>;
  refreshMagnific: () => Promise<void>;
  refreshRemoteMcp: () => Promise<void>;
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
  // unsplash_access_key は法務対応 (2026-05-21) で撤去。
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
  higgsfield: { registered: false, authenticated: false },
  magnific: { registered: false, authenticated: false },
  remoteMcp: {},
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
      get().refreshMagnific(),
      get().refreshRemoteMcp(),
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
    // Higgsfield はリモートMCP接続のオプショナル拡張 (段階7)。Magnific と同型に、
    // status が取れなければ未接続として degrade する。
    // 段階8 (2026-06-10): MCP 側 account (balance ツール) が実装されたので、認証済みの
    // ときだけ credits/plan を配線する。account は任意なので失敗しても degrade し、
    // 接続状態 (registered/authenticated) は維持する (Magnific と同じ思想)。
    try {
      const status = await higgsfieldMcp.status();
      set((state) => ({
        higgsfield: {
          ...state.higgsfield,
          registered: status.registered,
          authenticated: status.authenticated,
        },
      }));
      if (!status.authenticated) clearHiggsfieldSelectionIfStale();
      if (status.authenticated) {
        try {
          const account = await higgsfieldMcp.account();
          set((state) => ({
            higgsfield: {
              ...state.higgsfield,
              credits: account.credits,
              plan: account.subscriptionPlanType,
            },
          }));
        } catch (err) {
          // account 取得失敗は接続自体の失敗ではない。credits/plan は埋めずに degrade。
          console.error("[accounts] higgsfield account fetch failed:", err);
        }
      }
    } catch {
      set((state) => ({
        higgsfield: { ...state.higgsfield, registered: false, authenticated: false },
      }));
      clearHiggsfieldSelectionIfStale();
    }
  },

  refreshMagnific: async () => {
    // Magnific はオプショナル拡張。status が取れなければ未接続として degrade する。
    //
    // 選択のクリアは「未登録 (registered:false)」のときだけに絞る (2026-08-05)。
    // magnific_status は `codex mcp list` の spawn 失敗・タイムアウトも
    // {registered:false, authenticated:false} に潰して返すため、認証済みでも
    // 一時的に authenticated:false が返りうる。ここで毎回 clear すると、
    // ユーザーが選んだモデルが生成中などに勝手に消える (実機FB: チカチカ)。
    //
    // registered:true かつ authenticated:false は「登録済みだがトークン切れ」で、
    // 再ログインすればそのまま使える。選択を消さずに残すほうが実態に合う。
    try {
      const status = await magnific.status();
      set({
        magnific: {
          registered: status.registered,
          authenticated: status.authenticated,
        },
      });
      if (!status.registered) clearMagnificSelectionIfStale();
    } catch {
      // 例外は status 取得そのものの失敗。接続状態は不明なので、
      // 選択は消さずに未接続表示へ倒すだけにする。
      set({ magnific: { registered: false, authenticated: false } });
    }
  },

  refreshRemoteMcp: async () => {
    // 状態一覧は Rust 側で codex を1回だけ起動して取得する。取得不能時は、
    // 設定画面を止めずに全サービスを未接続表示へ倒す。
    try {
      const statuses = await remoteMcp.statusAll();
      const next = Object.fromEntries(
        statuses.map(({ id, registered, authenticated }) => [
          id,
          { registered, authenticated },
        ]),
      );
      set({ remoteMcp: next });
    } catch {
      set({ remoteMcp: {} });
    }
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
