import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useCharacterSheetRun } from "../store/characterSheetRun";
import { EVENT_CHARACTER_SHEET, type CharacterSheetEvent } from "./types";

let listenerPromise: Promise<UnlistenFn> | null = null;

export function onCharacterSheetEvent(
  cb: (event: CharacterSheetEvent) => void,
): Promise<UnlistenFn> {
  return listen<CharacterSheetEvent>(EVENT_CHARACTER_SHEET, (event) =>
    cb(event.payload),
  );
}

export function ensureCharacterSheetEventListener(): Promise<UnlistenFn> {
  if (!listenerPromise) {
    const pendingListener = onCharacterSheetEvent((event) => {
      useCharacterSheetRun.getState().applyEvent(event);
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

export function disposeCharacterSheetEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
