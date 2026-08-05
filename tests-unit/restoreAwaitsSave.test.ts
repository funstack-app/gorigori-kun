/**
 * バックアップ復元は「保存完了を待ってから成功と言う」(W2 / 2026-08-06)。
 *
 * Sol 監査 DL-06 / DL-08 の指摘: 復元が `persist()` を待たずに画面だけ更新し、
 * 成功扱いで返していた。ディスクへの書き込みが失敗しても
 * 「バックアップから N 件を復元しました」と表示され、再起動で元へ戻る
 * = ユーザーは復元できたと信じたまま、いちばん失いたくない場面で失う。
 *
 * ここで固定する契約:
 *   1. 書き込みが成功したときだけ成功として返る
 *   2. 書き込みが失敗したら throw し、**画面も復元前へ戻す**
 *      (画面だけ復元済みに見える状態を残さない)
 *
 * setup.ts の afterEach (clearMocks + resetModules) で隔離され、
 * mockIPC を仕込んでから動的 import する (ストアはモジュール変数を持つため)。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  localStorage.clear();
});

/** projects.json のバックアップ内容 (件数だけが要点)。 */
function projectsBackup(count: number): string {
  const now = Date.now();
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `b${i}`,
      name: `復元プロジェクト${i}`,
      status: "active",
      items: [],
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/** presets.json のバックアップ内容。 */
function presetsBackup(count: number): string {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    categories: [{ id: "characters", name: "キャラクター", color: "#f472b6" }],
    presets: Array.from({ length: count }, (_, i) => ({
      id: `bp${i}`,
      name: `復元プリセット${i}`,
      prompt: "p",
      categoryId: "characters",
      favorite: false,
      createdAt: now,
      updatedAt: now,
    })),
  });
}

describe("projects.restoreFromBackup: 保存完了を待つ (DL-06)", () => {
  it("書き込みが失敗したら throw し、画面も復元前へ戻す", async () => {
    mockIPC((cmd) => {
      if (cmd === "projects_read") return JSON.stringify([]);
      if (cmd === "projects_read_backup") return projectsBackup(5);
      if (cmd === "projects_write") {
        throw new Error("Read-only file system");
      }
      return null;
    });
    const { useProjects } = await import("../src/lib/store/projects");
    await useProjects.getState().initialize();

    const before = useProjects.getState().projects;

    await expect(
      useProjects.getState().restoreFromBackup("/backup/projects.json.bak-1"),
    ).rejects.toThrow(/書き込め|復元は取り消し/);

    // 画面だけ復元済みに見える状態を残さない。
    expect(useProjects.getState().projects).toEqual(before);
  });

  it("書き込みが成功したら件数を返し、画面も復元後になる", async () => {
    const writes: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "projects_read") return JSON.stringify([]);
      if (cmd === "projects_read_backup") return projectsBackup(5);
      if (cmd === "projects_write") {
        writes.push((args as { content: string }).content);
        return null;
      }
      return null;
    });
    const { useProjects } = await import("../src/lib/store/projects");
    await useProjects.getState().initialize();

    const restored = await useProjects
      .getState()
      .restoreFromBackup("/backup/projects.json.bak-1");

    expect(restored).toBe(5);
    expect(useProjects.getState().projects).toHaveLength(5);
    // 「成功」と言う前に実際にディスクへ書いている。
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe("presets.restoreFromBackup: 保存完了を待つ (DL-08)", () => {
  it("書き込みが失敗したら throw し、画面も復元前へ戻す", async () => {
    mockIPC((cmd) => {
      if (cmd === "presets_read") return "";
      if (cmd === "presets_read_backup") return presetsBackup(30);
      if (cmd === "presets_write") {
        throw new Error("Read-only file system");
      }
      return null;
    });
    const { usePresets } = await import("../src/lib/store/presets");
    await usePresets.getState().initialize();

    const before = usePresets.getState().presets;

    await expect(
      usePresets.getState().restoreFromBackup("/backup/presets.json.bak-1"),
    ).rejects.toThrow(/書き込め|復元は取り消し/);

    expect(usePresets.getState().presets).toEqual(before);
    // 失敗した復元が localStorage の冗長バックアップにも残っていないこと。
    // 残ると次回起動の「多い方を勝たせる」判定が、取り消したはずの復元を蘇らせる。
    const ls = JSON.parse(localStorage.getItem("presets.presets") ?? "[]");
    expect(ls).toHaveLength(before.length);
  });

  it("書き込みが成功したら件数を返し、画面も復元後になる", async () => {
    const writes: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "presets_read") return "";
      if (cmd === "presets_read_backup") return presetsBackup(30);
      if (cmd === "presets_write") {
        writes.push((args as { content: string }).content);
        return null;
      }
      return null;
    });
    const { usePresets } = await import("../src/lib/store/presets");
    await usePresets.getState().initialize();

    const restored = await usePresets
      .getState()
      .restoreFromBackup("/backup/presets.json.bak-1");

    expect(restored).toBe(30);
    expect(usePresets.getState().presets).toHaveLength(30);
    expect(writes.length).toBeGreaterThan(0);
    // localStorage の冗長バックアップも復元後になっている。
    const ls = JSON.parse(localStorage.getItem("presets.presets") ?? "[]");
    expect(ls).toHaveLength(30);
  });
});
