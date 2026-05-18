import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { images as imagesIpc } from "../lib/ipc";
import { useImagePreview } from "../lib/store/imagePreview";
import { useImages } from "../lib/store/images";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useProjects } from "../lib/store/projects";
import { useToasts } from "../lib/store/toasts";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ImageMetaPanel } from "./ImageMetaPanel";
import { RegisterPresetDialog } from "./RegisterPresetDialog";

export function ImagePreviewModal() {
  const path = useImagePreview((s) => s.path);
  const close = useImagePreview((s) => s.close);
  const siblings = useImagePreview((s) => s.siblings);
  const goPrev = useImagePreview((s) => s.goPrev);
  const goNext = useImagePreview((s) => s.goNext);
  const setPreview = useImagePreview((s) => s.open);
  const openMask = useMaskEditor((s) => s.open);
  // Subscribe so the name updates if the gallery store loads the item
  // after the modal opens (rare, but happens when a generated image
  // arrives a tick after we navigate to its preview).
  const item = useImages((s) => s.items.find((it) => it.path === path));
  // Fallback リスト: open(path) だけで開かれた場合も矢印キーで巡回できるように
  // useImages.items 全体 (mtime 降順) を採用する。
  // ライブラリ / タイムライン由来のプレビューはこれで十分カバー、
  // プロジェクト詳細など限定的な文脈は呼び出し側で open(path, siblings) を渡す。
  //
  // 重要: Zustand selector の中で .map() などの派生配列を返すと毎レンダー
  // 新しい参照になり、無限ループ → 白画面の原因になる (React + Zustand 安全パターン)。
  // raw の items を取得 → useMemo で path 配列を導出する。
  const galleryItems = useImages((s) => s.items);
  const fallbackSiblings = useMemo(
    () =>
      galleryItems.length > 0 ? galleryItems.map((it) => it.path) : undefined,
    [galleryItems],
  );
  const effectiveSiblings = siblings ?? fallbackSiblings;
  const canNavigate = !!effectiveSiblings && effectiveSiblings.length > 1;

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** F-#1: プリセット登録ダイアログの開閉。null なら閉じ、文字列なら対象画像 path。 */
  const [presetTarget, setPresetTarget] = useState<string | null>(null);
  // 詳細パネル開閉。デフォルトで開いておく（ユーザーが情報を求めている前提）。
  // STΛCK 指示 (2026-05-17): 詳細パネルは常時表示 (トグルなし)
  const metaOpen = true;

  // siblings の文脈で前/次へ移動するヘルパー。siblings prop と fallback どちらでも動く。
  const navigateBy = (delta: 1 | -1) => {
    if (!path) return;
    if (siblings && siblings.length > 0) {
      delta === 1 ? goNext() : goPrev();
      return;
    }
    if (!fallbackSiblings || fallbackSiblings.length === 0) return;
    const idx = fallbackSiblings.indexOf(path);
    if (idx < 0) return;
    const next =
      fallbackSiblings[
        (idx + delta + fallbackSiblings.length) % fallbackSiblings.length
      ];
    setPreview(next);
  };

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      // 矢印キー (← / →) で前後の画像へ移動。input/textarea にフォーカスが
      // ある時はテキスト編集を優先するためスキップ。
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) {
          return;
        }
        e.preventDefault();
        navigateBy(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      // Trap Tab inside the dialog so keyboard users can't wander into
      // the chat behind us.
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
    // navigateBy はクロージャ更新で OK、依存に入れると毎レンダー張替えになる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, close, siblings, fallbackSiblings]);

  if (!path) return null;

  const name = item?.name ?? path.split("/").pop() ?? "";

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex max-h-[calc(100vh-2rem)] flex-col overflow-y-auto bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-label="画像プレビュー"
      aria-modal="true"
      onClick={close}
    >
      <div
        className="flex items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-900/70 px-4 py-2 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="min-w-0 flex-1 truncate font-mono text-neutral-300"
          title={path}
        >
          {name}
        </span>
        <div className="flex flex-shrink-0 items-center gap-2">
          <SaveToProjectButton path={path} />
          <SaveAsFormatButton path={path} name={name} />
          {/* STΛCK 指示 (2026-05-17): 詳細トグルボタンは削除。
              ImageMetaPanel は常時下部表示にして UX を簡潔にする。 */}
          <button
            type="button"
            onClick={() => {
              openMask({ path, name });
              close();
            }}
            className="rounded border border-emerald-500/60 px-2 py-1 text-emerald-300 hover:bg-emerald-500/10"
          >
            マスクで編集
          </button>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="閉じる"
            title="閉じる (Esc)"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-700 bg-neutral-800 text-base text-neutral-200 transition hover:border-rose-500/60 hover:bg-rose-500/20 hover:text-rose-100"
          >
            ✕
          </button>
        </div>
      </div>
      {/* The padded space around the <img> is intentionally clickable so
          users can dismiss the modal by clicking anywhere outside the
          image. We only swallow clicks on the <img> itself so a click on
          the picture doesn't accidentally close the dialog. */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden p-6"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <img
          src={convertFileSrc(path)}
          alt={name}
          className="max-h-full max-w-full object-contain"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
        />
        {canNavigate && (
          <>
            <button
              type="button"
              aria-label="前の画像"
              title="前の画像 (←)"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(-1);
              }}
              className="absolute left-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white backdrop-blur transition hover:border-pink-400/60 hover:bg-pink-500/30"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="次の画像"
              title="次の画像 (→)"
              onClick={(e) => {
                e.stopPropagation();
                navigateBy(1);
              }}
              className="absolute right-3 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white backdrop-blur transition hover:border-pink-400/60 hover:bg-pink-500/30"
            >
              ›
            </button>
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            [
              {
                label: "プリセットに登録…",
                icon: "P",
                onClick: () => setPresetTarget(path),
              },
              { kind: "separator" },
              {
                label: "名前を付けて保存…",
                onClick: () =>
                  useImages.getState().downloadAs(path, name),
              },
              {
                label: "マスクで編集",
                onClick: () => {
                  openMask({ path, name });
                  close();
                },
              },
              {
                label: "Finder で表示",
                onClick: () => useImages.getState().revealInFinder(path),
              },
            ] satisfies ContextMenuItem[]
          }
          onClose={() => setMenu(null)}
        />
      )}
      {metaOpen && (
        <div onClick={(e) => e.stopPropagation()} className="max-h-[40vh] overflow-y-auto">
          <ImageMetaPanel path={path} />
        </div>
      )}
      <div className="border-t border-neutral-800 bg-neutral-900/70 px-4 py-1.5 text-center text-[11px] text-neutral-500">
        Esc または背景クリックで閉じる
      </div>
      {presetTarget && (
        <RegisterPresetDialog
          imagePath={presetTarget}
          defaultName={name}
          onClose={() => setPresetTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * 「プロジェクトに保存」ボタン + ポップオーバー。
 * 押すと既存プロジェクト一覧 + 新規作成入力が出てきて、選択でその箱に追加する。
 *
 * F-#4 (2026-05-19): export 化して、生成バッチの 1 枚ごとの保存にも再利用。
 */
export function SaveToProjectButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const projects = useProjects((s) => s.projects);
  const createProject = useProjects((s) => s.createProject);
  const addItem = useProjects((s) => s.addItem);
  const pushToast = useToasts((s) => s.push);
  const [draftName, setDraftName] = useState("");

  const handleSave = (projectId: string, projectName: string) => {
    const item = addItem(projectId, { imagePath: path });
    if (item) {
      pushToast({
        kind: "success",
        text: `「${projectName}」に保存しました`,
        ttlMs: 2200,
      });
    }
    setOpen(false);
  };

  const handleCreateAndSave = () => {
    const name = draftName.trim();
    if (!name) return;
    const created = createProject(name);
    handleSave(created.id, created.name);
    setDraftName("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className={[
          "rounded border px-2 py-1 transition",
          open
            ? "border-pink-400 bg-pink-500/15 text-pink-100"
            : "border-pink-400/60 text-pink-200 hover:bg-pink-500/10",
        ].join(" ")}
        title="プロジェクトに保存"
      >
        ◱ プロジェクトに保存
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-2 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
            既存プロジェクト
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-neutral-500">
                まだプロジェクトがありません
              </p>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => handleSave(project.id, project.name)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                >
                  <span className="truncate">{project.name}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {project.items.length} 件
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="mt-2 border-t border-neutral-800 pt-2">
            <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
              新しいプロジェクトに保存
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  const isComposing =
                    (event.nativeEvent as KeyboardEvent).isComposing ||
                    event.keyCode === 229;
                  if (event.key === "Enter" && !isComposing) {
                    event.preventDefault();
                    handleCreateAndSave();
                  } else if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="プロジェクト名"
                className="h-7 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-pink-400"
              />
              <button
                type="button"
                onClick={handleCreateAndSave}
                disabled={!draftName.trim()}
                className="h-7 rounded-md bg-pink-500 px-2 text-[11px] font-bold text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                作成して保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveAsFormatButton({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  const pushToast = useToasts((s) => s.push);

  const saveAs = async (format: "png" | "jpeg") => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = format === "jpeg" ? "jpg" : "png";
      const baseName = name.replace(/\.[^.]+$/, "") || "image";
      const dest = await save({
        defaultPath: `${baseName}.${ext}`,
        filters: [
          {
            name: format === "jpeg" ? "JPEG" : "PNG",
            extensions: format === "jpeg" ? ["jpg", "jpeg"] : ["png"],
          },
        ],
      });
      if (typeof dest !== "string") return;
      await imagesIpc.saveAsFormat(
        path,
        dest,
        format,
        format === "jpeg" ? 92 : undefined,
      );
      pushToast({
        kind: "success",
        text: `${format === "jpeg" ? "JPEG" : "PNG"} として保存しました`,
        ttlMs: 2600,
      });
      setOpen(false);
    } catch (err) {
      pushToast({
        kind: "error",
        text: `保存に失敗: ${String(err)}`,
        ttlMs: 5000,
      });
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className={[
          "rounded border px-2 py-1 transition",
          open
            ? "border-sky-400 bg-sky-500/15 text-sky-100"
            : "border-sky-400/60 text-sky-200 hover:bg-sky-500/10",
        ].join(" ")}
        title="形式を選んで保存"
      >
        保存
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-neutral-700 bg-neutral-900 p-1 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void saveAs("png")}
            className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
          >
            PNG として保存
          </button>
          <button
            type="button"
            onClick={() => void saveAs("jpeg")}
            className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
          >
            JPEG として保存（quality 92）
          </button>
        </div>
      )}
    </div>
  );
}
