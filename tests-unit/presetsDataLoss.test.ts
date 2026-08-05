/**
 * プリセット消失の確定原因に対する回帰テスト (2026-08-06)。
 *
 * 背景 (実ユーザー被害): v2.4.x 時代の 30 体が localStorage のみに存在する状態で
 * v2.5.1 が初回起動し、
 *   1. 初回移行のファイル書き込みが失敗したのに**成功扱い**で書き込みが解禁され (S2)
 *   2. 起動 5 秒後の自動掃除が localStorage の実体を削除し (S1・Rust 側でテスト)
 *   3. 再起動時、0 件のファイルが**無条件に正本として採用**されて確定した (S3)
 * という合成経路で 30 体が 0 件になった。
 *
 * ここでは TypeScript 側の S2 / S3 を固定する。S1 / S4 は Rust 側
 * (storage_cleanup.rs / commands/storage.rs の #[cfg(test)]) が担当する。
 *
 * setup.ts の afterEach が clearMocks + resetModules するので、各テストは
 * **mockIPC を仕込んでから動的 import** する (presets.ts は fileWriteUnlocked 等を
 * モジュール変数で持つため、静的 import すると前テストの状態を引き継ぐ)。
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";

type PresetsModule = typeof import("../src/lib/store/presets");

const PRESETS_LS_KEY = "presets.presets";

/** localStorage に「バックアップとして生き残っている」プリセットを仕込む。 */
function seedLocalStorage(count: number) {
  const now = Date.now();
  const presets = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    name: `プリセット${i}`,
    prompt: `prompt ${i}`,
    categoryId: "character",
    favorite: false,
    createdAt: now,
    updatedAt: now,
  }));
  localStorage.setItem(PRESETS_LS_KEY, JSON.stringify(presets));
}

/** presets.json の中身を組み立てる (件数だけが要点)。 */
function fileContent(count: number): string {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    categories: [{ id: "character", name: "キャラクター" }],
    presets: Array.from({ length: count }, (_, i) => ({
      id: `f${i}`,
      name: `ファイル${i}`,
      prompt: `file prompt ${i}`,
      categoryId: "character",
      favorite: false,
      createdAt: now,
      updatedAt: now,
    })),
  });
}

/** mockIPC 登録後に presets ストアを新規 import する。 */
async function loadPresetsStore(): Promise<PresetsModule> {
  return (await import("../src/lib/store/presets")) as PresetsModule;
}

beforeEach(() => {
  localStorage.clear();
});

describe("S2: 移行の書き込み失敗を成功扱いにしない", () => {
  it("presets_write が失敗したら、その後の保存はファイルへ流れない", async () => {
    seedLocalStorage(30);

    const writes: string[] = [];
    let writeShouldFail = true;
    mockIPC((cmd, args) => {
      if (cmd === "presets_read") return ""; // ファイル未作成 = 移行経路へ入る
      if (cmd === "presets_write") {
        if (writeShouldFail) {
          // ディスク不調・権限不足等で保存先ファイルを作れないケース。
          throw new Error("presets.json リネーム失敗: Read-only file system");
        }
        writes.push((args as { content: string }).content);
        return null;
      }
      return null;
    });

    const { usePresets } = await loadPresetsStore();
    await usePresets.getState().initialize();

    // 移行が失敗しているので、以後の mutate はファイルへ書かれてはならない。
    // (書き込みが解禁されていたら、この addPreset がファイルへ流れる)
    writeShouldFail = false;
    usePresets.getState().addPreset({
      name: "移行失敗後の追加",
      prompt: "x",
      categoryId: "character",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(
      writes,
      "移行に失敗したのに書き込みが解禁されている (成功扱いの握り潰し)",
    ).toHaveLength(0);

    // localStorage 側には残っている = データ自体は失われていない。
    const stored = JSON.parse(localStorage.getItem(PRESETS_LS_KEY) ?? "[]");
    expect(stored.length).toBe(31); // 元の30 + 追加1
  });

  it("presets_write が成功したら、その後の保存はファイルへ流れる (誤って塞いでいない)", async () => {
    seedLocalStorage(30);

    const writes: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "presets_read") return "";
      if (cmd === "presets_write") {
        writes.push((args as { content: string }).content);
        return null;
      }
      return null;
    });

    const { usePresets } = await loadPresetsStore();
    await usePresets.getState().initialize();

    expect(writes.length, "移行の書き込みが行われていない").toBeGreaterThan(0);
    const migrated = JSON.parse(writes[0]);
    expect(migrated.presets).toHaveLength(30);

    const before = writes.length;
    usePresets.getState().addPreset({
      name: "移行成功後の追加",
      prompt: "y",
      categoryId: "character",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(
      writes.length,
      "移行成功後なのにファイルへ書かれていない (過剰に塞いでいる)",
    ).toBeGreaterThan(before);
  });
});

describe("S3: ファイルが少ないときバックアップを正とする", () => {
  it("ファイル0件・localStorage30件なら30件が勝ち、ファイルへ書き戻される", async () => {
    seedLocalStorage(30);

    const writes: string[] = [];
    mockIPC((cmd, args) => {
      // 移行が失敗した後の再起動を再現: ファイルは存在するが 0 件。
      if (cmd === "presets_read") return fileContent(0);
      if (cmd === "presets_write") {
        writes.push((args as { content: string }).content);
        return null;
      }
      return null;
    });

    const { usePresets } = await loadPresetsStore();
    await usePresets.getState().initialize();

    expect(
      usePresets.getState().presets,
      "0件のファイルが30件のバックアップを潰した (無条件の正本採用)",
    ).toHaveLength(30);

    // 復元内容がファイルへ書き戻されている (次回起動で再び 0 件に戻らない)。
    expect(writes.length, "復元がファイルへ書き戻されていない").toBeGreaterThan(0);
    const restored = JSON.parse(writes[writes.length - 1]);
    expect(restored.presets).toHaveLength(30);
  });

  it("ファイル30件・localStorage2件ならファイルが勝つ (通常の正本採用を壊さない)", async () => {
    seedLocalStorage(2);

    mockIPC((cmd) => {
      if (cmd === "presets_read") return fileContent(30);
      if (cmd === "presets_write") return null;
      return null;
    });

    const { usePresets } = await loadPresetsStore();
    await usePresets.getState().initialize();

    const presets = usePresets.getState().presets;
    expect(presets, "ファイルが正本として採用されていない").toHaveLength(30);
    expect(presets[0].id.startsWith("f"), "localStorage 側が誤って勝っている").toBe(
      true,
    );
  });

  it("ファイルとlocalStorageが同数ならファイルが勝つ (復元を誤発火させない)", async () => {
    seedLocalStorage(5);

    mockIPC((cmd) => {
      if (cmd === "presets_read") return fileContent(5);
      if (cmd === "presets_write") return null;
      return null;
    });

    const { usePresets } = await loadPresetsStore();
    await usePresets.getState().initialize();

    const presets = usePresets.getState().presets;
    expect(presets).toHaveLength(5);
    expect(presets[0].id.startsWith("f"), "同数なのに復元が発火している").toBe(true);
  });
});
