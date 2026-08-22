import { describe, expect, it } from "vitest";

import {
  parseAssetLedgerResponse,
  validateAssetLedger,
} from "../src/lib/film/assetParse";
import type { AssetLedgerEntry } from "../src/lib/film/types";

const VALID_LEDGER = `| ID | 名称 | 種別 | 重要度 | 登場ブロック |
|---|---|---|---|---|
| CH-01 | 美咲 | キャラ | 主要 | B1, B2 |
| LO-01 | 駅前広場 | ロケ | 準 | B1 |
| PR-01 | 白い封筒 | 小道具 | 主要 | B1、B2 |
| TX-01 | 封筒の宛名 | 文字物 | 背景 | B2 |`;

function asset(overrides: Partial<AssetLedgerEntry> = {}): AssetLedgerEntry {
  return {
    id: "CH-01",
    name: "美咲",
    type: "character",
    importance: "primary",
    blockIds: ["B1"],
    status: "unplanned",
    pairKey: null,
    pairSide: null,
    ...overrides,
  };
}

describe("アセット台帳パーサ", () => {
  it("強制書式を種別・重要度・B番号つきの構造へ変換する", () => {
    const parsed = parseAssetLedgerResponse(VALID_LEDGER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value).toHaveLength(4);
    expect(parsed.value[0]).toMatchObject({
      id: "CH-01",
      name: "美咲",
      type: "character",
      importance: "primary",
      blockIds: ["B1", "B2"],
    });
    expect(parsed.value[3]).toMatchObject({ id: "TX-01", type: "text" });
  });

  it("壊れた応答を黙って捨てず、失敗位置と理由を返す", () => {
    const broken = VALID_LEDGER.replace("| PR-01 | 白い封筒 | 小道具 |", "| PR-01 | 白い封筒 | 備品 |");
    const parsed = parseAssetLedgerResponse(broken);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    expect(parsed.error.line).toBe(5);
    expect(parsed.error.column).toBeGreaterThan(1);
    expect(parsed.error.sourceLine).toContain("備品");
    expect(parsed.error.reason).toContain("種別");
  });
});

describe("アセット台帳検算の牙", () => {
  it("ID重複で発火し、異なるIDでは発火しない", () => {
    expect(validateAssetLedger([asset(), asset()], ["B1"])).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate-id", location: "CH-01" })]),
    );
    expect(validateAssetLedger([asset(), asset({ id: "CH-02" })], ["B1"])).toHaveLength(0);
  });

  it("種別とID接頭辞の不一致で発火し、一致時は発火しない", () => {
    expect(validateAssetLedger([asset({ type: "location" })], ["B1"])).toEqual([
      expect.objectContaining({ code: "type-prefix-mismatch", location: "CH-01" }),
    ]);
    expect(validateAssetLedger([asset({ id: "LO-01", type: "location" })], ["B1"])).toHaveLength(0);
  });

  it("存在しないB番号で発火し、実在するB番号では発火しない", () => {
    expect(validateAssetLedger([asset({ blockIds: ["B1", "B9"] })], ["B1", "B2"])).toEqual([
      expect.objectContaining({ code: "unknown-block", location: "CH-01:B9" }),
    ]);
    expect(validateAssetLedger([asset({ blockIds: ["B1", "B2"] })], ["B1", "B2"])).toHaveLength(0);
  });
});
