import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useMultiAngleRun } from "../store/multiAngleRun";
import { EVENT_MULTIANGLE, type MultiAngleEvent } from "./types";

let listenerPromise: Promise<UnlistenFn> | null = null;

export function onMultiAngleEvent(
  cb: (event: MultiAngleEvent) => void,
): Promise<UnlistenFn> {
  return listen<MultiAngleEvent>(EVENT_MULTIANGLE, (event) => cb(event.payload));
}

export function ensureMultiAngleEventListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    listenerPromise = onMultiAngleEvent((event) => {
      useMultiAngleRun.getState().applyEvent(event);
    });
  }
  return listenerPromise;
}

export function disposeMultiAngleEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
