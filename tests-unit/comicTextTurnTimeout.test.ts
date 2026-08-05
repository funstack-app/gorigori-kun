/**
 * 9qm (2026-08-04): 構成生成タイムアウトの牙。
 *
 * 守っている挙動は1つだけ:
 *   **無応答では切れる / 受信中は切れない**
 *
 * なぜテストが要るか: 旧実装は「送信からの総時間」一発タイマーで、データが
 * 流れていても 300 秒で切れた。20ページ×最大8コマの構成 JSON は素直に5分を
 * 超えることがあり、完成間際の turn を捨てていた（STΛCK 実機 2026-08-04）。
 * 新実装は無応答タイマー（受信のたびにリセット）＋総時間の天井に分けた。
 * この2つの性質はタイマー配線を1行いじるだけで静かに壊れる（例: noteActivity の
 * 呼び忘れ、他スレッド通知でのリセット）ので、機械で固定する。
 *
 * 時間は vi.useFakeTimers() で進める（実時間を待たない）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";

type CodexTextModule = typeof import("../src/lib/comic/codexText");

const THREAD_ID = "thread-9qm";

/** 通知リスナー。onNotification のモックがここへ登録する。 */
let listeners: Array<(n: { method: string; params: unknown }) => void> = [];

/** 対象スレッドへ通知を1本流す。 */
function emit(method: string, params: Record<string, unknown> = {}) {
  const payload = { method, params: { threadId: THREAD_ID, ...params } };
  for (const cb of [...listeners]) cb(payload);
}

/** 本文 delta を1本流す（＝受信があったことにする）。 */
function emitDelta(delta: string) {
  emit("item/agentMessage/delta", { delta });
}

/**
 * codexText を読み込む。ipc は丸ごとモックする。
 *
 * rpcRequest は thread/start に固定 ID を返し、turn/start は握って何もしない
 * （応答は本テストが emit で作る）。onNotification は listeners へ登録する。
 */
