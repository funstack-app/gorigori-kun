/**
 * 実装契約O (2026-08-05) の牙: O1「タイムアウト退行の根本修正」。
 *
 * ## 守っている挙動
 *
 * **threadId を持たない通知を、生存の証拠として数える。**
 *
 * 機序: 推論中の通知 (`item/reasoning/delta` 等) は `params.threadId` を持たない
 * ことがある。証拠は `src/lib/codex-events.ts:150,165` で、これらの handler が
 * `params?.threadId ?? state.activeThreadId` とフォールバックしている
 * ＝ threadId 無し通知の実在が前提になっている。
 *
 * 旧実装は `if (tid !== threadId) return;` で **tid === undefined も一律に捨てて**
 * いたため、モデルが長考しているあいだ完全な無音に見え、まだ本文が来ていない turn は
 * 「無応答」と誤判定されて切られた (STΛCK 実機で v2.4.1 から再発した退行)。
 *
 * 非対称であることが要点:
 *   - tid 無し           → 生存として数える (noteActivity)。本文には取り込まない
 *   - tid 明示の別スレッド → 従来どおり完全に無視 (自分が無言なら切れるべき)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

type CodexTextModule = typeof import("../src/lib/comic/codexText");

const THREAD_ID = "thread-O";

let listeners: Array<(n: { method: string; params: unknown }) => void> = [];

/** threadId 付きの通知 (自スレッド)。 */
function emit(method: string, params: Record<string, unknown> = {}) {
  const payload = { method, params: { threadId: THREAD_ID, ...params } };
  for (const cb of [...listeners]) cb(payload);
}

/**
 * **threadId を持たない**通知。これが今回の主役。
 * 実 app-server の推論 delta がこの形で飛んでくる。
 */
function emitThreadless(method: string, params: Record<string, unknown> = {}) {
  const payload = { method, params: { ...params } };
  for (const cb of [...listeners]) cb(payload);
}

async function loadModule(): Promise<CodexTextModule> {
  listeners = [];
  mockIPC(async () => null);
  vi.doMock("../src/lib/ipc", () => ({
    rpcRequest: vi.fn(async (method: string) => {
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

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("O1: threadId 無しの推論通知を取りこぼさない", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  it("T-O1-1: threadId 無しの推論 delta だけが流れ続けてもタイムアウトしない（牙）", async () => {
    // これが退行の再現テスト。修正を戻す (tid===undefined を捨てる) と必ず落ちる。
    const { runComicTextTurn } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
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

    // 本文は一度も来ない。threadId の無い推論通知だけが 60 秒おきに 10 分ぶん。
    // 旧実装はこれを全部捨てるので 90 秒で idle タイムアウトになる。
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      emitThreadless("item/reasoning/delta", { delta: "考え中" });
      await flush();
    }

    expect(rejected).toBeUndefined();
    expect(resolved).toBeUndefined();

    // 長考のあと本文が来れば、そのまま完走できる（これが救いたかった turn）
    emit("item/agentMessage/delta", { delta: "できた" });
    await flush();
    emit("turn/completed", { turn: { status: "completed" } });
    await flush();
    expect(resolved).toBe("できた");
  });

  it("T-O1-2: threadId 無しの通知は本文バッファに混ざらない", async () => {
    // 生存として数えるだけ。どのターンの本文か決められないものを
    // 成果物へ取り込むと、他ターンの文字列が紛れる。
    const { runComicTextTurn } = await loadModule();

    const promise = runComicTextTurn("prompt", { idleTimeoutMs: 90_000, label: "構成" });
    void promise.catch(() => {});
    await flush();

    // threadId 無しで「本文らしい」通知が来ても取り込まない
    emitThreadless("item/agentMessage/delta", { delta: "他ターンの本文" });
    await flush();
    emit("item/agentMessage/delta", { delta: "正しい本文" });
    await flush();
    emit("turn/completed", { turn: { status: "completed" } });
    await flush();

    await expect(promise).resolves.toBe("正しい本文");
  });

  it("T-O1-3: 明示的に別スレッドの通知ではリセットされない（従来どおり切れる）", async () => {
    // 生存側に倒すのは「無印」だけ。他スレッドと明示されたものは無視し続ける。
    // これが緩むと「自分は無言なのに永久に切れない」に戻る。
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", { idleTimeoutMs: 90_000, label: "構成" });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      for (const cb of [...listeners]) {
        cb({
          method: "item/agentMessage/delta",
          params: { threadId: "other-thread", delta: "z" },
        });
      }
      await flush();
    }

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err).toBeInstanceOf(ComicTextTurnTimeoutError);
    expect((result.err as InstanceType<typeof ComicTextTurnTimeoutError>).reason).toBe(
      "idle",
    );
  });

  it("T-O1-4: 通知がまったく無ければ従来どおり idle で切れる", async () => {
    // 生存の証拠が1つも無い場合まで待ち続けると、サーバー死で無限に待つ。
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", { idleTimeoutMs: 90_000, label: "構成" });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    await vi.advanceTimersByTimeAsync(90_001);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.err as InstanceType<typeof ComicTextTurnTimeoutError>).reason).toBe(
      "idle",
    );
  });
});
