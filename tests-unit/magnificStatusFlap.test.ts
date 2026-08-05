import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

type Status = { registered: boolean; authenticated: boolean };

function seq(items: (Status | "throw")[]) {
  let i = 0;
  mockIPC((cmd) => {
    if (cmd === "magnific_status") {
      const n = items[Math.min(i, items.length - 1)];
      i += 1;
      if (n === "throw") throw new Error("spawn failed");
      return n;
    }
    if (cmd === "higgsfield_mcp_status") return { registered: false, authenticated: false };
    return null;
  });
}

async function stores() {
  const { useAccounts } = await import("../src/lib/store/accounts");
  const { useMagnificModel } = await import("../src/lib/store/magnificModel");
  return { useAccounts, useMagnificModel };
}

describe("magnific flap", () => {
  // jsdom の localStorage はテスト間で残るため、選択状態を毎回初期化する。
  beforeEach(() => localStorage.clear());

  it("transient authenticated:false keeps the selection", async () => {
    seq([{ registered: true, authenticated: true }, { registered: true, authenticated: false }]);
    const { useAccounts, useMagnificModel } = await stores();
    useMagnificModel.getState().toggleModel("flux-2");
    await useAccounts.getState().refreshMagnific();
    await useAccounts.getState().refreshMagnific();
    expect(useAccounts.getState().magnific.authenticated).toBe(false);
    expect(useMagnificModel.getState().selectedModels).toEqual(["flux-2"]);
  });

  it("status throw keeps the selection", async () => {
    seq([{ registered: true, authenticated: true }, "throw"]);
    const { useAccounts, useMagnificModel } = await stores();
    useMagnificModel.getState().toggleModel("seedream-4-5");
    await useAccounts.getState().refreshMagnific();
    await useAccounts.getState().refreshMagnific();
    expect(useMagnificModel.getState().selectedModels).toEqual(["seedream-4-5"]);
  });

  it("genuine unregister still clears", async () => {
    seq([{ registered: true, authenticated: true }, { registered: false, authenticated: false }]);
    const { useAccounts, useMagnificModel } = await stores();
    useMagnificModel.getState().toggleModel("mystic-2-5");
    await useAccounts.getState().refreshMagnific();
    await useAccounts.getState().refreshMagnific();
    expect(useMagnificModel.getState().selectedModels).toEqual([]);
  });
});
