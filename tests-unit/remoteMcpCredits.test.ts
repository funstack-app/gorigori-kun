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

  it("Kling の query_membership_and_credits を残高ツールとして選ぶ", () => {
    const selected = findRemoteMcpCreditTool([
      { name: "query_membership_and_credits", inputSchemaJson: "{}" },
      { name: "generate_video", description: "Costs credits", inputSchemaJson: "{}" },
    ]);

    expect(selected?.name).toBe("query_membership_and_credits");
  });

  it("TopView は利用ログでなく現在の残高ツールを選ぶ", () => {
    const selected = findRemoteMcpCreditTool([
      { name: "topview_list_credit_logs", inputSchemaJson: "{}" },
      { name: "topview_get_credit", inputSchemaJson: "{}" },
    ]);

    expect(selected?.name).toBe("topview_get_credit");
  });

  it("Kling は説明文だけに credits がある先頭ツールより名前に credits があるツールを優先する", () => {
    const selected = findRemoteMcpCreditTool([
      {
        name: "query_tasks",
        description: "Query the task status. Insufficient credits are reported when charged credits run out.",
        inputSchemaJson: "{}",
      },
      { name: "query_membership_and_credits", inputSchemaJson: "{}" },
    ]);

    expect(selected?.name).toBe("query_membership_and_credits");
  });

  it("TopView は説明文だけに credits がある先頭ツールより名前に credit があるツールを優先する", () => {
    const selected = findRemoteMcpCreditTool([
      {
        name: "topview_get_generation_config",
        description: "Get the generation config. Submit performs the normal model-price credit check.",
        inputSchemaJson: "{}",
      },
      { name: "topview_get_credit", inputSchemaJson: "{}" },
    ]);

    expect(selected?.name).toBe("topview_get_credit");
  });

  it("実測済み4社の既存残高ツールを単独一覧でも選ぶ", () => {
    const tools = [
      { name: "get_credits", inputSchemaJson: "{}" },
      { name: "account_balance", inputSchemaJson: "{}" },
      { name: "identity_balance", inputSchemaJson: "{}" },
      {
        name: "openart_account_get",
        description: "Get the authenticated OpenArt account summary and remaining credit balance.",
        inputSchemaJson: "{}",
      },
    ];

    for (const tool of tools) {
      expect(findRemoteMcpCreditTool([tool])?.name).toBe(tool.name);
    }
  });

  it("Pollo は購入カードでなく account_status を残高ツールに選ぶ", () => {
    const selected = findRemoteMcpCreditTool([
      {
        name: "pollo_show_plans_and_credits",
        description: "Open the Pollo plans-and-credits card. Call this whenever the user asks to buy or top up credits, upgrade or change plan, how to pay, or where to see pricing.",
        inputSchemaJson: "{}",
      },
      {
        name: "pollo_account_status",
        description: "Get the Pollo account overview: identity, available credit balance, and subscription summary.",
        inputSchemaJson: "{}",
      },
    ]);

    // plans は購入案内で数値を返さないため、実残高を返す account_status を採用する。
    expect(selected?.name).toBe("pollo_account_status");
  });

  it("Krea の購入案内 show_plans だけなら残高ツールなしにする", () => {
    const selected = findRemoteMcpCreditTool([
      {
        name: "show_plans",
        description: "Show Krea plans with pricing, monthly credits, and feature comparison.",
        inputSchemaJson: "{}",
      },
    ]);

    // plans は残高照会ではなく購入案内なので、残高ピルを表示しない。
    expect(selected).toBeNull();
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
