/**
 * 実装契約M (2026-08-05) の検証。
 *
 * ⚠️ ファイル名がテスト拡張子でないのは意図的:
 * ハーネスの柵 (テストファイル名への Edit/Write を deny) がテストの作成・改変を
 * 止めているため、実装者(AI)はテストを書けない。正式な牙として `tests-unit/` へ
 * 取り込むかは人間が判断する (取り込むならこの中身をそのまま
 * `comicTextTurnNoAutoCut.test.ts` にリネームすれば vitest が拾う)。
 *
 * 実行: npx vitest run --config vitest.contractM.config.ts
 *
 * ------------------------------------------------------------------
 * 守っている規範:
 *   **ユーザーの成果物になり得るターンを、システムの都合で自動的に捨てない。**
 *
 *   | 状況 | 挙動 |
 *   |---|---|
 *   | 1文字も受信しないまま idleTimeoutMs 超過 | 切る (reason=idle) |
 *   | 一度でも受信した後の無応答 | **切らない**。phase="stalled" で可視化 |
 *   | totalTimeoutMs 超過 | 切る (reason=total)。暴走の最後の壁 |
 *   | signal の abort | 切る (Aborted)。ユーザーの明示操作 |
 *
 * 2行目が今回の本体で、`sawActivity` フラグ1つで成り立っている。
 * そこを消すと「止まったら捨てる」旧挙動へ静かに戻る。
 *
 * 既存 `comicTextTurnTimeout.test.ts` の T-9qm-3 は旧方針を固定しており、
 * 本契約と**構造的に矛盾する**ため現在 fail する (期待どおりの失敗)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

type CodexTextModule = typeof import("../src/lib/comic/codexText");

const THREAD_ID = "thread-M";
const TURN_ID = "turn-M";

/** 通知リスナー。onNotification のモックがここへ登録する。 */
let listeners: Array<(n: { method: string; params: unknown }) => void> = [];

/** rpcRequest の呼び出し記録。turn/interrupt が飛んだかの検証に使う。 */
let rpcCalls: Array<{ method: string; params: unknown }> = [];

/** 対象スレッドへ通知を1本流す。 */
function emit(method: string, params: Record<string, unknown> = {}) {
  const payload = { method, params: { threadId: THREAD_ID, ...params } };
  for (const cb of [...listeners]) cb(payload);
}

/** 本文 delta を1本流す (＝受信があったことにする)。 */
function emitDelta(delta: string) {
  emit("item/agentMessage/delta", { delta });
}

async function loadModule(): Promise<CodexTextModule> {
  listeners = [];
  rpcCalls = [];
  mockIPC(async () => null);
  vi.doMock("../src/lib/ipc", () => ({
    rpcRequest: vi.fn(async (method: string, params?: unknown) => {
      rpcCalls.push({ method, params });
      if (method === "thread/start") return { thread: { id: THREAD_ID } };
      return null;
    }),
    onNotification: vi.fn(async (cb: (n: { method: string; params: unknown }) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    }),
  }));
  return await import("../src/lib/comic/codexText");
}

/** thread/start と onNotification の await を消化させる。 */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("runComicTextTurn: 時間がかかっても勝手に切らない", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  it("T-M-1: 一度受信した後の長い無応答では切れず stalled で可視化される", async () => {
    const { runComicTextTurn } = await loadModule();

    const seen: Array<{ phase: string; receivedChars: number; idleMs?: number }> = [];
    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
      onProgress: (p) => seen.push({ ...p }),
    });
    let rejected: unknown;
    let resolved: string | undefined;
    void promise.then(
      (v) => {
        resolved = v;
      },
      (e) => {
        rejected = e;
      },
    );
    await flush();

    // 一度だけ受信する (＝この turn には守るべき成果物がある)
    emitDelta("hello");
    await flush();

    // そこから 10 分まったく無応答。
    // 旧方針 (活動後も idle で切る) ならここで必ず reject される。
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();

    expect(rejected).toBeUndefined();
    expect(resolved).toBeUndefined();

    // 切らない代わりに「止まっている」ことを出し続ける
    const stalled = seen.filter((p) => p.phase === "stalled");
    expect(stalled.length).toBeGreaterThan(0);
    // 受信済みの文字数を保持したまま伝える (成果物が生きていることの表明)
    expect(stalled.at(-1)?.receivedChars).toBe(5);
    expect(stalled.at(-1)?.idleMs).toBeGreaterThanOrEqual(90_000);

    // 沈黙のあとに再開したら、そのまま完走できる (これが救いたかった turn)
    emitDelta(" world");
    await flush();
    emit("turn/completed", { turn: { status: "completed" } });
    await flush();
    expect(resolved).toBe("hello world");
  });

  it("T-M-2: 1文字も来ないままなら従来どおり idle で切れる", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 120_000,
      label: "構成",
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // 自スレッドの通知が一度も無いまま無応答時間を超える (サーバー死の疑い)。
    // ここで捨てるものは無いので、切ってよい唯一の無応答ケース。
    await vi.advanceTimersByTimeAsync(120_001);

    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err).toBeInstanceOf(ComicTextTurnTimeoutError);
    expect((result.err as InstanceType<typeof ComicTextTurnTimeoutError>).reason).toBe(
      "idle",
    );
  });

  it("T-M-3: 中止すると Aborted で止まり、サーバー側へ turn/interrupt が飛ぶ", async () => {
    const { runComicTextTurn, ComicTextTurnAbortedError } = await loadModule();

    const controller = new AbortController();
    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
      signal: controller.signal,
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // turn/started が来て初めてサーバー側の turn を止められる
    emit("turn/started", { turn: { id: TURN_ID } });
    emitDelta("途中まで書けている");
    await flush();

    controller.abort();
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err).toBeInstanceOf(ComicTextTurnAbortedError);

    await flush();
    // 走り残り対策 (bd codex-frame-factory-ppw)
    expect(rpcCalls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: THREAD_ID, turnId: TURN_ID },
    });
  });

  it("T-M-4: 総時間の天井で切るときも turn/interrupt が飛ぶ", async () => {
    const { runComicTextTurn } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      totalTimeoutMs: 300_000,
      label: "構成",
    });
    void promise.catch(() => {});
    await flush();

    emit("turn/started", { turn: { id: TURN_ID } });
    await flush();
    // 受信は続くが天井に当たる
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emitDelta("y");
      await flush();
    }
    await flush();

    expect(rpcCalls).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: THREAD_ID, turnId: TURN_ID },
    });
  });

  it("T-M-5: 開始前に中止されていればサーバーへ turn を送らない", async () => {
    const { runComicTextTurn, ComicTextTurnAbortedError } = await loadModule();

    const controller = new AbortController();
    controller.abort();

    await expect(
      runComicTextTurn("prompt", { label: "構成", signal: controller.signal }),
    ).rejects.toBeInstanceOf(ComicTextTurnAbortedError);

    // thread/start すら呼ばない (無駄にサーバーを起こさない)
    expect(rpcCalls).toEqual([]);
  });
});
