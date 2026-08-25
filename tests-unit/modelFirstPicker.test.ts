import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REMOTE_MCP_CATALOG_MAX_AGE_MS,
  ensureRemoteMcpToolsAvailable,
  isCatalogStale,
  isRemoteMcpCatalogModelSelectable,
  remoteMcpCatalogErrorMessage,
  remoteMcpDisconnectedMessage,
  type RemoteMcpModelCatalog,
} from "../src/lib/remoteMcpModels";

const CACHE_KEY = "gori.remoteMcp.modelCatalogs.v1";

function catalog(
  providerId: string,
  options: { fetchedAt?: number; schema?: string; models?: string[] } = {},
): RemoteMcpModelCatalog {
  return {
    providerId,
    providerLabel: providerId,
    kind: "video",
    source: "catalog",
    generationTool: {
      name: "video_generate",
      inputSchemaJson: options.schema ?? "{}",
    },
    models: (options.models ?? ["model-1"]).map((id) => ({
      id,
      name: id,
      kind: "video",
      passModel: true,
    })),
    fetchedAt: options.fetchedAt,
  };
}

describe("モデルが主役のピッカー", () => {
  beforeEach(() => localStorage.clear());

  it("入力形式が空でも、一覧にあるモデルは選択できる", () => {
    const schemaLess = catalog("krea", { schema: "" });
    expect(isRemoteMcpCatalogModelSelectable(schemaLess, "model-1")).toBe(true);
    expect(isRemoteMcpCatalogModelSelectable(schemaLess, "missing-model")).toBe(false);
  });

  it("取得から24時間を超えた一覧だけを古いと判定する", () => {
    const now = Date.UTC(2026, 7, 25, 12);
    expect(
      isCatalogStale(
        catalog("krea", { fetchedAt: now - REMOTE_MCP_CATALOG_MAX_AGE_MS }),
        now,
      ),
    ).toBe(false);
    expect(
      isCatalogStale(
        catalog("krea", { fetchedAt: now - REMOTE_MCP_CATALOG_MAX_AGE_MS - 1 }),
        now,
      ),
    ).toBe(true);
    expect(isCatalogStale(catalog("krea"), now)).toBe(true);
  });

  it("認証切れと0件取得を、接続先名入りの再接続案内にする", () => {
    expect(remoteMcpCatalogErrorMessage("Krea", "invalid_grant")).toBe(
      "Kreaの接続が切れています。設定から再接続してください。",
    );
    expect(() => ensureRemoteMcpToolsAvailable("Krea", [])).toThrow(
      remoteMcpDisconnectedMessage("Krea"),
    );
    expect(remoteMcpDisconnectedMessage("Krea")).toContain("設定 → 接続先");
    expect(remoteMcpDisconnectedMessage("Krea")).toContain("再接続してください");
  });

  it("モデル0件の保存データを起動時に捨てる", async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        "krea:video": catalog("krea", { models: [] }),
        "runway:video": catalog("runway"),
      }),
    );

    const { useRemoteMcpGen } = await import("../src/lib/store/remoteMcpGen");
    expect(useRemoteMcpGen.getState().modelCatalogs["krea:video"]).toBeUndefined();
    expect(useRemoteMcpGen.getState().modelCatalogs["runway:video"]?.models).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}")["krea:video"]).toBeUndefined();
  });

  it("再接続後にRust側と画面側の対象キャッシュだけを無効化する", async () => {
    const { remoteMcp } = await import("../src/lib/ipc");
    const invalidateToolsCache = vi
      .spyOn(remoteMcp, "invalidateToolsCache")
      .mockResolvedValue(null);
    const { invalidateRemoteMcpProviderCache, useRemoteMcpGen } = await import(
      "../src/lib/store/remoteMcpGen"
    );
    useRemoteMcpGen.getState().setModelCatalog("krea:video", catalog("krea"));
    useRemoteMcpGen.getState().setModelCatalog("krea:image", {
      ...catalog("krea"),
      kind: "image",
      models: [{ id: "image-1", name: "image-1", kind: "image", passModel: true }],
    });
    useRemoteMcpGen.getState().setModelCatalog("runway:video", catalog("runway"));

    await invalidateRemoteMcpProviderCache("krea");

    expect(invalidateToolsCache).toHaveBeenCalledWith("krea");
    expect(Object.keys(useRemoteMcpGen.getState().modelCatalogs)).toEqual(["runway:video"]);
    expect(Object.keys(JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"))).toEqual([
      "runway:video",
    ]);
  });
});
