import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REMOTE_MCP_PROVIDERS } from "../src/lib/remoteMcpProviders";

describe("リモート MCP プロバイダレジストリ", () => {
  it("Rust と TypeScript のプロバイダ ID 集合が完全一致する", () => {
    const rustSource = readFileSync(
      "src-tauri/src/commands/remote_mcp.rs",
      "utf8",
    );
    const rustIds = [...rustSource.matchAll(/\bid:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(rustIds, "Rust 側の id 抽出が 0 件なら検査不能").not.toHaveLength(0);

    const rustIdSet = [...new Set(rustIds)].sort();
    const tsIdSet = [...new Set(REMOTE_MCP_PROVIDERS.map((provider) => provider.id))].sort();
    expect(rustIdSet).toEqual(tsIdSet);
  });
});
