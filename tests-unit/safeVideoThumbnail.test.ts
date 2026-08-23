import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafeVideo } from "../src/components/SafeImage";

let host: HTMLDivElement;
let root: Root;
let intersectionCallback: IntersectionObserverCallback | undefined;
let observerInstance: IntersectionObserver | undefined;

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0.01];

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
    observerInstance = this;
  }

  disconnect = vi.fn();
  observe = vi.fn();
  takeRecords = () => [];
  unobserve = vi.fn();
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    convertFileSrc: (path: string) => `asset://localhost/${path}`,
  };
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  intersectionCallback = undefined;
  observerInstance = undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(props: Record<string, unknown>): HTMLVideoElement {
  act(() => root.render(createElement(SafeVideo, props)));
  const video = host.querySelector("video");
  if (!video) throw new Error("video が描画されていません");
  return video;
}

describe("SafeVideo thumbnailPreview", () => {
  it("画面外では未読込、画面内へ入ると metadata を読み込む", () => {
    const video = render({ path: "/tmp/result.mp4", thumbnailPreview: true });

    expect(video.getAttribute("src")).toBeNull();
    expect(video.preload).toBe("none");
    expect(intersectionCallback).toBeTypeOf("function");

    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true, target: video } as IntersectionObserverEntry],
        observerInstance as IntersectionObserver,
      );
    });

    expect(video.getAttribute("src")).toBe("asset://localhost//tmp/result.mp4");
    expect(video.preload).toBe("metadata");
  });

  it("metadata 読込後に先頭フレームの復号を促す", () => {
    const video = render({ path: "/tmp/result.mp4", thumbnailPreview: true });
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true, target: video } as IntersectionObserverEntry],
        observerInstance as IntersectionObserver,
      );
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 4 });

    act(() => video.dispatchEvent(new Event("loadedmetadata")));

    expect(video.currentTime).toBe(0.001);
  });
});
