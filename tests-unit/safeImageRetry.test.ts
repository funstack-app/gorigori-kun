/**
 * SafeImage の `retryOnError` の単体テスト (2026-08-05)。
 *
 * 背景: 画像を削除・移動すると黒い割れタイルが残る問題 (S1) の締めとして、
 * MessageList の生 <img> 3箇所を SafeImage に寄せた。生 <img> 側には
 * 「image_gen 直後は PNG の書き込みフラッシュが間に合わず 404 になるので
 * 250ms 後に一度だけ再フェッチする」という機構があり、それを SafeImage の
 * opt-in オプションとして移設している。
 *
 * ここで守りたい不変条件は2つ:
 *   1. retryOnError=true: 1回目の onError では**フォールバックに落ちず**
 *      再試行し、2回目の失敗で初めてフォールバックへ落ちる
 *   2. retryOnError なし(既定): 従来どおり**1回目の onError で即フォールバック**。
 *      既存の呼び出し側 (約40箇所) が無改修で通ることの担保
 *
 * JSX を使わないのは、vitest の include が `tests-unit/**` 配下の `.test.ts`
 * だけを拾う (=.tsx を拾わない) ためで、createElement 直書きで同じことをしている。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafeImage } from "../src/components/SafeImage";

/** SafeImage.tsx 側の RETRY_DELAY_MS と同じ待ち時間。 */
const RETRY_DELAY_MS = 250;

/** フォールバック表示 (画像が無いときの黒タイル代替) に出る文言。 */
const FALLBACK_LABEL = "画像が見つかりません";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // convertFileSrc は window.__TAURI_INTERNALS__ 越しに解決される。
  // jsdom には無いので素通しのスタブを置く。
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    convertFileSrc: (p: string) => `asset://localhost/${p}`,
  };
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

function render(props: Record<string, unknown>): void {
  act(() => {
    root.render(createElement(SafeImage, props));
  });
}

/** いま <img> が生きているか (=フォールバックに落ちていないか)。 */
function img(): HTMLImageElement | null {
  return host.querySelector("img");
}

/** フォールバック表示に落ちているか。 */
function isFallback(): boolean {
  return host.textContent?.includes(FALLBACK_LABEL) ?? false;
}

/** <img> に error を1回発火させ、リトライ用タイマーも消化する。 */
function fireError(): void {
  const el = img();
  if (!el) throw new Error("img が無い (既にフォールバックへ落ちている)");
  act(() => {
    el.dispatchEvent(new Event("error"));
  });
  act(() => {
    vi.advanceTimersByTime(RETRY_DELAY_MS);
  });
}

describe("SafeImage retryOnError", () => {
  it("retryOnError=true: 1回目の失敗では落ちず再試行し、2回目の失敗でフォールバックする", () => {
    render({ path: "/tmp/a.png", retryOnError: true, alt: "generated" });
    expect(img()).not.toBeNull();
    expect(isFallback()).toBe(false);

    // 1回目: 再フェッチが走るので <img> は生きたまま。
    fireError();
    expect(isFallback()).toBe(false);
    expect(img()).not.toBeNull();

    // 2回目: リトライ枠を使い切っているのでフォールバックへ。
    fireError();
    expect(isFallback()).toBe(true);
    expect(img()).toBeNull();
  });

  it("retryOnError なし(既定): 1回目の失敗で即フォールバックする(既存呼び出し側の非退行)", () => {
    render({ path: "/tmp/b.png", alt: "generated" });
    expect(img()).not.toBeNull();

    fireError();
    expect(isFallback()).toBe(true);
    expect(img()).toBeNull();
  });

  it("path が変わるとリトライ枠が戻る(別画像の1回目の失敗を救える)", () => {
    render({ path: "/tmp/c.png", retryOnError: true, alt: "generated" });
    fireError(); // c.png のリトライ枠を使い切る
    expect(isFallback()).toBe(false);

    render({ path: "/tmp/d.png", retryOnError: true, alt: "generated" });
    expect(img()).not.toBeNull();

    // d.png の1回目。枠がリセットされていれば、まだ落ちない。
    fireError();
    expect(isFallback()).toBe(false);
    expect(img()).not.toBeNull();
  });

  it("呼び出し側が渡した onError を握り潰さない(4箇所がスキップされた原因)", () => {
    const onError = vi.fn();
    render({ path: "/tmp/e.png", retryOnError: true, alt: "generated", onError });

    fireError();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
