import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useMaskEditor } from "../lib/store/maskEditor";
import { useComposer } from "../lib/store/composer";
import { useToasts } from "../lib/store/toasts";
import { images as imagesIpc } from "../lib/ipc";
import {
  MaskCanvas,
  type MaskCanvasHandle,
  type MaskMode,
} from "./MaskCanvas";

export function MaskEditorModal() {
  const source = useMaskEditor((s) => s.source);
  if (!source) return null;
  return <Modal key={source.path} />;
}

function Modal() {
  const source = useMaskEditor((s) => s.source)!;
  const close = useMaskEditor((s) => s.close);
  const composer = useComposer.getState;
  const pushToast = useToasts((s) => s.push);
  const canvasRef = useRef<MaskCanvasHandle | null>(null);
  const [brushSize, setBrushSize] = useState(40);
  const [mode, setMode] = useState<MaskMode>("paint");
  const [opacity, setOpacity] = useState(0.5);
  const [busy, setBusy] = useState(false);
  // Bumped on every stroke/clear/undo so the toolbar re-evaluates canUndo.
  const [version, setVersion] = useState(0);

  const onConfirm = async () => {
    const c = canvasRef.current;
    if (!c) return;
    setBusy(true);
    try {
      const blob = await c.toBlob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const maskPath = await imagesIpc.writeMask(source.path, bytes);

      // Attach the mask to the matching reference. If the source isn't
      // attached yet (e.g. opened from the gallery without first
      // attaching), add it now.
      const composerState = composer();
      const exists = composerState.references.some(
        (r) => r.path === source.path,
      );
      if (!exists) {
        composerState.addReference({
          path: source.path,
          name: source.name,
          source: "gallery",
        });
      }
      composerState.setMaskFor(source.path, maskPath);

      pushToast({
        kind: "success",
        text: "マスクを添付しました。指示を入力して送信してください。",
        ttlMs: 4500,
      });
      close();
    } catch (err) {
      console.error("mask save failed", err);
      pushToast({ kind: "error", text: `マスク保存に失敗: ${err}` });
    } finally {
      setBusy(false);
    }
  };

  const canUndo = canvasRef.current?.canUndo() ?? false;
  void version; // referenced to trigger re-evaluation when bumped

  return (
    <div
      className="fixed inset-0 z-50 flex max-h-[calc(100vh-2rem)] flex-col overflow-y-auto bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-label="マスク編集"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-neutral-100">マスク編集</h3>
          <span
            className="truncate font-mono text-[11px] text-neutral-500"
            title={source.path}
          >
            {source.name}
          </span>
        </div>
        <button
          type="button"
          onClick={close}
          className="text-neutral-500 hover:text-neutral-200"
          aria-label="閉じる"
        >
          ×
        </button>
      </div>

      <MaskToolbar
        brushSize={brushSize}
        setBrushSize={setBrushSize}
        mode={mode}
        setMode={setMode}
        opacity={opacity}
        setOpacity={setOpacity}
        canUndo={canUndo}
        onUndo={() => {
          canvasRef.current?.undo();
          setVersion((v) => v + 1);
        }}
        onClear={() => {
          canvasRef.current?.clear();
          setVersion((v) => v + 1);
        }}
        onCancel={close}
        onConfirm={onConfirm}
        busy={busy}
      />

      <div className="flex-1 overflow-hidden p-4">
        <MaskCanvas
          ref={canvasRef}
          src={convertFileSrc(source.path)}
          brushSize={brushSize}
          mode={mode}
          opacity={opacity}
          onChange={() => setVersion((v) => v + 1)}
        />
      </div>

      <div className="border-t border-neutral-800 bg-neutral-900 px-4 py-2 text-[11px] text-neutral-500">
        白く塗った領域だけが指示通りに編集されます。それ以外はオリジナルのまま残ります。
      </div>
    </div>
  );
}

function MaskToolbar(props: {
  brushSize: number;
  setBrushSize: (n: number) => void;
  mode: MaskMode;
  setMode: (m: MaskMode) => void;
  opacity: number;
  setOpacity: (n: number) => void;
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800 bg-neutral-900/50 px-4 py-2 text-xs">
      <div className="flex rounded-md border border-neutral-700 p-0.5">
        <ToggleBtn
          active={props.mode === "paint"}
          onClick={() => props.setMode("paint")}
          label="塗る"
        />
        <ToggleBtn
          active={props.mode === "erase"}
          onClick={() => props.setMode("erase")}
          label="消す"
        />
      </div>

      <label className="flex items-center gap-2 text-neutral-300">
        ブラシ
        <input
          type="range"
          min={4}
          max={200}
          value={props.brushSize}
          onChange={(e) => props.setBrushSize(Number(e.target.value))}
          className="w-32"
        />
        <span className="w-8 text-right tabular-nums text-neutral-500">
          {props.brushSize}
        </span>
      </label>

      <label className="flex items-center gap-2 text-neutral-300">
        透過
        <input
          type="range"
          min={20}
          max={90}
          value={Math.round(props.opacity * 100)}
          onChange={(e) => props.setOpacity(Number(e.target.value) / 100)}
          className="w-24"
        />
      </label>

      <div className="flex gap-1">
        <button
          type="button"
          onClick={props.onUndo}
          disabled={!props.canUndo}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
        >
          元に戻す
        </button>
        <button
          type="button"
          onClick={props.onClear}
          className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-rose-500/60 hover:text-rose-300"
        >
          全クリア
        </button>
      </div>

      <div className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-neutral-300 hover:border-neutral-500"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.busy}
          className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {props.busy ? "保存中…" : "決定して添付"}
        </button>
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active
          ? "bg-emerald-600 text-white"
          : "text-neutral-400 hover:text-neutral-100"
      }`}
    >
      {label}
    </button>
  );
}