async function loadModule(): Promise<CodexTextModule> {
  listeners = [];
  // mockIPC を張らないと @tauri-apps/api の invoke が実 IPC を探して落ちる。
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

/**
 * thread/start と onNotification の await を消化させる。
 *
 * runComicTextTurn は内部で await を挟むので、fake timer を進める前に
 * マイクロタスクを流し切らないと「まだ購読していない」状態で通知が飛ぶ。
 */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("runComicTextTurn のタイムアウト", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  it("T-9qm-1: 無応答が続けば idle タイムアウトで切れる", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
    });
    // reject を先に受け止める（unhandled rejection にしない）
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // 1文字も来ないまま無応答時間を超える
    await vi.advanceTimersByTimeAsync(90_001);

    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.err).toBeInstanceOf(ComicTextTurnTimeoutError);
    expect((result.err as InstanceType<typeof ComicTextTurnTimeoutError>).reason).toBe(
      "idle",
    );
  });

  it("T-9qm-2: 受信が続く限り idle タイムアウトでは切れない（旧実装が落ちる牙）", async () => {
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

    // 60 秒おきに1文字ずつ、合計 10 分ぶん受信し続ける。
    // 旧実装（総時間 300 秒の一発タイマー）はここで必ず切れる。
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      emitDelta("x");
      await flush();
    }

    expect(rejected).toBeUndefined();
    expect(resolved).toBeUndefined();

    // 最後まで流れれば完走する
    emit("turn/completed", { turn: { status: "completed" } });
    await flush();
    expect(resolved).toBe("xxxxxxxxxx");
  });

  it("T-9qm-3(改M): 受信後の無応答では切れず、再開すれば完走する", async () => {
    // 旧: 受信が途切れたら idle タイムアウトで切れる、を固定していた。
    // 契約M (2026-08-05 STΛCK指示「時間かかるとタイムアウトみたいになるのやめて」) で
    // 方針が反転: 一度でも受信したターンは自動では切らない（作りかけを捨てない）。
    // 詳細な stalled 可視化は comicTextTurnNoAutoCut.test.ts の T-M-1 が固定する。
    // ここでは「黙り込み→再開→完走」の一連が成立することを固定する。
    const { runComicTextTurn } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
    });
    let resolved: string | undefined;
    let rejected: unknown;
    promise.then(
      (v) => { resolved = v; },
      (e: unknown) => { rejected = e; },
    );
    await flush();

    // 一度受信する
    await vi.advanceTimersByTimeAsync(80_000);
    emitDelta("hello");
    await flush();

    // 旧方針なら 90 秒超の無応答で切れていた。新方針では切れない。
    await vi.advanceTimersByTimeAsync(200_000);
    await flush();
    expect(rejected).toBeUndefined();
    expect(resolved).toBeUndefined();

    // 黙り込みから再開しても、そのまま完走できる
    emitDelta(" world");
    emit("turn/completed", { turn: { status: "completed" } });
    await flush();
    expect(resolved).toBe("hello world");
  });

  it("T-9qm-4: 受信中でも総時間の天井に当たれば切れる（reason=total）", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      totalTimeoutMs: 300_000,
      label: "構成",
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // 30 秒おきに受信し続ける（idle には決して当たらない）
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emitDelta("y");
      await flush();
    }

    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.err as InstanceType<typeof ComicTextTurnTimeoutError>;
    expect(err).toBeInstanceOf(ComicTextTurnTimeoutError);
    expect(err.reason).toBe("total");
    // 文言も分ける（再実行を促すのでなく分量を減らす案内にする）
    expect(err.message).toContain("減らして");
  });

  it("T-9qm-8: 推論通知だけで総時間に達しても reason=total（本文0文字の境界）", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      totalTimeoutMs: 300_000,
      label: "構成",
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // 本文（delta）は一度も来ないが、推論の通知だけが 30 秒おきに流れ続ける。
    // idle タイマーはこれでリセットされるので、切るのは総時間の天井だけ。
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      emit("item/started", { item: { type: "reasoning" } });
      await flush();
    }

    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.err as InstanceType<typeof ComicTextTurnTimeoutError>;
    expect(err).toBeInstanceOf(ComicTextTurnTimeoutError);
    // 総時間で切れた以上、本文が0文字でも「無応答」と言ってはいけない。
    // 再実行を促すと、同じ長考をもう一度させるだけになる。
    expect(err.reason).toBe("total");
    expect(err.message).toContain("減らして");
  });

  it("T-9qm-5: 他スレッドの通知では idle タイマーがリセットされない", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
    });
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    // 画像生成など別スレッドの通知が賑やかに飛んでいる状況を作る。
    // これでリセットされてしまうと「自分は無言なのに永久に切れない」。
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

    // 自スレッドは 90 秒以上ずっと無言なので切れているはず
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.err as InstanceType<typeof ComicTextTurnTimeoutError>).reason).toBe(
      "idle",
    );
  });

  it("T-9qm-6: 進行状況が waiting → streaming で通知される", async () => {
    const { runComicTextTurn } = await loadModule();

    const seen: Array<{ phase: string; receivedChars: number }> = [];
    const promise = runComicTextTurn("prompt", {
      idleTimeoutMs: 90_000,
      label: "構成",
      onProgress: (p) => seen.push({ ...p }),
    });
    void promise.catch(() => {});
    await flush();

    // 本文を伴わない通知は waiting のまま
    emit("item/started", { item: { type: "reasoning" } });
    await flush();
    expect(seen.at(-1)).toEqual({ phase: "waiting", receivedChars: 0 });

    // 本文が来たら streaming に変わり、文字数が増える
    emitDelta("abc");
    await flush();
    expect(seen.at(-1)).toEqual({ phase: "streaming", receivedChars: 3 });

    emitDelta("de");
    await flush();
    expect(seen.at(-1)).toEqual({ phase: "streaming", receivedChars: 5 });

    emit("turn/completed", { turn: { status: "completed" } });
    await flush();
    await expect(promise).resolves.toBe("abcde");
  });

  it("T-9qm-7: 旧シグネチャ（数値の第2引数）が無応答タイムアウトとして効く", async () => {
    const { runComicTextTurn, ComicTextTurnTimeoutError } = await loadModule();

    const promise = runComicTextTurn("prompt", 90_000, "ネーム");
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await flush();

    await vi.advanceTimersByTimeAsync(90_001);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.err as InstanceType<typeof ComicTextTurnTimeoutError>;
    expect(err).toBeInstanceOf(ComicTextTurnTimeoutError);
    // ラベルが引き継がれる（「構成」と混ざらない）
    expect(err.message).toContain("ネーム");
  });
});
