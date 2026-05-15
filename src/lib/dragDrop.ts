import { useComposer, type Reference } from "./store/composer";
import { usePlanChat } from "./store/planChat";
import { useToasts } from "./store/toasts";
import { useWorkspace } from "./store/workspace";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function isImage(p: string) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

let attached: (() => void) | undefined;

/**
 * Register a single global drag-drop listener via Tauri 2's webview
 * API. Files dropped anywhere on the window get added to the composer
 * as upload-source references. Non-image files are silently skipped.
 *
 * Idempotent — calling more than once is a no-op.
 *
 * Returns an `onState` setter so the UI can show a hover overlay; the
 * Tauri event itself is window-wide, not DOM-element-scoped, so we
 * surface "is something being dragged" as a callback.
 */
export async function attachWindowDragDrop(opts: {
  onHoverChange?: (active: boolean) => void;
}): Promise<() => void> {
  if (attached) return attached;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const webview = getCurrentWebview();
    const unlisten = await webview.onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        opts.onHoverChange?.(true);
      } else if (event.payload.type === "leave") {
        opts.onHoverChange?.(false);
      } else if (event.payload.type === "drop") {
        opts.onHoverChange?.(false);
        const paths = (event.payload.paths ?? []) as string[];
        const refs: Reference[] = [];
        let skipped = 0;
        for (const p of paths) {
          if (!isImage(p)) {
            skipped++;
            continue;
          }
          refs.push({ path: p, name: basename(p), source: "upload" });
        }
        if (refs.length > 0) {
          if (useWorkspace.getState().activeTab === "plan") {
            usePlanChat.getState().addPendingImages(refs.map((ref) => ref.path));
            useToasts.getState().push({
              kind: "success",
              text: `${refs.length} 枚を企画チャットに添付しました`,
              ttlMs: 3000,
            });
          } else {
            useComposer.getState().addReferences(refs);
            useToasts.getState().push({
              kind: "success",
              text: `${refs.length} 枚を参照画像に追加しました`,
              ttlMs: 3000,
            });
          }
        }
        if (skipped > 0 && refs.length === 0) {
          useToasts.getState().push({
            kind: "warn",
            text: "画像ファイルではありません",
            ttlMs: 4000,
          });
        }
      }
    });
    attached = () => {
      unlisten();
      attached = undefined;
    };
    return attached;
  } catch (err) {
    console.warn("attachWindowDragDrop failed", err);
    const noop = () => {};
    attached = noop;
    return noop;
  }
}
