/**
 * vitest グローバルセットアップ (u73 2026-08-03)。
 *
 * ここでやることは2つだけ:
 *   1. jsdom に WebCrypto が無い環境向けの polyfill (crypto.randomUUID /
 *      getRandomValues)。Tauri 公式 mocking ガイドが挙げている前提条件で、
 *      Node 20+ の jsdom では既にあることが多いので**無いときだけ**定義する。
 *   2. 毎テスト後の後始末。clearMocks() で __TAURI_INTERNALS__ を戻し、
 *      vi.resetModules() でモジュールレベル state を捨てる。
 *
 * なぜ resetModules が要るか: motionStore / storyboardRun は cache・switchEpoch・
 * queueTail 等を**モジュール変数**で持つ。テスト間で使い回すと前のテストの
 * キューや世代印が残り、順序依存の偽陽性/偽陰性になる。各テストは
 * resetModules 後に動的 import して新品のモジュールを掴む。
 */
import { randomFillSync, randomUUID } from "node:crypto";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, vi } from "vitest";

const cryptoObj = globalThis.crypto as Crypto | undefined;

if (!cryptoObj) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues: <T extends ArrayBufferView | null>(buffer: T): T => {
        if (buffer) randomFillSync(buffer as unknown as NodeJS.ArrayBufferView);
        return buffer;
      },
      randomUUID,
    },
  });
} else {
  if (typeof cryptoObj.getRandomValues !== "function") {
    Object.defineProperty(cryptoObj, "getRandomValues", {
      configurable: true,
      value: <T extends ArrayBufferView | null>(buffer: T): T => {
        if (buffer) randomFillSync(buffer as unknown as NodeJS.ArrayBufferView);
        return buffer;
      },
    });
  }
  if (typeof cryptoObj.randomUUID !== "function") {
    Object.defineProperty(cryptoObj, "randomUUID", {
      configurable: true,
      value: randomUUID,
    });
  }
}

afterEach(() => {
  clearMocks();
  vi.resetModules();
});
