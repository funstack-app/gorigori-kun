import { create } from "zustand";

import {
  magnific,
  remoteMcp,
  type MagnificAccount,
  type RemoteMcpQueryArgs,
  type RemoteMcpQueryResult,
  type RemoteMcpToolInfo,
  type RemoteMcpToolsResult,
} from "../ipc";

export type RemoteMcpCreditStatus =
  | "idle"
  | "loading"
  | "ok"
  | "unsupported"
  | "error";

export type RemoteMcpCreditEntry = {
  value: number | null;
  fetchedAt: number | null;
  status: RemoteMcpCreditStatus;
};

type RemoteMcpCreditsState = {
  providers: Record<string, RemoteMcpCreditEntry>;
  refreshProvider: (providerId: string) => Promise<void>;
  refreshConnected: (providerIds: readonly string[]) => Promise<void>;
};

type RemoteMcpCreditsDependencies = {
  listTools: (providerId: string) => Promise<RemoteMcpToolsResult>;
  query: (args: RemoteMcpQueryArgs) => Promise<RemoteMcpQueryResult>;
  magnificAccount: () => Promise<MagnificAccount>;
  now: () => number;
};

const DEFAULT_ENTRY: RemoteMcpCreditEntry = {
  value: null,
  fetchedAt: null,
  status: "idle",
};

const MUTATING_TOOL_NAME =
  /(^|_)(add|buy|charge|consume|create|delete|deposit|generate|order|purchase|remove|set|spend|transfer|update|withdraw)(_|$)/;
const NON_BALANCE_CREDIT_TOOL_NAME =
  /(^|_)(cost|history|ledger|log|logs|price|pricing|spent|transaction|usage|plan|plans|topup|top_up|recharge|purchase|upgrade)(_|$)/;

function normalizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function creditToolScore(tool: RemoteMcpToolInfo): number | null {
  const name = normalizeIdentifier(tool.name);
  if (!name || MUTATING_TOOL_NAME.test(name) || NON_BALANCE_CREDIT_TOOL_NAME.test(name)) {
    return null;
  }

  const titleAndDescription = `${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
  const hasBalance = /(^|_)balance(_|$)/.test(name) || /\baccount balance\b|残高/.test(titleAndDescription);
  const hasCreditsName = /(^|_)credits?(_|$)/.test(name);
  const hasCreditsDesc = /\bcredits?\b|クレジット/.test(titleAndDescription);
  const hasAccount = /(^|_)accounts?(_|$)/.test(name);
  const readsValue = /(^|_)(get|read|fetch|check|retrieve|show|view|list|query)_/.test(name);

  if (hasBalance && (hasCreditsName || hasCreditsDesc)) return 140;
  if (hasBalance && hasAccount) return 130;
  if (hasBalance) return 120;
  if (
    hasCreditsName &&
    (readsValue || hasAccount || name === "credit" || name === "credits")
  ) {
    return 110;
  }
  if (readsValue && hasCreditsDesc) {
    return /\b(balance|remaining|available|left)\b|残高/.test(titleAndDescription) ? 90 : 70;
  }
  if (
    name === "account" ||
    name === "account_info" ||
    name === "account_details" ||
    name === "account_status" ||
    (hasAccount && (readsValue || hasCreditsDesc))
  ) {
    return 80;
  }
  return null;
}

/** 残高を読む用途だと確認できる、最も具体的なツールを1つ選ぶ。 */
export function findRemoteMcpCreditTool(
  tools: readonly RemoteMcpToolInfo[],
): RemoteMcpToolInfo | null {
  let selected: { tool: RemoteMcpToolInfo; score: number } | null = null;
  for (const tool of tools) {
    const score = creditToolScore(tool);
    if (score === null || (selected && selected.score >= score)) continue;
    selected = { tool, score };
  }
  return selected?.tool ?? null;
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  const match = trimmed.match(/[-+]?\d[\d,\s]*(?:\.\d+)?/);
  if (!match) return null;
  const nonNumericText = `${trimmed.slice(0, match.index)}${trimmed.slice(
    (match.index ?? 0) + match[0].length,
  )}`
    .replace(/credits?|クレジット|残高/gi, "")
    .replace(/[:：=・$¥€£]/g, "")
    .trim();
  if (nonNumericText) return null;
  const parsed = Number(match[0].replace(/[\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

type NumericCandidate = { value: number; score: number; order: number };

function structuredCreditValue(value: unknown): number | null {
  const candidates: NumericCandidate[] = [];
  let order = 0;

  const visit = (current: unknown, creditContext: boolean, depth: number): void => {
    if (depth > 12 || current === null || current === undefined) return;

    if (Array.isArray(current)) {
      for (const item of current) visit(item, creditContext, depth + 1);
      return;
    }

    if (typeof current !== "object") return;

    for (const [rawKey, child] of Object.entries(current as Record<string, unknown>)) {
      const key = normalizeIdentifier(rawKey);
      const hasCredit = /(^|_)credits?(_|$)/.test(key);
      const hasBalance = /(^|_)balance(_|$)/.test(key);
      const isAvailable = /(^|_)(available|remaining)(_|$)/.test(key);
      const isSpentOrLimit =
        /(^|_)(consumed|cost|limit|spent|total|used)(_|$)/.test(key);
      const explicitCreditKey = (hasCredit || hasBalance) && !isSpentOrLimit;
      const score = isSpentOrLimit
        ? null
        : hasBalance || (hasCredit && isAvailable)
          ? 140 - depth
          : hasCredit
            ? 120 - depth
            : creditContext && isAvailable
              ? 105 - depth
              : creditContext && /(^|_)(amount|value)(_|$)/.test(key)
                ? 100 - depth
                : null;
      const parsed = score === null ? null : parseNumericValue(child);
      if (parsed !== null && score !== null) {
        candidates.push({ value: parsed, score, order: order++ });
      }
      visit(child, creditContext || explicitCreditKey, depth + 1);
    }
  };

  const topLevel = parseNumericValue(value);
  if (topLevel !== null && (typeof value === "number" || typeof value === "string")) {
    candidates.push({ value: topLevel, score: 50, order: order++ });
  }
  visit(value, false, 0);
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.value ?? null;
}

function textCreditValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const value = structuredCreditValue(parsed);
    if (value !== null) return value;
  } catch {
    // JSON ではない通常の説明文は、下の残高ラベル付き表現だけを読む。
  }

  const afterLabel = trimmed.match(
    /(?:credit(?:s)?(?:\s+balance)?|balance|クレジット(?:残高)?|残高)\s*(?:is|are|[:=：・])?\s*(?:[A-Z]{3}\s*)?([-+]?\d[\d,\s]*(?:\.\d+)?)/i,
  );
  if (afterLabel) return parseNumericValue(afterLabel[1]);

  const beforeLabel = trimmed.match(
    /([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:credits?|クレジット)/i,
  );
  if (beforeLabel) return parseNumericValue(beforeLabel[1]);

  return /^[-+]?\d[\d,\s]*(?:\.\d+)?$/.test(trimmed)
    ? parseNumericValue(trimmed)
    : null;
}

/** MCP応答から、残高だと確認できる数値だけを取り出す。 */
export function extractRemoteMcpCreditValue(
  result: Pick<RemoteMcpQueryResult, "contentText" | "structuredContent">,
): number | null {
  const structured = structuredCreditValue(result.structuredContent);
  if (structured !== null) return structured;
  return textCreditValue(result.contentText);
}

export function createRemoteMcpCreditsStore(
  overrides: Partial<RemoteMcpCreditsDependencies> = {},
) {
  const dependencies: RemoteMcpCreditsDependencies = {
    listTools: remoteMcp.listTools,
    query: remoteMcp.query,
    magnificAccount: magnific.account,
    now: Date.now,
    ...overrides,
  };

  return create<RemoteMcpCreditsState>((set, get) => ({
    providers: {},

    refreshProvider: async (providerId) => {
      const current = get().providers[providerId] ?? DEFAULT_ENTRY;
      // ツール無しはその起動中ずっと確定扱い。クリック時も再問い合わせしない。
      if (current.status === "unsupported" || current.status === "loading") return;

      set((state) => ({
        providers: {
          ...state.providers,
          [providerId]: {
            value: null,
            fetchedAt: current.fetchedAt,
            status: "loading",
          },
        },
      }));

      try {
        let value: number | null;
        if (providerId === "magnific") {
          const account = await dependencies.magnificAccount();
          value = Number.isFinite(account.credits) ? account.credits : null;
        } else {
          const tools = await dependencies.listTools(providerId);
          const creditTool = findRemoteMcpCreditTool(tools.tools);
          if (!creditTool) {
            set((state) => ({
              providers: {
                ...state.providers,
                [providerId]: {
                  value: null,
                  fetchedAt: dependencies.now(),
                  status: "unsupported",
                },
              },
            }));
            return;
          }

          const result = await dependencies.query({
            providerId,
            toolName: creditTool.name,
            paramsJson: "{}",
          });
          value = extractRemoteMcpCreditValue(result);
        }

        set((state) => ({
          providers: {
            ...state.providers,
            [providerId]: {
              value,
              fetchedAt: dependencies.now(),
              status: value === null ? "error" : "ok",
            },
          },
        }));
      } catch {
        set((state) => ({
          providers: {
            ...state.providers,
            [providerId]: {
              value: null,
              fetchedAt: dependencies.now(),
              status: "error",
            },
          },
        }));
      }
    },

    refreshConnected: async (providerIds) => {
      const uniqueProviderIds = [...new Set(providerIds)];
      await Promise.all(uniqueProviderIds.map((providerId) => get().refreshProvider(providerId)));
    },
  }));
}

export const useRemoteMcpCredits = createRemoteMcpCreditsStore();
