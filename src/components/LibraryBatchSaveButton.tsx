import { useMemo, useState } from "react";
import { ModalPortal } from "./ModalPortal";

import { images as imagesIpc } from "../lib/ipc";
import { useLibrarySelection } from "../lib/store/librarySelection";
import { useToasts } from "../lib/store/toasts";

/**
 * ライブラリで選択中の画像を「ローカルに一括保存」するボタン。
 *
 * 既存の 1 枚保存 (images.downloadAs → images_save_as) はファイル単位の
 * 保存ダイアログを 1 回ずつ出すため、複数枚をまとめて保存できなかった。
 * このボタンは:
 *   1. 命名方法を決めるポップアップを出す (連番 / 今の名前のまま)
 *   2. OK でフォルダ選択ダイアログ (open directory)
 *   3. 選択した全画像を選んだ命名方法で 1 フォルダにコピー
 *
 * コピーはフロント完結 (imagesIpc.saveAs = images_save_as の copy)。Rust 側に
 * 新コマンドは増やさず、既存の一括削除・1 枚保存ロジックには触れない。
 */

type NamingMode = "serial" | "original";

const NAMING_MODE_STORAGE_KEY = "libraryBatchSave.namingMode";

/** パスから元のファイル名を取り出す。 */
function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() || "image.png";
}

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

/** 同名回避用の番号を拡張子の直前に付ける。 */
function withCollisionSuffix(name: string, number: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-${number}`;
  return `${name.slice(0, dot)}-${number}${name.slice(dot)}`;
}

/** 一括保存 — フロッピー型の保存アイコン (絵文字を使わずフラットアイコンで表現)。 */
function SaveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}

export function LibraryBatchSaveButton() {
  const selected = useLibrarySelection((s) => s.selected);
  const exitMode = useLibrarySelection((s) => s.exitMode);
  const pushToast = useToasts((s) => s.push);

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [namingMode, setNamingMode] = useState<NamingMode>(() => {
    if (typeof window === "undefined") return "serial";
    try {
      return window.localStorage.getItem(NAMING_MODE_STORAGE_KEY) === "original"
        ? "original"
        : "serial";
    } catch {
      return "serial";
    }
  });
  // 命名パターン設定
  const [prefix, setPrefix] = useState("gori_");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(3);

  const selectedPaths = useMemo(() => Array.from(selected), [selected]);
  const disabled = selectedPaths.length === 0 || running;

  // ポップアップ内のプレビュー (先頭画像の拡張子で 1 件だけ示す)
  const previewName = useMemo(() => {
    if (namingMode === "original") {
      return selectedPaths.length > 0 ? basenameOf(selectedPaths[0]) : "image.png";
    }
    const firstExt = selectedPaths.length > 0 ? extOf(selectedPaths[0]) : "png";
    return buildName(prefix, start, pad, 0, firstExt);
  }, [namingMode, prefix, start, pad, selectedPaths]);

  const selectNamingMode = (mode: NamingMode) => {
    setNamingMode(mode);
    try {
      window.localStorage.setItem(NAMING_MODE_STORAGE_KEY, mode);
    } catch (err) {
      console.warn("batch save naming mode could not be saved", err);
    }
  };

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

      const fileExists =
        namingMode === "original"
          ? (await import("@tauri-apps/plugin-fs")).exists
          : null;
      const reservedDestinations = new Set<string>();
      let completed = 0;
      let failed = 0;
      for (const [index, srcPath] of selectedPaths.entries()) {
        const ext = extOf(srcPath);
        let name = buildName(prefix, start, pad, index, ext);
        let dest = `${dir}/${name}`;

        if (namingMode === "original" && fileExists) {
          const originalName = basenameOf(srcPath);
          let suffix = 1;
          while (true) {
            name =
              suffix === 1
                ? originalName
                : withCollisionSuffix(originalName, suffix);
            dest = `${dir}/${name}`;
            if (
              !reservedDestinations.has(dest) &&
              !(await fileExists(dest))
            ) {
              break;
            }
            suffix += 1;
          }
          reservedDestinations.add(dest);
        }

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
        title="選択中の画像をローカルに一括保存"
        className={[
          "h-7 rounded-md px-3 text-[11px] font-bold transition",
          disabled
            ? "cursor-not-allowed bg-neutral-800 text-neutral-600"
            : "bg-white/10 text-neutral-100 hover:bg-white/20",
        ].join(" ")}
      >
        <span className="flex items-center justify-center gap-1.5">
          <SaveIcon />
          <span>
            一括保存
            {selectedPaths.length > 0 ? ` (${selectedPaths.length})` : ""}
          </span>
        </span>
      </button>

      {open && (
        <ModalPortal>
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 pb-[72px] pt-4"
          onClick={() => {
            if (!running) setOpen(false);
          }}
        >
          <div
            className="flex w-[360px] flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818] p-4 shadow-2xl"
            style={{ maxHeight: "calc(100vh - 120px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-h-0 overflow-y-auto pr-1">
              <h3 className="mb-1 text-[13px] font-black text-neutral-100">
                ローカルに一括保存
              </h3>
              <p className="mb-3 text-[11px] text-neutral-400">
                {selectedPaths.length} 件を 1 フォルダに保存します。
              </p>

              <div className="space-y-3">
                <div>
                  <span className="mb-1 block text-[12px] font-bold text-neutral-200">
                    命名方法
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="命名方法"
                    className="grid grid-cols-2 gap-1 rounded-lg border border-[#343434] bg-[#121212] p-1"
                  >
                    {(
                      [
                        ["serial", "連番で命名"],
                        ["original", "今の名前のまま"],
                      ] as const
                    ).map(([mode, label]) => {
                      const active = namingMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => selectNamingMode(mode)}
                          disabled={running}
                          className={[
                            "h-8 rounded-md px-2 text-[11px] font-bold transition",
                            active
                              ? "bg-pink-500 text-white"
                              : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100",
                            running ? "cursor-not-allowed opacity-50" : "",
                          ].join(" ")}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {namingMode === "serial" && (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-[12px] font-bold text-neutral-200">
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
                        <span className="mb-1 block text-[12px] font-bold text-neutral-200">
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
                        <span className="mb-1 block text-[12px] font-bold text-neutral-200">
                          ゼロ埋め桁数
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={pad}
                          onChange={(e) =>
                            setPad(
                              Math.min(
                                10,
                                Math.max(1, Math.floor(Number(e.target.value) || 1)),
                              ),
                            )
                          }
                          className="h-8 w-full rounded-md border border-[#343434] bg-[#0b0b0b] px-2 text-[12px] text-neutral-100 outline-none focus:border-pink-400"
                        />
                      </label>
                    </div>
                  </>
                )}

                <div className="rounded-md border border-[#2a2a2a] bg-[#0b0b0b] px-3 py-2">
                  <span className="text-[10px] text-neutral-500">プレビュー</span>
                  <p className="mt-0.5 font-mono text-[12px] text-neutral-200">
                    {previewName}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 flex shrink-0 justify-end gap-2">
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
                disabled={
                  running ||
                  (namingMode === "serial" && prefix.trim().length === 0)
                }
                className="h-8 rounded-md bg-pink-500 px-4 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
              >
                {running ? "保存中…" : "フォルダを選んで保存"}
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}
    </>
  );
}
