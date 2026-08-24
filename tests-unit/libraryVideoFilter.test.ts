import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "../src/lib/ipc";

import {
  shouldIncludeLibraryMedia,
  useImages,
  type LibraryVideoAllowlist,
} from "../src/lib/store/images";
import type { ImageEvent } from "../src/lib/ipc";

function allowlist(
  paths: string[] = [],
  generatedRoots: string[] = [],
): LibraryVideoAllowlist {
  return {
    registeredPaths: new Set(paths),
    generatedRoots,
  };
}

function videoEvent(path: string, kind: ImageEvent["kind"]): ImageEvent {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    bucket: "test",
    mtime_ms: 1,
    size: 100,
    kind,
  };
}

function registeredVideoPaths(paths: string[] = []) {
  return { paths, generatedRoots: [] };
}

function mockImageListener() {
  let emit: ((event: ImageEvent) => void) | undefined;
  vi.spyOn(ipc, "onImageGenerated").mockImplementation(async (callback) => {
    emit = callback;
    return () => {};
  });
  return () => {
    if (!emit) throw new Error("画像リスナーが未登録です");
    return emit;
  };
}

beforeEach(() => {
  useImages.setState({
    items: [],
    knownPaths: new Set(),
    attached: false,
    activeTurns: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ライブラリ動画の取り込み選別", () => {
  it("turn記録がなく生成ルート外の手置き動画を除外する", () => {
    expect(
      shouldIncludeLibraryMedia(
        "/Users/test/Movies/screen-recording.mp4",
        "video",
        allowlist([], ["/Users/test/.codex/generated_images"]),
      ),
    ).toBe(false);
  });

  it("turn記録がある動画は生成ルート外でも通す", () => {
    const path = "/Users/test/Movies/registered.mp4";
    expect(shouldIncludeLibraryMedia(path, "video", allowlist([path]))).toBe(
      true,
    );
  });

  it("生成ルート配下の動画は台帳になくても通す", () => {
    expect(
      shouldIncludeLibraryMedia(
        "/Users/test/.codex/generated_images/run-1/movie.webm",
        "video",
        allowlist([], ["/Users/test/.codex/generated_images/"]),
      ),
    ).toBe(true);
  });

  it("似た名前の別フォルダは生成ルート配下と誤判定しない", () => {
    expect(
      shouldIncludeLibraryMedia(
        "/Users/test/.codex/generated_images-copy/movie.mp4",
        "video",
        allowlist([], ["/Users/test/.codex/generated_images"]),
      ),
    ).toBe(false);
  });

  it("ipc取得失敗を表す未取得状態では動画を全部通す", () => {
    expect(
      shouldIncludeLibraryMedia(
        "/Users/test/Movies/manual.mov",
        "video",
        undefined,
      ),
    ).toBe(true);
  });

  it("画像イベントは台帳や生成ルートに関係なく従来どおり通す", () => {
    expect(
      shouldIncludeLibraryMedia(
        "/Users/test/Pictures/manual.png",
        "image",
        allowlist(),
      ),
    ).toBe(true);
  });

  it("イベント到着後にDB登録された動画を再判定で追加する", async () => {
    vi.useFakeTimers();
    const path = "/Users/test/Movies/late-registration.mp4";
    const listSpy = vi
      .spyOn(ipc.sessions, "listRegisteredVideoPaths")
      .mockResolvedValueOnce(registeredVideoPaths())
      .mockResolvedValueOnce(registeredVideoPaths([path]));
    const getEmit = mockImageListener();

    await useImages.getState().attachListeners();
    getEmit()(videoEvent(path, "created"));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(999);
    expect(useImages.getState().knownPaths.has(path)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(useImages.getState().knownPaths.has(path)).toBe(true);
  });

  it("判定セット取得が3秒を超えるとfail-openで動画を追加する", async () => {
    vi.useFakeTimers();
    const path = "/Users/test/Movies/timeout.mp4";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ipc.sessions, "listRegisteredVideoPaths").mockReturnValue(
      new Promise(() => {}),
    );
    const getEmit = mockImageListener();

    await useImages.getState().attachListeners();
    getEmit()(videoEvent(path, "created"));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(useImages.getState().knownPaths.has(path)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(useImages.getState().knownPaths.has(path)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "list_registered_video_paths failed or timed out; keeping videos visible",
      expect.any(Error),
    );
  });

  it("initial動画の再取得は1回で止まる", async () => {
    vi.useFakeTimers();
    const path = "/Users/test/Movies/manual.mp4";
    const listSpy = vi
      .spyOn(ipc.sessions, "listRegisteredVideoPaths")
      .mockResolvedValue(registeredVideoPaths());
    const getEmit = mockImageListener();

    await useImages.getState().attachListeners();
    getEmit()(videoEvent(path, "initial"));
    await vi.advanceTimersByTimeAsync(0);

    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(useImages.getState().knownPaths.has(path)).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(useImages.getState().knownPaths.has(path)).toBe(false);
  });
});
