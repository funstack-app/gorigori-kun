/**
 * バックアップ一覧の「取得失敗」と「0件」の区別 (2026-08-06 / U3)。
 *
 * 背景 (実害): listBackups は catch → `[]` を返していた。そのため保存先が
 * 読めないとき (外付けドライブ未接続 / 権限エラー / クラウド同期の不達) にも
 * 「まだバックアップがありません」と表示され、**復元がいちばん必要な故障時に
 * 原因が消える**どころか「無い」と誤って断言していた。
 *
 * ここでは (a) 取得失敗が ok:false になること (b) 0件は ok:true のまま
 * 空配列であること (c) 両者が型で区別されること を固定する。
 *
 * setup.ts の afterEach が clearMocks + resetModules するので、各テストは
 * **mockIPC を仕込んでから動的 import** する (presets.ts 側の既存テストと同じ作法)。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vitest";

import {
  formatRelativeAge,
  summarizeBackupHealth,
  toBackupListResult,
} from "../src/lib/store/backupHealth";

describe("toBackupListResult", () => {
  it("取得に失敗したら ok:false で理由を持つ (空配列に畳まない)", async () => {
    const result = await toBackupListResult(async () => {
      throw new Error("保存先に接続できません");
    }, "test");

    expect(result.ok).toBe(false);
    // 「0件」と誤読される余地が無いこと
    expect(result).not.toHaveProperty("items");
    if (!result.ok) {
      expect(result.error).toContain("保存先に接続できません");
    }
  });

  it("0件は ok:true + 空配列 (正常な『まだ無い』)", async () => {
    const result = await toBackupListResult(async () => [], "test");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual([]);
  });

  it("取得できたらそのまま items に載る", async () => {
    const rows = [{ path: "/tmp/a.bak-1", at: 1_700_000_000_000, count: 3 }];
    const result = await toBackupListResult(async () => rows, "test");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toEqual(rows);
  });
});

describe("presets ストアの listBackups", () => {
  it("IPC が失敗したら ok:false を返す (『バックアップがありません』にしない)", async () => {
    mockIPC(async (cmd) => {
      if (cmd === "presets_list_backups") {
        throw new Error("os error 13: Permission denied");
      }
      return null;
    });

    const { usePresets } = await import("../src/lib/store/presets");
    const result = await usePresets.getState().listBackups();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });

  it("IPC が空を返したら ok:true + 0件", async () => {
    mockIPC(async (cmd) => {
      if (cmd === "presets_list_backups") return [];
      return null;
    });

    const { usePresets } = await import("../src/lib/store/presets");
    const result = await usePresets.getState().listBackups();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(0);
  });
});

describe("summarizeBackupHealth (U4 の表示元)", () => {
  it("取得失敗は failed:true になり、世代数を 0 と偽らない", () => {
    const health = summarizeBackupHealth({ ok: false, error: "接続できません" });

    expect(health.failed).toBe(true);
    // 「0世代」と誤表示しないこと。ここが 0 だと『守られていない』と誤読される
    expect(health.generations).toBeNull();
    expect(health.latestAt).toBeNull();
  });

  it("0件は failed:false / generations:0 (正常だが目立たせる対象)", () => {
    const health = summarizeBackupHealth({ ok: true, items: [] });

    expect(health.failed).toBe(false);
    expect(health.generations).toBe(0);
    expect(health.latestAt).toBeNull();
  });

  it("最新の at を latestAt として拾う", () => {
    const health = summarizeBackupHealth({
      ok: true,
      items: [{ at: 300 }, { at: 100 }, { at: 200 }],
    });

    expect(health.failed).toBe(false);
    expect(health.generations).toBe(3);
    expect(health.latestAt).toBe(300);
  });
});

describe("formatRelativeAge", () => {
  // now を引数で渡す (実行時刻をテストにハードコードしない)
  const now = 1_700_000_000_000;

  it("経過時間を人間向けに畳む", () => {
    expect(formatRelativeAge(now - 30_000, now)).toBe("たった今");
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe("5分前");
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe("3時間前");
    expect(formatRelativeAge(now - 2 * 24 * 3_600_000, now)).toBe("2日前");
  });

  it("未来の時刻でも負にならない", () => {
    expect(formatRelativeAge(now + 60_000, now)).toBe("たった今");
  });
});
