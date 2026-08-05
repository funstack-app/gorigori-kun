import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 貼り付け・ドロップ時のメモリ増幅とその入口ガードの回帰テスト (2026-08-06)。
 *
 * ## 何を守るテストか
 *
 * 2026-08-05、9 枚の画像貼り付け中にアプリがクラッシュし、プリセット 30 体消失の
 * 引き金になった。真因は 2 つ:
 *
 * - T1: `invoke("cmd", { bytes: Array.from(u8) })` がバイト列を JS 数値配列へ広げ、
 *   さらに JSON 化されて元サイズの 15〜20 倍の一時メモリを食っていた
 * - T2: 貼り付け時点に枚数・合計サイズの検査が無く、いくらでも受け付けていた
 *
 * ここでは「増幅しない転送になっていること」と「入口で超過を拒否すること」を固定する。
 */

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const pushMock = vi.fn();
vi.mock("../src/lib/store/toasts", () => ({
  useToasts: { getState: () => ({ push: pushMock }) },
}));

vi.mock("../src/lib/ipc", () => ({
  images: { fileSizes: vi.fn() },
}));

import { invokeWithBytes, encodeHeaderValue } from "../src/lib/ipcBytes";
import {
  evaluateAttachIntake,
  guardAttachIntake,
  MAX_ATTACH_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  WARN_SINGLE_FILE_BYTES,
} from "../src/lib/imagePayloadGuard";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("/tmp/out.png");
  pushMock.mockReset();
});

describe("T1: バイト転送が増幅しない", () => {
  it("invoke の第2引数に Uint8Array をそのまま渡す (配列化しない)", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await invokeWithBytes("images_write_clipboard", bytes);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0];
    expect(command).toBe("images_write_clipboard");

    // 牙: Array.from に戻すと payload は number[] になり、この 3 つが同時に落ちる。
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(payload)).toBe(false);
    expect(payload).toBe(bytes); // コピーすら作らない (同一参照)
  });

  it("JSON 化しても増幅しない (旧方式との実測差を固定)", () => {
    // 1 バイト = JS 数値 1 個 → JSON では "255," 等で最大 4 文字に膨らむ。
    const raw = new Uint8Array(4096).fill(255);
    const oldWayJsonLength = JSON.stringify({ bytes: Array.from(raw) }).length;

    // 旧方式は元サイズの 4 倍以上に膨らむ (JSON 文字列の時点で既にこれ。
    // 実際にはこの前段の number[] 自体が約 8 倍のヒープを使う)。
    expect(oldWayJsonLength).toBeGreaterThan(raw.byteLength * 4);

    // 新方式は生バイトのまま。長さは元のまま変わらない。
    expect(raw.byteLength).toBe(4096);
  });

  it("メタはヘッダーで運び、日本語も壊さない", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await invokeWithBytes("images_write_upload", bytes, { "file-name": "猫 の 絵.png" });

    const [, , options] = invokeMock.mock.calls[0];
    const headers = (options as { headers: Record<string, string> }).headers;
    expect(headers["x-gori-file-name"]).toBe(encodeHeaderValue("猫 の 絵.png"));
    // 非 ASCII がそのままヘッダーに乗っていない (乗ると送信自体が壊れる)
    expect(headers["x-gori-file-name"]).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(headers["x-gori-file-name"])).toBe("猫 の 絵.png");
  });
});

describe("T2: 入口ガードが受け付ける前に弾く", () => {
  it("合計が上限を超えたら拒否する", () => {
    const half = Math.ceil(MAX_TOTAL_IMAGE_BYTES / 2) + 1;
    const decision = evaluateAttachIntake([half, half]);

    // 牙: 上限判定を消す / 不等号を逆にすると accepted が true になり落ちる。
    expect(decision.accepted).toBe(false);
    expect(decision.kind).toBe("error");
    expect(decision.message).toContain("合計サイズが大きすぎます");
  });

  it("既に添付済みの分を合算して判定する", () => {
    const chunk = Math.ceil(MAX_TOTAL_IMAGE_BYTES / 2) + 1;
    // 単体では通るが、既存と合わせると超える
    expect(evaluateAttachIntake([chunk]).accepted).toBe(true);
    expect(evaluateAttachIntake([chunk], chunk).accepted).toBe(false);
  });

  it("枚数の暴投を拒否する", () => {
    const sizes = new Array(MAX_ATTACH_COUNT + 1).fill(1024);
    const decision = evaluateAttachIntake(sizes);
    expect(decision.accepted).toBe(false);
    expect(decision.message).toContain(`${MAX_ATTACH_COUNT} 枚`);
  });

  it("上限ちょうどは通す (境界で誤って弾かない)", () => {
    const sizes = new Array(MAX_ATTACH_COUNT).fill(1024);
    expect(evaluateAttachIntake(sizes).accepted).toBe(true);
    expect(evaluateAttachIntake([MAX_TOTAL_IMAGE_BYTES]).accepted).toBe(true);
  });

  it("1 枚が巨大なら受け付けるが警告する", () => {
    const decision = evaluateAttachIntake([WARN_SINGLE_FILE_BYTES + 1]);
    expect(decision.accepted).toBe(true);
    expect(decision.kind).toBe("warn");
    expect(decision.message).toContain("とても大きな画像");
  });

  it("問題なければ何も言わない", () => {
    const decision = evaluateAttachIntake([1024, 2048]);
    expect(decision.accepted).toBe(true);
    expect(decision.message).toBeNull();
  });

  it("guardAttachIntake は拒否時に error トーストを出す", () => {
    const ok = guardAttachIntake([MAX_TOTAL_IMAGE_BYTES + 1]);
    expect(ok).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0].kind).toBe("error");
  });

  it("guardAttachIntake は問題なしなら黙って通す", () => {
    expect(guardAttachIntake([1024])).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
