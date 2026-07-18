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
    listenerPromise = onCharacterSheetEvent((event) => {
      useCharacterSheetRun.getState().applyEvent(event);
    });
  }
  return listenerPromise;
}

export function disposeCharacterSheetEventListener() {
  if (!listenerPromise) return;
  void listenerPromise.then((unlisten) => unlisten());
  listenerPromise = null;
}
