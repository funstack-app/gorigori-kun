import { useCallback, useEffect, useRef, useState } from "react";
import { images as imagesIpc } from "../../lib/ipc";
import { useComposer, ASPECT_OPTIONS, type FrameAspect } from "../../lib/store/composer";
import { useToasts } from "../../lib/store/toasts";
import { useThreads } from "../../lib/store/threads";
import {
  endExclusiveJob,
  exclusiveJobBusyMessage,
  tryBeginExclusiveJob,
  type ExclusiveJobKind,
} from "../../lib/store/sceneFromImage";
import { BLOCKOUT_PRESET_PROMPT } from "../../lib/sketch/presets";
import { SketchCanvas, type SketchCanvasHandle, type SketchMode } from "./SketchCanvas";
import { SceneFromImageDialog } from "../skills/scene3d/SceneFromImageDialog";

/** ペン色8色 (設計書 §1 論点1 の確定値)。 */
const PEN_COLORS: { id: string; label: string; value: string }[] = [
  { id: "black", label: "黒", value: "#111111" },
  { id: "white", label: "白", value: "#ffffff" },
  { id: "red", label: "赤", value: "#e11d48" },
  { id: "blue", label: "青", value: "#2563eb" },
  { id: "green", label: "緑", value: "#16a34a" },
  { id: "yellow", label: "黄", value: "#eab308" },
  { id: "brown", label: "茶", value: "#92400e" },
  { id: "skin", label: "肌", value: "#f3c6a5" },
];

/** 太さ3段 (px)。 */
const BRUSH_SIZES: { label: string; value: number }[] = [
  { label: "細", value: 4 },
  { label: "中", value: 10 },
  { label: "太", value: 24 },
];

/** キャンバス既定は 1024 長辺。 */
const CANVAS_LONG_EDGE = 1024;

/**
 * スケッチの既定比率 (STΛCK 直指示 2026-08-04)。
 *
 * 以前は composer の比率に追従していたが、ラフを描く用途では横長のほうが
 * 描きやすい。composer が縦でもスケッチは 16:9 で開き、必要ならユーザーが
 * ツールバーの比率セレクタで変える。
 */
const DEFAULT_SKETCH_ASPECT: FrameAspect = "16:9";

function canvasSizeFor(aspect: FrameAspect): { width: number; height: number } {
  const [wRatio, hRatio] = aspect.split(":").map((n) => Number(n));
  if (!wRatio || !hRatio) {
    return { width: CANVAS_LONG_EDGE, height: CANVAS_LONG_EDGE };
  }
  if (wRatio >= hRatio) {
    return {
      width: CANVAS_LONG_EDGE,
      height: Math.round((CANVAS_LONG_EDGE * hRatio) / wRatio),
    };
  }
  return {
    width: Math.round((CANVAS_LONG_EDGE * wRatio) / hRatio),
    height: CANVAS_LONG_EDGE,
  };
}

