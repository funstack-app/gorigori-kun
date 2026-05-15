import { useEffect } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useComposer } from "../lib/store/composer";
import { useToasts } from "../lib/store/toasts";

const SUPPORTED = /\.(png|jpe?g|webp)$/i;

/**
 * Hidden helper that listens for `gori:add-local-files` events
 * (dispatched by the file <input> in ReferenceRack) and writes
 * the selected files into the app's reference store via images_write_upload.
 *
 * Why a CustomEvent indirection: the rack lives in ConstructedPromptPanel
 * but the persistence/upload glue belongs nearer to the IPC layer. The
 * event lets us swap implementations without touching the rack UI.
 *
 * The window-level drop handler is registered separately by `attachWindowDragDrop`
 * (see lib/dragDrop.ts), which already routes drops into useComposer.addReferences.
 * This picker just covers the "+ 追加" button case where the user explicitly
 * opens a file dialog.
 */
export function ReferencePicker() {
  const addReference = useComposer((s) => s.addReference);
  const pushToast = useToasts((s) => s.push);

  useEffect(() => {
    const onFiles = async (event: Event) => {
      const detail = (event as CustomEvent<File[]>).detail;
      if (!detail || detail.length === 0) return;

      let added = 0;
      let skipped = 0;
      for (const file of detail) {
        if (!SUPPORTED.test(file.name)) {
          skipped += 1;
          continue;
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const path = await imagesIpc.writeUpload(file.name, bytes);
          addReference({ path, name: file.name, source: "upload" });
          added += 1;
        } catch (error) {
          console.error("reference upload failed", error);
          skipped += 1;
        }
      }

      if (added > 0) {
        pushToast({
          kind: "success",
          text: `${added} 枚を参照画像に追加しました`,
          ttlMs: 3000,
        });
      }
      if (skipped > 0) {
        pushToast({
          kind: "info",
          text: `${skipped} 件は対応していない形式 or 失敗`,
          ttlMs: 4000,
        });
      }
    };

    window.addEventListener("gori:add-local-files", onFiles as EventListener);
    return () => {
      window.removeEventListener("gori:add-local-files", onFiles as EventListener);
    };
  }, [addReference, pushToast]);

  return null;
}
