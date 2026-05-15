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
    listenerPromise = onStoryboardEvent((event) => {
      useStoryboardRun.getState().applyEvent(event);
    });
  }
  return listenerPromise;
}

export function disposeStoryboardEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
