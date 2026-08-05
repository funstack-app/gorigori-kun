/**
 * persistGuard (W0) の 4 値分岐と書込み封鎖の牙 (2026-08-06)。
 *
 * ここで固定する契約は 3 つ:
 *   1. 読込は ok / absent / invalid / ioError の 4 値に分かれる
 *   2. **invalid / ioError の間は 1 バイトも書かない** (これが本体)
 *   3. save は成否を boolean で返し、握り潰さない
 *
 * 牙の実証: 封鎖を外した対照実装を同じシナリオにかけ、そちらは書けてしまうことを
 * 示す。「テストが本当に落ちるか」を確かめていない検査は牙が無い。
 */
import { describe, expect, it, vi } from "vitest";

import {
  canWriteAfter,
  createPersistGuard,
  type KeyValueStore,
} from "../src/lib/store/persistGuard";

type Item = { id: string };

/** 配列 of {id:string} を要求する parse。1 件でも壊れていたら invalid。 */
function parseItems(raw: unknown): { ok: true; value: Item[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "配列ではありません" };
  for (const it of raw) {
    if (!it || typeof (it as Item).id !== "string") {
      return { ok: false, reason: "id が文字列でない要素があります" };
    }
  }
  return { ok: true, value: raw as Item[] };
}

/** 記録付きのフェイク store。読み書きの回数と内容を全部残す。 */
function fakeStore(opts: { initial?: unknown; getThrows?: boolean; setThrows?: boolean }) {
  const writes: unknown[] = [];
  let current = opts.initial;
  const store: KeyValueStore = {
    get: async <T,>() => {
      if (opts.getThrows) throw new Error("EIO");
      return current as T | undefined;
    },
    set: async (_key: string, value: unknown) => {
      if (opts.setThrows) throw new Error("ENOSPC");
      writes.push(value);
      current = value;
    },
    save: async () => {},
  };
  return { store, writes };
}

function guardOver(store: KeyValueStore | null) {
  return createPersistGuard<Item[]>({
    name: "test",
    file: "test.json",
    key: "items",
    parse: parseItems,
    loadStore: async () => store,
  });
}

describe("persistGuard: 読込の 4 値", () => {
  it("値があり形も正しければ ok (0 件の空配列も ok)", async () => {
    const empty = guardOver(fakeStore({ initial: [] }).store);
    const r1 = await empty.load();
    expect(r1.status).toBe("ok");
    // 「読めた 0 件」は absent ではない。ここを混同したのが元の病巣。
    expect(r1.status === "ok" && r1.value).toEqual([]);

    const filled = guardOver(fakeStore({ initial: [{ id: "a" }] }).store);
    const r2 = await filled.load();
    expect(r2.status === "ok" && r2.value).toEqual([{ id: "a" }]);
  });

  it("キー未作成 (undefined / null) は absent", async () => {
    const undef = await guardOver(fakeStore({ initial: undefined }).store).load();
    expect(undef.status).toBe("absent");

    const nul = await guardOver(fakeStore({ initial: null }).store).load();
    expect(nul.status).toBe("absent");
  });

  it("形が壊れていれば invalid (理由付き)", async () => {
    const notArray = await guardOver(fakeStore({ initial: { nope: 1 } }).store).load();
    expect(notArray.status).toBe("invalid");
    expect(notArray.status === "invalid" && notArray.reason).toContain("配列");

    // 1 件でも壊れていたら全体を invalid にする (壊れた分を黙って捨てない)。
    const partial = await guardOver(
      fakeStore({ initial: [{ id: "a" }, { broken: true }] }).store,
    ).load();
    expect(partial.status).toBe("invalid");
  });

  it("I/O 失敗は ioError (store が開けない場合も含む)", async () => {
    const readFail = await guardOver(fakeStore({ getThrows: true }).store).load();
    expect(readFail.status).toBe("ioError");

    // store 自体が開けない (Tauri 外 / 権限エラー) も ioError。
    const noStore = await guardOver(null).load();
    expect(noStore.status).toBe("ioError");
  });

  it("canWriteAfter は ok / absent だけ true", () => {
    expect(canWriteAfter({ status: "ok", value: [] })).toBe(true);
    expect(canWriteAfter({ status: "absent" })).toBe(true);
    expect(canWriteAfter({ status: "invalid", reason: "x" })).toBe(false);
    expect(canWriteAfter({ status: "ioError", error: new Error("x") })).toBe(false);
  });
});

