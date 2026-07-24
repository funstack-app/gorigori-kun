import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { EVENT_STORYBOARD } from "../ipc";
import { useStoryboardRun } from "../store/storyboardRun";
import type { StoryboardEvent } from "./types";

let listenerPromise: Promise<UnlistenFn> | null = null;

export function onStoryboardEvent(
  cb: (event: StoryboardEvent) => void,
): Promise<UnlistenFn> {
  return listen<StoryboardEvent>(EVENT_STORYBOARD, (event) => cb(event.payload));
}

export function ensureStoryboardEventListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    const pendingListener = onStoryboardEvent((event) => {
      useStoryboardRun.getState().applyEvent(event);
    });
    listenerPromise = pendingListener;
    // 登録失敗をキャッシュし続けず、次回の画面入場で再試行できるようにする。
    void pendingListener.catch(() => {
      if (listenerPromise === pendingListener) {
        listenerPromise = null;
      }
    });
  }
  return listenerPromise;
}

export function disposeStoryboardEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