export function SketchPadModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const canvasRef = useRef<SketchCanvasHandle | null>(null);
  const addReferences = useComposer((s) => s.addReferences);
  const pushToast = useToasts((s) => s.push);

  const [aspect, setAspect] = useState<FrameAspect>(DEFAULT_SKETCH_ASPECT);
  const [color, setColor] = useState(PEN_COLORS[0].value);
  const [brushSize, setBrushSize] = useState(BRUSH_SIZES[1].value);
  const [mode, setMode] = useState<SketchMode>("draw");
  // Canvas mutations happen outside React state, so the toolbar needs an
  // explicit nudge to re-read canUndo()/isEmpty() after each stroke.
  const [, bumpVersion] = useState(0);
  const [busy, setBusy] = useState<null | "reference" | "blockout" | "scene3d">(null);
  // 3Dシーン化: スケッチを uploads/ に保存してからダイアログへ渡す (Slice D)
  const [sceneSourcePath, setSceneSourcePath] = useState<string | null>(null);

  /**
   * 同期 CAS ロック (r3 追補2)。
   *
   * React の state 更新は非同期なので、`busy` state だけでは「1フレーム内の
   * 10連打」を止められない (10 個のハンドラが全部 busy=null を読む)。
   *
   * ロック本体は sceneFromImage の**共通**排他ジョブロックを使う。ここを
   * このコンポーネント固有の ref にすると、Slice A のブロックアウト生成中に
   * Slice D の3Dシーン化が同時に走り、生成が2本になる (Sol 評価 blocking B-2)。
   * 解除は必ず try/finally で行う (例外時にロックが残ると以降ずっと押せなくなる)。
   */
  const tryBeginRun = useCallback(
    (kind: ExclusiveJobKind): string | null => tryBeginExclusiveJob(kind),
    [],
  );
  const endRun = useCallback((runId: string) => endExclusiveJob(runId), []);

  // モーダルを開くたびに既定比率 (16:9) に戻す。
  useEffect(() => {
    if (open) setAspect(DEFAULT_SKETCH_ASPECT);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const { width, height } = canvasSizeFor(aspect);

  /** 現在のキャンバスを uploads/ に PNG 保存してパスを返す。 */
  const persistSketch = async (): Promise<string> => {
    const handle = canvasRef.current;
    if (!handle) throw new Error("キャンバスが準備できていません");
    const blob = await handle.toBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return await imagesIpc.writeUpload(`sketch-${Date.now()}.png`, bytes);
  };

  const isEmpty = () => canvasRef.current?.isEmpty() ?? true;

  const onAddReference = async () => {
    if (isEmpty()) {
      pushToast({ kind: "warn", text: "まだ何も描かれていません", ttlMs: 2600 });
      return;
    }
    // 保存のみで生成はしないが、生成中に走らせる意味が無いので同じロックを通す。
    const runId = tryBeginRun("sketch-blockout");
    if (!runId) {
      pushToast({ kind: "warn", text: exclusiveJobBusyMessage(), ttlMs: 3000 });
      return; // 連打・他ジョブ実行中はここで落ちる (生成を伴うジョブは全体で1件)
    }
    setBusy("reference");
    try {
      const path = await persistSketch();
      addReferences([
        {
          path,
          name: path.split(/[\\/]/).pop() ?? "sketch.png",
          source: "sketch",
          role: "subject",
        },
      ]);
      pushToast({
        kind: "success",
        text: "スケッチを参照画像に追加しました",
        ttlMs: 2600,
      });
      onClose();
    } catch (err) {
      console.error("sketch: add reference failed", err);
      pushToast({ kind: "error", text: `スケッチの保存に失敗: ${String(err)}` });
    } finally {
      setBusy(null);
      endRun(runId);
    }
  };

  const onGenerateBlockout = async () => {
    if (isEmpty()) {
      pushToast({ kind: "warn", text: "まだ何も描かれていません", ttlMs: 2600 });
      return;
    }
    // Slice D の3Dシーン化と**同じ**ロック。生成が同時2本にならない (B-2)。
    const runId = tryBeginRun("sketch-blockout");
    if (!runId) {
      pushToast({ kind: "warn", text: exclusiveJobBusyMessage(), ttlMs: 3000 });
      return; // 連打・3Dシーン化の実行中はここで落ちる (生成は全体で1件)
    }
    setBusy("blockout");
    try {
      const path = await persistSketch();
      const t = useThreads.getState();
      // r3 追補1: 1操作 = 最大1生成。count:1 は「成果物1枚」でしかないため、
      // maxAttempts:1 でバックエンドの自動リトライ (既定3回) も同時に止める。
      // 失敗は失敗として出し、再実行はユーザーの明示操作にする。
      const result = await imagesIpc.generateBatch({
        prompt: BLOCKOUT_PRESET_PROMPT,
        count: 1,
        maxAttempts: 1,
        cwd: t.cwd,
        refImagePaths: [path],
        model: t.selectedModel,
        effort: t.selectedEffort,
        aspect,
        enforceAspect: true,
      });
      const firstReason = result.errors?.find((e) => e && e.trim().length > 0)?.trim();
      if (result.generatedPaths.length > 0) {
        pushToast({
          kind: "success",
          text: "ブロックアウトを1枚生成しました",
          ttlMs: 4000,
        });
        onClose();
      } else {
        pushToast({
          kind: "error",
          text: firstReason
            ? `ブロックアウト生成に失敗: ${firstReason}`
            : "ブロックアウト生成に失敗しました",
          ttlMs: 7000,
        });
      }
    } catch (err) {
      console.error("sketch: blockout generation failed", err);
      pushToast({ kind: "error", text: `ブロックアウト生成に失敗: ${String(err)}` });
    } finally {
      setBusy(null);
      endRun(runId);
    }
  };

  /**
   * 「3Dシーン化」(Slice D)。
   * スケッチを uploads/ に保存し、共通ブリッジのダイアログを開く。
   * 線画はそのままでは解析できないため、ブロックアウト正規化は強制ON
   * (forceBlockout=true → skipBlockout は常に false)。
   *
   * ここでモーダルを閉じないのは、ダイアログをこのモーダルの中に描画しているため
   * (閉じるとダイアログごと消える)。ダイアログを閉じたときに一緒に閉じる。
   */
  const onSendToScene3d = async () => {
    if (isEmpty()) {
      pushToast({ kind: "warn", text: "まだ何も描かれていません", ttlMs: 2600 });
      return;
    }
    // 保存だけの区間なので finally で即解放する。実際の3Dシーン化ジョブは
    // ダイアログ側が同じロックを取り直す (二重取得にしない)。
    const runId = tryBeginRun("sketch-blockout");
    if (!runId) {
      pushToast({ kind: "warn", text: exclusiveJobBusyMessage(), ttlMs: 3000 });
      return; // 連打・他ジョブ実行中はここで落ちる
    }
    setBusy("scene3d");
    try {
      setSceneSourcePath(await persistSketch());
    } catch (err) {
      console.error("sketch: save for scene3d failed", err);
      pushToast({ kind: "error", text: `スケッチの保存に失敗: ${String(err)}` });
    } finally {
      setBusy(null);
      endRun(runId);
    }
  };

  const canUndo = canvasRef.current?.canUndo() ?? false;
  const disabled = busy !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[#242424] px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-neutral-100">スケッチ</h2>
            <p className="text-[11px] text-neutral-500">
              描いた絵をそのまま参照にするか、ブロックアウト風の1枚に変換できます
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[#333] px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-500"
          >
            閉じる
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-[#242424] px-4 py-2">
          <div className="flex items-center gap-1">
            {PEN_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setColor(c.value);
                  setMode("draw");
                }}
                title={c.label}
                aria-label={`ペン色 ${c.label}`}
                // ダーク地では黒ペンのスウォッチが沈むので、常に明るい枠を付ける
                className={`h-6 w-6 rounded-full border-2 transition ${
                  mode === "draw" && color === c.value
                    ? "border-blue-400 ring-2 ring-blue-500/40"
                    : "border-neutral-500 hover:border-neutral-300"
                }`}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {BRUSH_SIZES.map((b) => (
              <button
                key={b.value}
                type="button"
                onClick={() => setBrushSize(b.value)}
                className={`rounded-md border px-2 py-1 text-[11px] font-medium ${
                  brushSize === b.value
                    ? "border-blue-500 bg-blue-500/15 text-blue-300"
                    : "border-[#333] bg-[#101010] text-neutral-300 hover:border-neutral-500"
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setMode(mode === "erase" ? "draw" : "erase")}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-medium ${
              mode === "erase"
                ? "border-blue-500 bg-blue-500/15 text-blue-300"
                : "border-[#333] bg-[#101010] text-neutral-300 hover:border-neutral-500"
            }`}
          >
            消しゴム
          </button>

          <button
            type="button"
            onClick={() => {
              canvasRef.current?.undo();
              bumpVersion((v) => v + 1);
            }}
            disabled={!canUndo}
            className="rounded-md border border-[#333] bg-[#101010] px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
          >
            戻す
          </button>

          <button
            type="button"
            onClick={() => {
              canvasRef.current?.clear();
              bumpVersion((v) => v + 1);
            }}
            className="rounded-md border border-[#333] bg-[#101010] px-2.5 py-1 text-[11px] font-medium text-neutral-300 hover:border-neutral-500"
          >
            全消し
          </button>

          <label className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-neutral-400">
            比率
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as FrameAspect)}
              title="キャンバスの縦横比 (変更すると描画がリセットされます)"
              className="rounded border border-[#333] bg-[#101010] px-1.5 py-0.5 text-xs text-neutral-100"
            >
              {ASPECT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 p-3">
          <SketchCanvas
            ref={canvasRef}
            width={width}
            height={height}
            color={color}
            brushSize={brushSize}
            mode={mode}
            onChange={() => bumpVersion((v) => v + 1)}
          />
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[#242424] px-4 py-3">
          <button
            type="button"
            onClick={onSendToScene3d}
            disabled={disabled}
            title="描いた絵から3Dシーンを組み立てます"
            className="rounded-md border border-[#333] bg-[#101010] px-3 py-1.5 text-xs font-medium text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
          >
            {busy === "scene3d" ? "保存中…" : "3Dシーン化"}
          </button>
          <button
            type="button"
            onClick={onGenerateBlockout}
            disabled={disabled}
            className="rounded-md border border-[#333] bg-[#101010] px-3 py-1.5 text-xs font-bold text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
          >
            {busy === "blockout" ? "生成中…" : "ブロックアウト生成"}
          </button>
          <button
            type="button"
            onClick={onAddReference}
            disabled={disabled}
            className="rounded-md border border-neutral-100 bg-neutral-100 px-4 py-1.5 text-xs font-bold text-neutral-950 hover:bg-white disabled:opacity-40"
          >
            {busy === "reference" ? "保存中…" : "参照に追加"}
          </button>
        </footer>
      </div>

      {/* 3Dシーン化ダイアログ。線画なので正規化は強制ON */}
      <SceneFromImageDialog
        open={sceneSourcePath !== null}
        imagePath={sceneSourcePath}
        forceBlockout
        onClose={() => {
          setSceneSourcePath(null);
          onClose();
        }}
      />
    </div>
  );
}
