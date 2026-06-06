import { useMemo, useState } from "react";

import { images as imagesIpc } from "../lib/ipc";
import { useLibrarySelection } from "../lib/store/librarySelection";
import { useToasts } from "../lib/store/toasts";

/**
 * ライブラリで選択中の画像を「ローカルに一括保存」するボタン。
 *
 * 既存の 1 枚保存 (images.downloadAs → images_save_as) はファイル単位の
 * 保存ダイアログを 1 回ずつ出すため、複数枚をまとめて保存できなかった。
 * このボタンは:
 *   1. 連番・命名規則を決めるポップアップを出す (プレフィックス / 開始番号 / ゼロ埋め桁数)
 *   2. OK でフォルダ選択ダイアログ (open directory)
 *   3. 選択した全画像を「{プレフィックス}{連番}.{元拡張子}」で 1 フォルダにコピー
 *
 * コピーはフロント完結 (imagesIpc.saveAs = images_save_as の copy)。Rust 側に
 * 新コマンドは増やさず、既存の一括削除・1 枚保存ロジックには触れない。
 */

/** ファイル名から拡張子 (ドットなし) を取り出す。無ければ png 扱い。 */
function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "png";
  return base.slice(dot + 1).toLowerCase() || "png";
}

/** プレビュー用 / 実保存用の連番ファイル名を組み立てる。 */
function buildName(
  prefix: string,
  start: number,
  pad: number,
  index: number,
  ext: string,
): string {
  const n = start + index;
  const num = String(n).padStart(Math.max(0, pad), "0");
  return `${prefix}${num}.${ext}`;
}

export function LibraryBatchSaveButton() {
  const selected = useLibrarySelection((s) => s.selected);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const pushToast = useToasts((s) => s.push);

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  // 命名パターン設定
  const [prefix, setPrefix] = useState("gori_");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(3);

  const selectedPaths = useMemo(() => Array.from(selected), [selected]);
  const disabled = selectedPaths.length === 0 || running;

  // ポップアップ内のプレビュー (先頭画像の拡張子で 1 件だけ示す)
  const previewName = useMemo(() => {
    const firstExt = selectedPaths.length > 0 ? extOf(selectedPaths[0]) : "png";
    return buildName(prefix, start, pad, 0, firstExt);
  }, [prefix, start, pad, selectedPaths]);

  const handleSave = async () => {
    if (running || selectedPaths.length === 0) return;
    setRunning(true);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "保存先フォルダを選択",
      });
      if (typeof dir !== "string") {
        // キャンセル: ポップアップは閉じない (再操作できるように)
        return;
      }

      let completed = 0;
      let failed = 0;
      for (const [index, srcPath] of selectedPaths.entries()) {
        const ext = extOf(srcPath);
        const name = buildName(prefix, start, pad, index, ext);
        const dest = `${dir}/${name}`;
        try {
          await imagesIpc.saveAs(srcPath, dest);
          completed += 1;
        } catch (err) {
          failed += 1;
          console.warn("batch save failed", { srcPath, dest, error: err });
        }
      }

      if (failed > 0) {
        pushToast({
          kind: "warn",
          text: `${failed} 件は保存できませんでした`,
          ttlMs: 5000,
        });
      }
      if (completed > 0) {
        pushToast({
          kind: "success",
          text: `${completed} 件をローカルに保存しました`,
          ttlMs: 3000,
        });
        setOpen(false);
        exitMode();
      } else {
        pushToast({
          kind: "error",
          text: "保存できる画像がありませんでした",
          ttlMs: 5000,
        });
      }
    } catch (err) {
      pushToast({
        kind: "error",
        text: `一括保存に失敗しました: ${String(err)}`,
        ttlMs: 6000,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="選択中の画像を連番命名でローカルに一括保存"
        className={[
          "h-7 rounded-md px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
            : "bg-emerald-600 text-white hover:bg-emerald-500",
        ].join(" ")}
      >
        {`💾 一括保存${selectedPaths.length > 0 ? ` (${selectedPaths.length})` : ""}`}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => {
            if (!running) setOpen(false);
          }}
        >
          <div
            className="w-[360px] rounded-xl border border-[#2a2a2a] bg-[#181818] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-[13px] font-bold text-neutral-100">
              ローカルに一括保存
            </h3>
            <p className="mb-3 text-[11px] text-neutral-400">
              {selectedPaths.length} 件を連番ファイル名で 1 フォルダに保存します。
            </p>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-neutral-300">
                  プレフィックス
                </span>
                <input
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="gori_"
                  className="h-8 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[12px] text-neutral-100 outline-none focus:border-pink-400"
                />
              </label>

              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-300">
                    開始番号
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={start}
                    onChange={(e) =>
                      setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))
                    }
                    className="h-8 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[12px] text-neutral-100 outline-none focus:border-pink-400"
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-300">
                    ゼロ埋め桁数
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={pad}
                    onChange={(e) =>
                      setPad(
                        Math.min(10, Math.max(1, Math.floor(Number(e.target.value) || 1))),
                      )
                    }
                    className="h-8 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[12px] text-neutral-100 outline-none focus:border-pink-400"
                  />
                </label>
              </div>

              <div className="rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2">
                <span className="text-[10px] text-neutral-500">プレビュー</span>
                <p className="mt-0.5 font-mono text-[12px] text-emerald-300">
                  {previewName}
                </p>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={running}
                className="h-8 rounded-md border border-[#343434] bg-[#0b0b0b] px-3 text-[11px] font-bold text-neutral-300 hover:border-neutral-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={running || prefix.trim().length === 0}
                className="h-8 rounded-md bg-emerald-600 px-4 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
              >
                {running ? "保存中…" : "フォルダを選んで保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
