/**
 * motionStore の保存先切替競合テスト (u73 2026-08-03)。
 *
 * bd u73 の動機: 「切替中の保存」「切替をまたいだ初期化」「所有権トークン」は
 * invoke の解決タイミングを 1 ステップずつ制御しないと再現できない。E2E では
 * このタイミングを作れないため、Tauri 公式 mockIPC で invoke を握る。
 *
 * 各テストは setup.ts の afterEach (clearMocks + resetModules) で隔離され、
 * **mockIPC を仕込んでから動的 import** する。motionStore は cache / switchEpoch /
 * queueTail をモジュール変数で持つため、静的 import すると前テストの状態を引き継ぐ。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  idsInWrite,
  installMotionsFsMock,
  motionsFileContent,
  type MotionsFsMock,
} from "./helpers/motionsFsMock";

/** motionStore の公開 API (動的 import の戻り値型)。 */
type MotionStore = typeof import("../src/lib/scene3d/motionStore");

/** mockIPC 登録後に motionStore を新規 import する。 */
async function loadMotionStore(): Promise<MotionStore> {
  return (await import("../src/lib/scene3d/motionStore")) as MotionStore;
}

/** GeneratedMotionSpec の最小形 (motionStore は id しか見ない)。 */
function spec(id: string) {
  return { id, source: "test" } as unknown as Parameters<
    MotionStore["saveGeneratedSpec"]
  >[1];
}

/** localStorage に旧形式のモーションを仕込む (初期化前の cache 供給源)。 */
function seedLocalStorage(ids: string[]) {
  localStorage.setItem(
    "scene3d.generatedMotions.v1",
    JSON.stringify(ids.map((id) => ({ id, spec: { id, source: "local" } }))),
  );
}

let fs: MotionsFsMock;

beforeEach(() => {
  localStorage.clear();
});

