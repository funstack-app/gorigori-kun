import { describe, expect, it, vi } from "vitest";

import {
  createRemoteMcpCreditsStore,
  extractRemoteMcpCreditValue,
  findRemoteMcpCreditTool,
} from "../src/lib/store/remoteMcpCredits";

describe("extractRemoteMcpCreditValue", () => {
  it("structuredContent のクレジット残高を優先して取り出す", () => {
    expect(
      extractRemoteMcpCreditValue({
        contentText: "plan version 2",
        structuredContent: {
          account: { plan: "Business", credits: "77,702" },
        },
      }),
    ).toBe(77_702);
    expect(
      extractRemoteMcpCreditValue({
        contentText: "",
        structuredContent: {
          totalCredits: 100,
          usedCredits: 20,
          remainingCredits: 80,
        },
      }),
    ).toBe(80);
  });

  it("JSON文字列と通常文の残高表現を取り出す", () => {
    expect(
      extractRemoteMcpCreditValue({
        contentText: '{"data":{"balance":{"remaining":6872}}}',
      }),
    ).toBe(6_872);
    expect(
      extractRemoteMcpCreditValue({
        contentText: "Business · 1,234 credits",
      }),
    ).toBe(1_234);
  });

  it("残高と確認できない数字は採用しない", () => {
    expect(
      extractRemoteMcpCreditValue({
        contentText: "API version 2, requests 20",
        structuredContent: { version: 2, requests: 20 },
      }),
    ).toBeNull();
    expect(
      extractRemoteMcpCreditValue({
        contentText: "",
        structuredContent: "Business plan version 2",
      }),
    ).toBeNull();
  });
});

describe("findRemoteMcpCreditTool", () => {
  it("生成や利用履歴ではなく読み取り用の残高ツールを選ぶ", () => {
    const selected = findRemoteMcpCreditTool([
      {
        name: "generate_image",
        description: "Costs credits",
        inputSchemaJson: "{}",
      },
      {
        name: "credit_usage_history",
        inputSchemaJson: "{}",
      },
      {
        name: "get_account_balance",
        inputSchemaJson: "{}",
      },
    ]);

    expect(selected?.name).toBe("get_account_balance");
  });
});

describe("remote MCP credits store", () => {
  it("残高ツールが無いプロバイダをunsupportedで確定し再問い合わせしない", async () => {
    const listTools = vi.fn().mockResolvedValue({
      providerId: "krea",
      authStatus: "authenticated",
      tools: [
        { name: "models_list", inputSchemaJson: "{}" },
        { name: "generate_image", inputSchemaJson: "{}" },
      ],
    });
    const query = vi.fn();
    const store = createRemoteMcpCreditsStore({
      listTools,
      query,
      now: () => 123_456,
    });

    await store.getState().refreshProvider("krea");
    await store.getState().refreshProvider("krea");

    expect(store.getState().providers.krea).toEqual({
      value: null,
      fetchedAt: 123_456,
      status: "unsupported",
    });
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it("見つけた残高ツールを空パラメータで呼び実測値を保存する", async () => {
    const query = vi.fn().mockResolvedValue({
      contentText: "",
      structuredContent: { creditsRemaining: 321 },
    });
    const store = createRemoteMcpCreditsStore({
      listTools: vi.fn().mockResolvedValue({
        providerId: "runway",
        authStatus: "authenticated",
        tools: [{ name: "get_credits", inputSchemaJson: "{}" }],
      }),
      query,
      now: () => 789,
    });

    await store.getState().refreshProvider("runway");

    expect(query).toHaveBeenCalledWith({
      providerId: "runway",
      toolName: "get_credits",
      paramsJson: "{}",
    });
    expect(store.getState().providers.runway).toEqual({
      value: 321,
      fetchedAt: 789,
      status: "ok",
    });
  });
});