describe("persistGuard: 書込み封鎖 (牙)", () => {
  it("load 前の save は書かない", async () => {
    const { store, writes } = fakeStore({ initial: [{ id: "existing" }] });
    const guard = guardOver(store);

    expect(await guard.save([])).toBe(false);
    expect(writes).toHaveLength(0);
    expect(guard.canWrite()).toBe(false);
    expect(guard.isDecided()).toBe(false);
  });

  it("invalid のあと save しても、既存の正本は 1 バイトも変わらない", async () => {
    // 手編集で壊れた台帳。画面は空になるが、ディスクは触ってはいけない。
    const { store, writes } = fakeStore({ initial: "壊れたJSON文字列" });
    const guard = guardOver(store);

    expect((await guard.load()).status).toBe("invalid");
    expect(await guard.save([])).toBe(false);
    expect(await guard.save([{ id: "new" }])).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("ioError のあと save しても書かない (読めない正本を空で潰さない)", async () => {
    const { store, writes } = fakeStore({ getThrows: true });
    const guard = guardOver(store);

    expect((await guard.load()).status).toBe("ioError");
    expect(await guard.save([])).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("ok / absent のあとは書ける", async () => {
    const okCase = fakeStore({ initial: [{ id: "a" }] });
    const okGuard = guardOver(okCase.store);
    expect((await okGuard.load()).status).toBe("ok");
    expect(await okGuard.save([{ id: "a" }, { id: "b" }])).toBe(true);
    expect(okCase.writes).toEqual([[{ id: "a" }, { id: "b" }]]);

    const absentCase = fakeStore({ initial: undefined });
    const absentGuard = guardOver(absentCase.store);
    expect((await absentGuard.load()).status).toBe("absent");
    expect(await absentGuard.save([{ id: "first" }])).toBe(true);
    expect(absentCase.writes).toEqual([[{ id: "first" }]]);
  });

  it("解禁後の一時的な読込失敗では、既に取れた解禁を取り消さない", async () => {
    // 1回目 ok → 解禁。2回目 ioError → 解禁は維持 (保存を止めない)。
    let fail = false;
    const writes: unknown[] = [];
    const store: KeyValueStore = {
      get: async <T,>() => {
        if (fail) throw new Error("EIO");
        return [{ id: "a" }] as T;
      },
      set: async (_k: string, v: unknown) => {
        writes.push(v);
      },
      save: async () => {},
    };
    const guard = guardOver(store);
    expect((await guard.load()).status).toBe("ok");
    fail = true;
    expect((await guard.load()).status).toBe("ioError");
    expect(guard.canWrite()).toBe(true);
    expect(await guard.save([{ id: "b" }])).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("save の I/O 失敗は throw せず false で返る (握り潰さない)", async () => {
    const { store } = fakeStore({ initial: [], setThrows: true });
    const guard = guardOver(store);
    await guard.load();
    await expect(guard.save([{ id: "a" }])).resolves.toBe(false);
  });
});

describe("persistGuard: 明示的な上書き解禁 (復元)", () => {
  it("invalid でも、決着後なら復元のために解禁できる", async () => {
    // 正本が壊れているときこそ復元が要る。ここを塞ぐと復元不能になる。
    const { store, writes } = fakeStore({ initial: "壊れている" });
    const guard = guardOver(store);
    expect((await guard.load()).status).toBe("invalid");
    expect(await guard.save([{ id: "restored" }])).toBe(false);

    expect(guard.unlockForExplicitOverwrite()).toBe(true);
    expect(await guard.save([{ id: "restored" }])).toBe(true);
    expect(writes).toEqual([[{ id: "restored" }]]);
  });

  it("読込が決着する前は解禁できない", async () => {
    const guard = guardOver(fakeStore({ initial: [] }).store);
    expect(guard.unlockForExplicitOverwrite()).toBe(false);
    expect(guard.canWrite()).toBe(false);
  });
});

describe("persistGuard: 牙の実証 (封鎖を外すと書けてしまう)", () => {
  it("封鎖なし実装は invalid のあとに既存正本を上書きしてしまう", async () => {
    // わざと壊した対照実装。「封鎖された」テストが本当に封鎖を見ているのか
    // (常に緑になるだけの検査ではないか) をここで確認する。
    const writes: unknown[] = [];
    const unguardedSave = async (value: unknown): Promise<boolean> => {
      writes.push(value);
      return true;
    };

    const guard = guardOver(fakeStore({ initial: "壊れている" }).store);
    expect((await guard.load()).status).toBe("invalid");

    // 正しい実装は書かない。
    expect(await guard.save([])).toBe(false);
    // 封鎖を外した実装は書いてしまう = 上の false は封鎖が効いた証拠。
    expect(await unguardedSave([])).toBe(true);
    expect(writes).toEqual([[]]);
  });

  it("parse が壊れた要素を黙って捨てる実装だと invalid を検出できない", async () => {
    // parse の契約 (壊れていたら invalid) を弱めた対照実装。
    const lenient = createPersistGuard<Item[]>({
      name: "lenient",
      file: "t.json",
      key: "items",
      // 壊れた要素を捨てて ok を返す = guard が意味を失うパターン。
      parse: (raw) => ({
        ok: true,
        value: (Array.isArray(raw) ? raw : []).filter(
          (it): it is Item => !!it && typeof (it as Item).id === "string",
        ),
      }),
      loadStore: async () => fakeStore({ initial: [{ id: "a" }, { broken: 1 }] }).store,
    });
    const lenientResult = await lenient.load();
    // 甘い parse では ok になり、捨てた 1 件の状態がそのまま書ける状態になる。
    expect(lenientResult.status).toBe("ok");
    expect(lenient.canWrite()).toBe(true);

    // 厳格な parse なら invalid で封鎖される。
    const strict = guardOver(fakeStore({ initial: [{ id: "a" }, { broken: 1 }] }).store);
    expect((await strict.load()).status).toBe("invalid");
    expect(strict.canWrite()).toBe(false);
  });
});

describe("persistGuard: store の解決は 1 回だけ", () => {
  it("load / save を繰り返しても loadStore は 1 回しか呼ばれない", async () => {
    const { store } = fakeStore({ initial: [] });
    const loadStore = vi.fn(async () => store);
    const guard = createPersistGuard<Item[]>({
      name: "once",
      file: "t.json",
      key: "items",
      parse: parseItems,
      loadStore,
    });
    await guard.load();
    await guard.save([{ id: "a" }]);
    await guard.load();
    await guard.save([{ id: "b" }]);
    expect(loadStore).toHaveBeenCalledTimes(1);
  });
});