describe("motionStore: 保存先切替の競合 (u73)", () => {
  it("T1: 初期化でファイル正本が localStorage に勝つ", async () => {
    // localStorage 2 件 / ファイル 1 件。マージ規則は「ベースは常にファイル」で、
    // mutated/removed が空なら cache 由来は 1 件も混ざらない。
    seedLocalStorage(["local-1", "local-2"]);
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["file-1"]) },
    });
    const store = await loadMotionStore();

    // 初期化前は localStorage 由来 (同期初期化)。
    expect(store.loadGeneratedSpecs().map((m) => m.id)).toEqual([
      "local-1",
      "local-2",
    ]);

    await store.initializeGeneratedMotions();

    expect(store.loadGeneratedSpecs().map((m) => m.id)).toEqual(["file-1"]);
    // 読めた内容をそのまま書き戻すことはしない (無変更なら書き込みゼロ)。
    expect(fs.writes).toHaveLength(0);
  });

  it("T2: 切替中の保存は拒否され、ファイルにも cache にも出ない", async () => {
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["file-1"]) },
    });
    const store = await loadMotionStore();
    await store.initializeGeneratedMotions();
    const writesBefore = fs.writes.length;

    await store.beginStorageRootSwitch();

    // 切替中 = rejectDuringSwitch が true を返す窓。
    store.saveGeneratedSpec("during-switch", spec("during-switch"));
    store.removeGeneratedSpec("file-1");
    await store.__test_drainMotionQueue();

    // cache が変化しない (保存も削除も入口で断られている)。
    expect(store.loadGeneratedSpecs().map((m) => m.id)).toEqual(["file-1"]);
    // motions_write が 1 回も増えていない。
    expect(fs.writes).toHaveLength(writesBefore);
  });

  it("T3: 切替前に積まれた書き込みは旧 root へ着地する", async () => {
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["file-1"]) },
    });
    const store = await loadMotionStore();
    await store.initializeGeneratedMotions();

    // 切替前の保存 → キューに積まれる。
    store.saveGeneratedSpec("pre-switch", spec("pre-switch"));
    // begin は「積まれたジョブを流し切ってから」世代を進める (ドレイン)。
    const beginPromise = store.beginStorageRootSwitch();
    // ドレイン完了前に保存先が変わったことにはしない (実際の切替も await 後)。
    await beginPromise;
    fs.setRoot("rootB");

    expect(fs.writes).toHaveLength(1);
    // 旧 root に着地していること = ドレインが効いている証拠。
    expect(fs.writes[0].root).toBe("rootA");
    expect(idsInWrite(fs.writes[0])).toContain("pre-switch");
  });

  it("T4: 切替をまたいだ初期化は破棄され、解禁しない", async () => {
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["file-1"]) },
    });
    const store = await loadMotionStore();

    // motions_read を手動解決にして「読み込み中」の窓を作る。
    const deferred = fs.deferNextRead();
    const initPromise = store.initializeGeneratedMotions();
    // read が発火するまで待つ (キューのデキューはマイクロタスク境界の後)。
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.reads).toHaveLength(1);

    // 読み込み解決前に切替を開始する。begin はキューのドレインを待つので
    // 先に await せず、read を解決してから待つ。
    const switchPromise = store.beginStorageRootSwitch();
    deferred.resolve(motionsFileContent(["file-1"]));
    await initPromise;
    await switchPromise;
    fs.setRoot("rootB");

    // --- 第1段: 切替中は当然拒否される (ここまでは切替フラグの効果) ---
    const writesBefore = fs.writes.length;
    store.saveGeneratedSpec("during", spec("during"));
    await store.__test_drainMotionQueue();
    expect(fs.writes).toHaveLength(writesBefore);

    // --- 第2段: 切替を正しく閉じてから、書込許可の出どころを確かめる ---
    //
    // 第1段だけでは「切替中だから拒否された」としか言えず、**古い初期化が
    // 書込許可を戻していないか**は検査できていなかった (Sol caveat F)。
    // 切替を閉じる = 新 root を読み直す初期化を通す。ここで初めて解禁されるのが
    // 正しい振る舞いで、その前に旧 root の読み込み結果が解禁していたら
    // 「新 root を読む前の書き込み」= 旧世代の内容が新 root へ着地してしまう。
    fs.files.rootB = motionsFileContent(["file-b"]);
    await store.initializeGeneratedMotions(true);

    // 新 root の正本が入っている (旧 root の file-1 で上書きされていない)。
    // = 切替をまたいだ初期化の結果が cache に残っていない証拠。
    expect(store.loadGeneratedSpecs().map((m) => m.id)).toEqual(["file-b"]);
    // 解禁は新 root を読んだ **この初期化**によるもので、読み直し自体は
    // 書き込みを増やさない (無変更なら書き込みゼロ = T1 と同じ契約)。
    expect(fs.writes).toHaveLength(writesBefore);

    // 解禁後の保存は新 root へ着地する。
    store.saveGeneratedSpec("after", spec("after"));
    await store.__test_drainMotionQueue();
    expect(fs.writes).toHaveLength(writesBefore + 1);
    const landed = fs.writes[fs.writes.length - 1];
    expect(landed.root).toBe("rootB");
    // 旧 root の内容 (file-1) を道連れにしていないこと。古い初期化が
    // 生き残っていれば、その cache から file-1 が混ざって書かれる。
    expect(idsInWrite(landed)).toEqual(["file-b", "after"]);
  });

  it("T5: 古い所有権トークンでは再初期化が起動しない", async () => {
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["file-1"]) },
    });
    const store = await loadMotionStore();
    await store.initializeGeneratedMotions();

    const token1 = await store.beginStorageRootSwitch();
    const token2 = await store.beginStorageRootSwitch();
    expect(token2).not.toBe(token1);

    const readsBefore = fs.reads.length;
    const writesBefore = fs.writes.length;

    // token1 は既に「自分の切替ではない」。再初期化を起動してはいけない。
    store.ensureStorageRootSwitchClosed(token1);
    await store.__test_drainMotionQueue();

    expect(fs.reads).toHaveLength(readsBefore);
    expect(fs.writes).toHaveLength(writesBefore);
  });

  it("T6: 最後の 1 件の削除は allowEmpty: true で書かれる", async () => {
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["only-one"]) },
    });
    const store = await loadMotionStore();
    await store.initializeGeneratedMotions();
    expect(store.loadGeneratedSpecs().map((m) => m.id)).toEqual(["only-one"]);

    store.removeGeneratedSpec("only-one");
    await store.__test_drainMotionQueue();

    expect(fs.writes).toHaveLength(1);
    // 「実際に 1 件消えて 0 件になった」ときだけ空書き込みを許可する契約。
    expect(fs.writes[0].allowEmpty).toBe(true);
    expect(idsInWrite(fs.writes[0])).toEqual([]);
  });

  it("T6b: 0 件でない削除は allowEmpty: false のまま", async () => {
    // T6 の対称ケース。allowEmpty を無条件 true にする退行を捕まえる。
    fs = installMotionsFsMock({
      root: "rootA",
      files: { rootA: motionsFileContent(["a", "b"]) },
    });
    const store = await loadMotionStore();
    await store.initializeGeneratedMotions();

    store.removeGeneratedSpec("a");
    await store.__test_drainMotionQueue();

    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].allowEmpty).toBe(false);
    expect(idsInWrite(fs.writes[0])).toEqual(["b"]);
  });
});
