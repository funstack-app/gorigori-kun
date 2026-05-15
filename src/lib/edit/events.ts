import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { listenEditModelProgress } from "../ipc";
import type { EditModelProgress, MagicLayerProgress } from "./types";

export { EVENT_EDIT_MODEL_PROGRESS } from "../ipc";
export type { EditModelProgress };

export const EVENT_EDIT_MAGIC_PROGRESS = "codex://edit-magic-progress";

export function onEditModelProgress(
  cb: (progress: EditModelProgress) => void,
) {
  return listenEditModelProgress(cb);
}

export function listenEditMagicProgress(
  cb: (progress: MagicLayerProgress) => void,
): Promise<UnlistenFn> {
  return listen<MagicLayerProgress>(EVENT_EDIT_MAGIC_PROGRESS, (event) =>
    cb(event.payload),
  );
}
