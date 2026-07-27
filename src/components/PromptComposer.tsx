import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useThreads } from "../lib/store/threads";
import {
  ASPECT_OPTIONS,
  useComposer,
  type FrameAspect,
  type Reference,
  type ReferenceRole,
} from "../lib/store/composer";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useDragHover } from "../lib/store/dragHover";
import { useToasts } from "../lib/store/toasts";
import { useBatches } from "../lib/store/batches";
import { useSavedPrompts, type SavedPrompt } from "../lib/store/savedPrompts";
import { useSessions } from "../lib/store/sessions";
import { useWorkflow, type ImageMode, type VideoMode } from "../lib/store/workflow";
import { PromptEditorModal } from "./PromptEditorModal";
import { PromptLibraryModal } from "./PromptLibraryModal";
import { images as imagesIpc } from "../lib/ipc";
import { resolveImageMentions } from "../lib/scene/resolveImageMentions";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

function basename(p: string) {
  return p.split("/").pop() ?? p;
}

const REFERENCE_DRAG_MIME = "application/x-gori-reference";

function parseDraggedReference(e: React.DragEvent): Reference | null {
  const raw =
    e.dataTransfer.getData(REFERENCE_DRAG_MIME) ||
    e.dataTransfer.getData("application/json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Reference>;
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    return {
      path: parsed.path,
      name:
        typeof parsed.name === "string" && parsed.name
          ? parsed.name
          : basename(parsed.path),
      source: parsed.source === "upload" ? "upload" : "gallery",
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

async function fileToUploadReference(file: File): Promise<Reference> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const path = await imagesIpc.writeUpload(
    file.name && file.name.trim() ? file.name : `drop-${Date.now()}.png`,
    buf,
  );
  return {
    path,
    name: file.name && file.name.trim() ? file.name : basename(path),
    source: "upload",
    role: "subject",
  };
}

export function PromptComposer({
  embedded = false,
  dark = false,
}: {
  embedded?: boolean;
  dark?: boolean;
}) {
  const {
    interruptActiveTurn,
    sending,
    threadsById,
    activeThreadId,
  } = useThreads();
  const {
    text,
    references,
    count,
    aspect,
    setText,
    clearText,
    restoreLastText,
    lastSentText,
    setCount,
    setAspect,
    addReferences,
    removeReference,
    setReferenceRole,
    clearMaskFor,
    reset,
    takeForSend,
  } = useComposer();
  const openMaskEditor = useMaskEditor((s) => s.open);
  const pushToast = useToasts((s) => s.push);

  const [dragOver, setDragOver] = useState(false);
  const tauriDragOver = useDragHover((s) => s.active);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const showDropOverlay = dragOver || tauriDragOver;
  const lockedReferenceForButton = useWorkflow((s) => s.lockedReference);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saveDraftOpen, setSaveDraftOpen] = useState(false);

  // Slash-command suggestion state. When the user starts the prompt
  // with `/`, we filter saved prompts by title/body and surface them
  // in a popover above the textarea. Picking one replaces the entire
  // prompt with the saved body. Empty query (`/` alone) shows the
  // top suggestions; longer query narrows.
  const savedPrompts = useSavedPrompts((s) => s.items);
  const bumpUseCount = useSavedPrompts((s) => s.bumpUseCount);
  const slashQuery = text.startsWith("/") ? text.slice(1) : null;
  const matches = useMemo<SavedPrompt[]>(() => {
    if (slashQuery == null) return [];
    const q = slashQuery.toLowerCase().trim();
    const filtered = q
      ? savedPrompts.filter(
          (p) =>
            p.title.toLowerCase().includes(q) ||
            p.body.toLowerCase().includes(q),
        )
      : savedPrompts;
    // Pinned first, then by useCount (most-used wins ties).
    return [...filtered]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.useCount !== b.useCount) return b.useCount - a.useCount;
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, 8);
  }, [slashQuery, savedPrompts]);
  const showSuggestions = slashQuery != null && matches.length > 0;
  const [suggestIdx, setSuggestIdx] = useState(0);
  // Reset selection when matches change so the highlight doesn't
  // run off the end of the list.
  useEffect(() => {
    setSuggestIdx(0);
  }, [slashQuery, matches.length]);

  const pickSuggestion = (p: SavedPrompt) => {
    setText(p.body);
    void bumpUseCount(p.id);
  };

  const isStreaming = !!(
    activeThreadId &&
    threadsById[activeThreadId]?.turns.some((t) => t.status === "inProgress")
  );

  const submit = async () => {
    // Guard against double-submit from the Cmd+Enter shortcut while
    // a generation is already in flight. The disabled state on the
    // 送信 button covers mouse clicks, but the keyboard handler runs
    // even when the button is disabled — without this check the
    // user could fire several batches into the same FIFO queue.
    if (useThreads.getState().sending) return;
    const snap = takeForSend();
    const workflow = useWorkflow.getState();
    const lockedReference = workflow.lockedReference;
    let effectiveReferences = [...snap.references];
    if (
      lockedReference &&
      !effectiveReferences.some((ref) => ref.path === lockedReference.path)
    ) {
      effectiveReferences.unshift({
        path: lockedReference.path,
        name: lockedReference.name,
        source: "gallery",
        role: "subject",
      });
    }
    // @imgN メンションを解決する。本文から @imgN を取り除き、指定があれば
    // その参照画像だけに絞る (mask/role はそのまま保持)。指定が無ければ全参照を使う。
    const mention = resolveImageMentions(snap.text, effectiveReferences);
    const trimmed = mention.cleanedPrompt.trim();
    if (mention.mentioned.length > 0) {
      const wanted = new Set(mention.mentioned.map((m) => m.path));
      effectiveReferences = effectiveReferences.filter((ref) =>
        wanted.has(ref.path),
      );
    }
    if (!trimmed && effectiveReferences.length === 0) return;
    // 送信本文を「前回のコマンド」として退避する。入力欄はクリアしない方針
    // (reset() は references だけ落とす) だが、ユーザーがクリア/微修正した後でも
    // 「前回を復元」で1クリック復帰できるようにする。
    if (trimmed) useComposer.getState().recordSent(trimmed);
    const finalPrompt = buildGoriPrompt(trimmed, {
      primaryMode: workflow.primaryMode,
      videoMode: workflow.videoMode,
      imageMode: workflow.imageMode,
      hasReference: effectiveReferences.length > 0,
      referenceSummary: describeReferencesForPrompt(effectiveReferences),
    });

    // 全画像生成 (新規 / ref 編集 / mask 編集 / count=1 含む) を batch 経路
    // (codex exec 並列) に統合。経路を 1 つにすることで:
    // - チャットの並びが一貫する (app-server の「応答生成中…」が混じらない)
    // - count を常に尊重する (mask 編集も N 枚並列)
    // - 履歴記録も batch turn 1 系統に集約される
    const refImagePaths = effectiveReferences.map((r) => r.path);
    const maskPaths = effectiveReferences.map((r) => r.maskPath ?? "");

    reset();
    const t = useThreads.getState();
    useThreads.setState({ sending: true });

    const tempId = `local-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    useBatches.getState().startBatch({
      batchId: tempId,
      prompt: trimmed,
      references: effectiveReferences.map((r) => ({ path: r.path, name: r.name })),
      count: snap.count,
      // このコンポーザーは常に codex の image_gen 経路で生成する
      // (Higgsfield/Magnific の選択UIは制作タブ側にしか無い)。
      // タイムラインで「どのモデルで作ったか」を出すため provider/モデル名を渡す。
      provider: "codex",
      modelDisplayName: t.selectedModel ?? "image_gen",
    });

    const sess = useSessions.getState();
    const dbTurnId = await sess.recordTurn({
      sessionId: sess.activeSessionId ?? "",
      prompt: trimmed || finalPrompt,
      model: t.selectedModel,
      effort: t.selectedEffort,
      refImagePaths,
      count: snap.count,
      kind: "batch",
    });
    sess.enqueueBatchDbTurnId(dbTurnId);

    try {
      const result = await imagesIpc.generateBatch({
        prompt: finalPrompt,
        count: snap.count,
        cwd: t.cwd,
        refImagePaths,
        maskPaths,
        model: t.selectedModel,
        effort: t.selectedEffort,
        aspect: snap.aspect,
      });
      const okCount = result.generatedPaths.length;
      // 失敗時はバックエンド(batch_gen)が返す真因 errors[] の先頭をトーストに出す。
      // なぜ: 件数だけだと「なぜ失敗したか(NSFW/タイムアウト/codex起動失敗等)」が
      // 分からず、ユーザーは原因に対処できない。理由が複数でも最初の1件を代表表示する。
      const firstReason = result.errors?.find((e) => e && e.trim().length > 0)?.trim();
      pushToast({
        kind: result.failedCount === 0 ? "success" : "warn",
        text:
          result.failedCount === 0
            ? `${okCount} 枚を生成しました`
            : firstReason
              ? `${okCount}/${snap.count} 枚を生成 (${result.failedCount} 件失敗) — ${firstReason}`
              : `${okCount}/${snap.count} 枚を生成 (${result.failedCount} 件失敗)`,
        ttlMs: result.failedCount === 0 ? 4000 : 7000,
      });
    } catch (err) {
      console.error("generateBatch failed", err);
      useBatches.getState().removeBatch(tempId);
      pushToast({
        kind: "error",
        text: `画像生成に失敗: ${String(err)}`,
      });
      setText(trimmed);
      useComposer.getState().addReferences(snap.references);
    } finally {
      useThreads.setState({ sending: false });
    }
  };

  const pickFiles = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = Array.isArray(r) ? r : [r];
      addReferences(
        paths
          .filter((p): p is string => typeof p === "string")
          .map((p) => ({ path: p, name: basename(p), source: "upload" })),
      );
    } catch (err) {
      console.warn("dialog open failed", err);
      // Fallback to <input type=file> in the rare case the plugin fails.
      fileInputRef.current?.click();
    }
  };

  /**
   * Clipboard paste: if the system clipboard carries an image (e.g. from
   * macOS Cmd+Shift+4 → Clipboard, or copied from a browser), persist the
   * bytes to `~/.codex/generated_images/clipboard/` so we get a real
   * filesystem path Codex can reference, then attach it as a Composer
   * reference. We swallow the default paste behaviour for image items
   * so the textarea doesn't also receive the paste.
   */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((it) => it.type.startsWith("image/"));
    if (imageItems.length === 0) return; // text paste: let the browser handle it
    e.preventDefault();
    const newRefs: Reference[] = [];
    for (const it of imageItems) {
      const file = it.getAsFile();
      if (!file) continue;
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        const path = await imagesIpc.writeClipboard(buf);
        newRefs.push({
          path,
          name: file.name && file.name !== "image.png" ? file.name : `clip-${Date.now()}.png`,
          source: "upload",
        });
      } catch (err) {
        console.error("clipboard paste failed", err);
        pushToast({
          kind: "error",
          text: `クリップボード画像の保存に失敗: ${String(err)}`,
          ttlMs: 5000,
        });
      }
    }
    if (newRefs.length > 0) {
      addReferences(newRefs);
      pushToast({
        kind: "success",
        text: `${newRefs.length} 枚をクリップボードから添付しました`,
        ttlMs: 2500,
      });
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const draggedRef = parseDraggedReference(e);
    if (draggedRef) {
      addReferences([draggedRef]);
      pushToast({
        kind: "success",
        text: "生成履歴から参照画像に追加しました",
        ttlMs: 2500,
      });
      return;
    }
    const droppedText = e.dataTransfer.getData("text/plain")?.trim();
    if (droppedText && (e.dataTransfer.files?.length ?? 0) === 0) {
      setText(text.trim() ? `${text.trim()}\n${droppedText}` : droppedText);
      pushToast({
        kind: "success",
        text: "指示を入力欄に追加しました",
        ttlMs: 2200,
      });
      return;
    }
    const newRefs: Reference[] = [];
    let skipped = 0;
    for (const f of Array.from(e.dataTransfer.files ?? [])) {
      if (!f.type.startsWith("image/")) {
        skipped++;
        continue;
      }
      // Tauri exposes the real path on the dropped File object as a
      // non-standard property in some environments. If it is absent, we
      // persist the bytes under ~/.codex/generated_images/uploads/ and use
      // that stable path as the reference.
      const maybePath = (f as unknown as { path?: string }).path;
      if (maybePath) {
        newRefs.push({
          path: maybePath,
          name: f.name,
          source: "upload",
          role: "subject",
        });
      } else {
        try {
          newRefs.push(await fileToUploadReference(f));
        } catch (err) {
          console.error("drop upload failed", err);
          pushToast({
            kind: "error",
            text: `ドロップ画像の保存に失敗: ${String(err)}`,
            ttlMs: 5000,
          });
        }
      }
    }
    if (newRefs.length > 0) {
      addReferences(newRefs);
      pushToast({
        kind: "success",
        text: `${newRefs.length} 枚を参照画像に追加しました`,
        ttlMs: 2500,
      });
    } else if (skipped > 0) {
      pushToast({
        kind: "warn",
        text: "画像ファイルだけをドロップしてください",
        ttlMs: 3500,
      });
    }
  };

  const onPickerChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    // Tauri exposes the real path; if not present (web build) we can't
    // pass it to codex.
    const newRefs: Reference[] = [];
    for (const f of files) {
      const p = (f as unknown as { path?: string }).path;
      if (p) {
        newRefs.push({ path: p, name: f.name, source: "upload", role: "subject" });
      } else if (f.type.startsWith("image/")) {
        try {
          newRefs.push(await fileToUploadReference(f));
        } catch (err) {
          console.error("file picker upload failed", err);
          pushToast({
            kind: "error",
            text: `画像の保存に失敗: ${String(err)}`,
            ttlMs: 5000,
          });
        }
      }
    }
    if (newRefs.length > 0) {
      addReferences(newRefs);
      pushToast({
        kind: "success",
        text: `${newRefs.length} 枚を参照画像に追加しました`,
        ttlMs: 2500,
      });
    }
  };

  const hasMask = references.some((r) => !!r.maskPath);
  const primaryMode = useWorkflow((s) => s.primaryMode);
  const imageMode = useWorkflow((s) => s.imageMode);
  const videoMode = useWorkflow((s) => s.videoMode);

  return (
    <div
      className={`relative ${
        embedded
          ? dark
            ? "border-t border-[#242424] px-3 py-3"
            : "border-t border-neutral-100 px-4 py-3"
          : "mx-6 mb-5 rounded-2xl border border-neutral-200 bg-white px-4 py-4 shadow-[0_18px_45px_rgba(15,23,42,0.10)]"
      } transition ${
        showDropOverlay ? "ring-2 ring-blue-400/70 ring-inset" : ""
      }`}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes("Files") ||
          e.dataTransfer.types.includes(REFERENCE_DRAG_MIME) ||
          e.dataTransfer.types.includes("application/json") ||
          e.dataTransfer.types.includes("text/plain")
        ) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {showDropOverlay && (
        <div className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm font-semibold backdrop-blur-sm ${
          dark ? "bg-[#111]/90 text-white" : "bg-blue-50/90 text-neutral-950"
        }`}>
          ここに画像をドロップして参照に追加
        </div>
      )}

      {references.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={`text-[11px] font-semibold ${dark ? "text-neutral-300" : "text-neutral-700"}`}>
            参照画像 ({references.length})
          </span>
          <div className="flex flex-wrap gap-2">
            {references.map((ref) => (
              <ReferenceChip
                key={ref.path}
                ref_={ref}
                onOpenMask={() =>
                  openMaskEditor({ path: ref.path, name: ref.name })
                }
                onClearMask={() => clearMaskFor(ref.path)}
                onRemove={() => removeReference(ref.path)}
                onRoleChange={(role) => setReferenceRole(ref.path, role)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        {text.trim().length === 0 && references.length === 0 && (
          <div className="mb-2">
            <span className={`rounded border border-dashed px-2 py-1 text-[11px] ${
              dark ? "border-[#343434] bg-[#171717] text-neutral-400" : "border-neutral-300 bg-neutral-50 text-neutral-500"
            }`}>
              画像・履歴カードをここへドロップできます
            </span>
            {!dark && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <PromptPresetButton
                  label="広告縦動画"
                  onClick={() => setText(verticalAdPrompt())}
                />
                <PromptPresetButton
                  label="商品カット"
                  onClick={() => setText(productCutPrompt())}
                />
                <PromptPresetButton
                  label="映画風素材カット"
                  onClick={() => setText(cinematicBrollPrompt())}
                />
              </div>
            )}
          </div>
        )}
        {showSuggestions && (
          <ul
            className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 text-neutral-950 shadow-xl"
            role="listbox"
            aria-label="保存済みプロンプト候補"
          >
            <li className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-500">
              保存済みプロンプト ({matches.length})
            </li>
            {matches.map((p, i) => {
              const active = i === suggestIdx;
              return (
                <li
                  key={p.id}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    // mousedown so the textarea doesn't blur first.
                    e.preventDefault();
                    pickSuggestion(p);
                  }}
                  onMouseEnter={() => setSuggestIdx(i)}
                  className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-xs ${
                    active
                      ? "bg-blue-50 text-neutral-950"
                      : "text-neutral-700 hover:bg-neutral-100"
                  }`}
                  title={p.body}
                >
                  <span className="flex items-center gap-1.5">
                    {p.pinned && (
                      <span className="rounded border border-amber-200 bg-amber-50 px-1 text-[9px] font-semibold text-amber-700" aria-hidden>
                        P
                      </span>
                    )}
                    <span className="truncate font-medium">{p.title || "(無題)"}</span>
                  </span>
                  <span className="line-clamp-1 text-[10px] text-neutral-500">
                    {p.body}
                  </span>
                </li>
              );
            })}
            <li className="border-t border-neutral-200 px-3 py-1 text-[10px] text-neutral-500">
              上下キーで選択 · Enter / Tab で確定 · Esc で閉じる
            </li>
          </ul>
        )}
        <textarea
          rows={embedded ? (dark ? 9 : 2) : 3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Slash-suggestion navigation takes priority while the popover
            // is open. Cmd+Enter for submit still wins (composer can be
            // submitted with the popover open if the user wants).
            if (showSuggestions && !(e.metaKey || e.ctrlKey)) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSuggestIdx((i) => Math.min(matches.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSuggestIdx((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickSuggestion(matches[suggestIdx]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setText(""); // close popover by dropping the leading "/"
                return;
              }
            }
            // 2026-07-27: アプリ内の入力欄で送信キーが画面ごとに違っていたため、
            // Enter=送信 / Shift+Enter=改行 に統一した (企画チャット / 絵コンテ / 3D と同じ)。
            // 変換確定の Enter を送信と取り違えないよう isComposing でガードする。
            const isComposing =
              (e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229;
            if (e.key !== "Enter" || isComposing) return;
            if (e.shiftKey) return; // 改行
            e.preventDefault();
            submit();
          }}
          placeholder={placeholder(references, hasMask, primaryMode, imageMode, videoMode)}
          className={`w-full resize-none rounded-xl border px-3 py-2.5 text-sm leading-relaxed shadow-sm outline-none placeholder:text-neutral-500 focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 ${
            dark
              ? "border-[#343434] bg-[#151515] text-neutral-100"
              : "border-neutral-300 bg-white text-neutral-950 focus:border-blue-500 focus:ring-blue-100"
          }`}
        />
      </div>

      {/* Action row beneath the textarea — utility actions on the left,
          generation controls on the right. Keeps the textarea full-width
          (better drop target) and gives every button a label. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <ActionButton
            onClick={pickFiles}
            icon="+"
            label="画像を追加"
            title="画像を添付 (複数選択可)"
            ariaLabel="画像を添付"
            dark={dark}
          />
          {/*
            Command Dock W3-1: 制作コマンドを「チャット」から「コマンド」体験へ。
            - クリア: 送信後もプロンプトは残る方針 (reset() は references だけ落とす)
              ので、意図的に消したいときの明示ボタン。誤爆で全消しにならないよう
              入力が空のときは無効化する。
            - 前回を復元: 直近送信した制作コマンドを1クリックで入力欄へ戻す。
          */}
          <ActionButton
            onClick={() => {
              if (text.length === 0) return;
              clearText();
            }}
            icon=""
            label="クリア"
            title="入力欄を空にする (参照画像は残る)"
            ariaLabel="制作コマンドをクリア"
            disabled={text.length === 0}
            dark={dark}
          />
          <ActionButton
            onClick={() => {
              const ok = restoreLastText();
              pushToast(
                ok
                  ? { kind: "success", text: "前回のコマンドを戻しました", ttlMs: 2200 }
                  : { kind: "info", text: "戻せる前回のコマンドがありません", ttlMs: 2600 },
              );
            }}
            icon=""
            label="前回を復元"
            title="直近に送信した制作コマンドを入力欄へ戻す"
            ariaLabel="前回の制作コマンドを復元"
            disabled={!lastSentText}
            dark={dark}
          />
          {dark ? (
            <details className="relative">
              <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-[#343434] bg-[#1e1e1e] px-2.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-white">
                詳細
              </summary>
              <div className="absolute left-0 top-9 z-20 w-44 rounded-lg border border-[#343434] bg-[#181818] p-1.5 shadow-2xl">
                <button
                  type="button"
                  onClick={() => setLibraryOpen(true)}
                  className="block h-8 w-full rounded-md px-2 text-left text-xs font-bold text-neutral-300 hover:bg-[#242424] hover:text-white"
                >
                  プロンプトを呼び出す
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (text.trim().length === 0) {
                      pushToast({
                        kind: "warn",
                        text: "保存するプロンプトを入力してください",
                      });
                      return;
                    }
                    setSaveDraftOpen(true);
                  }}
                  className="block h-8 w-full rounded-md px-2 text-left text-xs font-bold text-neutral-300 hover:bg-[#242424] hover:text-white"
                >
                  指示を保存
                </button>
              </div>
            </details>
          ) : (
            <>
              <ActionButton
                onClick={() => setLibraryOpen(true)}
                icon=""
                label="プロンプト"
                title="保存済みプロンプトを開く"
                ariaLabel="プロンプトライブラリを開く"
              />
              <ActionButton
                onClick={() => {
                  if (text.trim().length === 0) {
                    pushToast({
                      kind: "warn",
                      text: "保存するプロンプトを入力してください",
                    });
                    return;
                  }
                  setSaveDraftOpen(true);
                }}
                icon=""
                label="保存"
                title="現在のプロンプトを保存"
                ariaLabel="プロンプトを保存"
                tone="amber"
              />
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className={`flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${dark ? "text-neutral-300" : "text-neutral-600"}`}>
            比率
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as FrameAspect)}
              className={`rounded border px-1.5 py-0.5 text-sm ${
                dark ? "border-[#343434] bg-[#171717] text-neutral-100" : "border-neutral-300 bg-white text-neutral-950"
              }`}
              title="動画フレームの縦横比"
            >
              {ASPECT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className={`flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${dark ? "text-neutral-300" : "text-neutral-600"}`}>
            フレーム
            <input
              type="number"
              min={1}
              max={24}
              value={count}
              onChange={(e) => setCount(Number(e.target.value) || 1)}
              className={`w-12 rounded border px-1 py-0.5 text-center text-sm ${
                dark ? "border-[#343434] bg-[#171717] text-neutral-100" : "border-neutral-300 bg-white text-neutral-950"
              }`}
            />
          </label>
          {isStreaming ? (
            <button
              onClick={() => interruptActiveTurn()}
              className="rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-rose-500"
            >
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={
                sending ||
                (text.trim().length === 0 &&
                  references.length === 0 &&
                  !lockedReferenceForButton)
              }
              className={`rounded-md border px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40 ${
                dark
                  ? "border-pink-500 bg-pink-500 hover:bg-pink-400"
                  : "border-neutral-950 bg-neutral-950 hover:bg-neutral-800"
              }`}
            >
              生成
            </button>
          )}
        </div>
      </div>

      {/* Hidden picker as a fallback when plugin-dialog isn't available
          (e.g. during pre-Tauri-bundle dev / Playwright). */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onPickerChange}
      />

      <PromptLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
      />
      <PromptEditorModal
        open={saveDraftOpen}
        mode={{ kind: "create", initialBody: text }}
        onClose={() => setSaveDraftOpen(false)}
      />
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  title,
  ariaLabel,
  tone,
  dark,
  disabled,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  title: string;
  ariaLabel: string;
  tone?: "amber";
  dark?: boolean;
  disabled?: boolean;
}) {
  const hover =
    tone === "amber"
      ? "hover:border-neutral-500 hover:text-neutral-950"
      : "hover:border-neutral-500 hover:text-neutral-950";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        dark
          ? "border-[#343434] bg-[#1e1e1e] text-neutral-300 hover:border-neutral-500 hover:text-white"
          : `border-neutral-300 bg-white text-neutral-700 ${hover}`
      }`}
    >
      {icon && <span aria-hidden>{icon}</span>}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

function PromptPresetButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 hover:text-neutral-950"
    >
      {label}
    </button>
  );
}

function verticalAdPrompt(): string {
  return [
    "9:16 vertical short-video ad frame sequence.",
    "Create coherent consecutive keyframes for a premium Japanese social ad.",
    "Subject: {商品/人物/サービス}.",
    "Scene progression: hook close-up -> use scene -> emotional payoff -> clean end-card-like visual without text.",
    "Style: refined Japanese commercial photography, natural skin, realistic lighting, no text, no logos.",
    "Keep the same subject identity, outfit, color palette, lens language, and location across all frames.",
  ].join("\n");
}

function productCutPrompt(): string {
  return [
    "Video production keyframe sequence for product shots.",
    "Subject: {商品名/形状/素材}.",
    "Generate consecutive frames with small camera and lighting variations: macro texture, three-quarter hero, hand interaction, lifestyle context.",
    "Style: high-end Japanese D2C product photography, soft directional light, tactile material detail, clean background, no text.",
    "Maintain exact product design consistency across every frame.",
  ].join("\n");
}

function cinematicBrollPrompt(): string {
  return [
    "Cinematic B-roll keyframe sequence.",
    "Subject and mood: {被写体と感情}.",
    "Frame progression should feel like a short camera move: establishing shot, medium detail, close-up texture, atmospheric transition.",
    "Style: realistic cinema still, 35mm lens language, controlled depth of field, natural motion blur, subtle film grain, no text.",
    "Keep environment, character, and color grading consistent across all frames.",
  ].join("\n");
}

function buildGoriPrompt(
  userPrompt: string,
  opts: {
    primaryMode: "image" | "video";
    videoMode: VideoMode;
    imageMode: ImageMode;
    hasReference: boolean;
    referenceSummary: string;
  },
): string {
  const base =
    userPrompt ||
    (opts.primaryMode === "video"
      ? "Generate the next usable production cut from the locked reference."
      : "Generate a polished commercial image asset.");
  const common = [
    "GORI GORI KUN generation rules:",
    "- The user brief is the primary creative objective. Use the reference to preserve the requested subject/style, but do not simply recreate the reference unless the user explicitly asks for an exact variation.",
    "- When the user asks for an ad image, key visual, thumbnail, product visual, poster, LP asset, or social creative, transform the reference into that deliverable with clear commercial composition, intentional negative space, and a finished production look.",
    "- Output exactly one independent image for this worker. Never create a grid, collage, contact sheet, or labeled multi-panel image.",
    "- Do not add visible text, captions, watermarks, or logos unless explicitly requested.",
    "- Keep the result production-ready for editing: clean subject edges, clear foreground/background separation, no unnecessary effects.",
  ];

  if (opts.primaryMode === "video") {
    const mode =
      opts.videoMode === "story"
        ? [
            "Mode: story cut.",
            "Use the reference as the identity/look anchor, then apply the user brief as the actual production direction.",
            "Generate one storyboard or advertising cut that visibly changes the scene, framing, role, mood, or composition as needed to satisfy the user brief.",
            "Maintain the same subject identity, key visual traits, environment logic, color palette, lens language, and lighting continuity only where it helps continuity.",
            "Do not produce near-duplicates of the reference. Each frame should be a useful next cut or ad-ready variation with a readable creative purpose.",
          ]
        : [
            "Mode: multi-angle.",
            "Use the attached reference as a fixed scene anchor and perform an internal visual analysis before generating.",
            "Internally extract style keywords in English across these seven categories: Lighting, Color Palette, Atmosphere, Lens/Camera, Texture/Material, Mood/Tone, Reference Style.",
            "Internally describe the subject in detail: gender or object type, hair, facial features, expression, outfit, pose, hand position, body direction, accessories, background, location, and environmental elements.",
            "If the user explicitly requests a subject change, replace only the subject while preserving the reference look, camera logic, location, lighting, palette, and material feel.",
            "AR inheritance: preserve the selected output aspect ratio for every generated frame. Do not create a grid, collage, contact sheet, or multi-panel image.",
            "Keep subject position, environment, props, lighting, timing, and spatial relationships identical across the batch.",
            "Only move the camera angle, camera height, focal length, framing, and viewpoint. Do not change the action, scene beat, environment, outfit, object design, color palette, or lighting setup.",
            "Distribute camera angles across the batch using this sequence by frame index: extreme close-up, medium shot, over-the-shoulder, wide shot, high-angle top-down, low-angle, profile, three-quarter rear view, full back view. If the batch has fewer frames, use the first N angles. If it has more, cycle with subtle lens/framing variations.",
            "Use all extracted look keywords naturally in the final image generation prompt. Do not output the analysis table; generate only the requested single frame.",
            "The result should feel like one frame from a professional cinematic camera study: ultra-realistic photography, film-still aesthetic, consistent subject appearance, no visible text.",
          ];
    return [
      ...common,
      ...mode,
      opts.hasReference
        ? "- The attached image is the primary reference and must be respected."
        : "- No reference is attached, so create a stable first anchor frame.",
      opts.referenceSummary,
      "",
      "User brief:",
      base,
    ].join("\n");
  }

  const imageMode =
    opts.imageMode === "layers"
      ? [
          "Mode: image layer planning.",
          "Generate a composite-friendly image with separable foreground subject, background, text-safe areas, and clean material boundaries.",
          "Avoid baked-in text unless explicitly requested. Leave usable negative space for later text layers.",
        ]
      : opts.imageMode === "edit"
        ? [
            "Mode: image edit.",
            "Use attached references as editable source material. Preserve the source identity and only change what the user requested.",
          ]
        : [
            "Mode: image generation.",
            "Generate a polished commercial still image. Prioritize clear composition, useful crop, and asset usability.",
          ];
  return [
    ...common,
    ...imageMode,
    opts.referenceSummary,
    "",
    "User brief:",
    base,
  ].join("\n");
}

function ReferenceChip({
  ref_,
  onOpenMask,
  onClearMask,
  onRemove,
  onRoleChange,
}: {
  ref_: Reference;
  onOpenMask: () => void;
  onClearMask: () => void;
  onRemove: () => void;
  onRoleChange: (role: ReferenceRole) => void;
}) {
  const hasMask = !!ref_.maskPath;
  return (
    <div className="flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 p-1">
      <div
        className={`group relative h-14 w-14 overflow-hidden rounded border-2 ${
        hasMask ? "border-fuchsia-500/70" : "border-blue-500/70"
      }`}
        title={ref_.name}
      >
        <img
          src={convertFileSrc(ref_.path)}
          alt={ref_.name}
          className="h-full w-full object-cover"
        />
        {hasMask && (
          <span
            className="pointer-events-none absolute bottom-0 left-0 right-0 bg-fuchsia-500/80 text-center text-[9px] font-bold uppercase tracking-wider text-white"
            aria-label="マスク付き"
          >
            mask
          </span>
        )}
        {ref_.source === "upload" && !hasMask && (
          <span
            className="pointer-events-none absolute bottom-0 right-0 rounded-tl bg-blue-500/80 px-1 text-[9px] font-bold text-white"
            aria-label="アップロード画像"
          >
            ↑
          </span>
        )}
        {hasMask ? (
          <button
            onClick={onClearMask}
            className="absolute bottom-0 left-0 flex h-5 w-5 items-center justify-center bg-black/70 text-[10px] text-white opacity-0 transition group-hover:opacity-100 hover:bg-rose-600"
            aria-label="マスクを外す"
            title="マスクを外す"
          >
            X
          </button>
        ) : (
          <button
            onClick={onOpenMask}
            className="absolute bottom-0 left-0 flex h-5 w-5 items-center justify-center bg-black/60 text-[10px] text-white opacity-0 transition group-hover:opacity-100 hover:bg-blue-600"
            aria-label="マスクで編集"
            title="マスクで編集"
          >
            M
          </button>
        )}
        <button
          onClick={onRemove}
          className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/70 text-xs text-white opacity-0 transition group-hover:opacity-100"
          aria-label="添付から外す"
          title="外す"
        >
          X
        </button>
      </div>
      <div className="min-w-28">
        <p className="max-w-36 truncate text-[10px] font-medium text-neutral-700" title={ref_.name}>
          {ref_.name}
        </p>
        <select
          value={ref_.role ?? "subject"}
          onChange={(e) => onRoleChange(e.target.value as ReferenceRole)}
          className="mt-1 w-full rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px] text-neutral-800"
          title="この参照画像から何を引き継ぐか"
        >
          {REFERENCE_ROLE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

const REFERENCE_ROLE_OPTIONS: Array<[ReferenceRole, string]> = [
  ["subject", "被写体固定"],
  ["look", "ルック参照"],
  ["background", "背景参照"],
  ["product", "商品固定"],
  ["pose", "ポーズ参照"],
  ["negative", "NG参照"],
];

function referenceRoleInstruction(role: ReferenceRole | undefined): string {
  switch (role ?? "subject") {
    case "subject":
      return "preserve the main subject identity and recognizable traits";
    case "look":
      return "inherit lighting, color palette, atmosphere, lens feel, texture, and mood, but change the subject/composition if requested";
    case "background":
      return "inherit the location, environment, spatial layout, and background mood";
    case "product":
      return "preserve the product/object shape, material, color, branding-free details, and design consistency";
    case "pose":
      return "inherit pose, gesture, body direction, and camera relationship";
    case "negative":
      return "avoid copying this reference; treat it as a negative example of what not to generate";
  }
}

function describeReferencesForPrompt(references: Reference[]): string {
  if (references.length === 0) return "";
  const lines = references.map((ref, index) => {
    const role = ref.role ?? "subject";
    return `- Reference ${index + 1} (${role}): ${referenceRoleInstruction(role)}. File: ${ref.name}`;
  });
  return [
    "Reference role instructions:",
    ...lines,
    "- If reference roles conflict with the user brief, satisfy the user brief first and preserve only the useful reference attributes.",
  ].join("\n");
}

function placeholder(
  refs: Reference[],
  hasMask: boolean,
  primaryMode: "image" | "video",
  imageMode: ImageMode,
  videoMode: VideoMode,
): string {
  if (hasMask) {
    return "マスク領域をどうしたいか入力 (例: 帽子をかぶせる) ⌘/Ctrl+Enter";
  }
  if (refs.length > 1) {
    return `${refs.length} 枚をどう編集・合成したいか入力 (⌘/Ctrl+Enter)`;
  }
  if (refs.length === 1) {
    return "リファレンスをどう変更したいか入力 (⌘/Ctrl+Enter)";
  }
  if (primaryMode === "video") {
    return videoMode === "multiAngle"
      ? "固定したい世界観と動かしたいカメラ角度を書く (例: 低い位置から商品を見上げる / ⌘+Enter)"
      : "次に欲しい動画カットを書く (例: 商品を手に取る寄りのカット / ⌘+Enter)";
  }
  if (imageMode === "edit") {
    return "どこをどう直したいかを書く (例: 背景を白基調にして商品は維持 / ⌘+Enter)";
  }
  if (imageMode === "layers") {
    return "分けたい要素を書く (例: 背景、人物、商品、文字を編集しやすく分離 / ⌘+Enter)";
  }
  return "作りたい画像を短く書く (例: LPのキービジュアル用の商品カット / ⌘+Enter)";
}

// 旧 buildInputItems / composeText (app-server 経由 turn/start 用) は
// すべての画像生成を batch 経路 (codex exec) に統合したため削除。
// マスク有り inpainting 用の prompt 組み立ては src-tauri 側
// `commands/batch_gen.rs::build_final_prompt` に集約されている。
