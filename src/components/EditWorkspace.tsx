import { useState } from "react";

import { EditorCanvas } from "./edit/EditorCanvas";
import { EditorLayerList } from "./edit/EditorLayerList";
import { EditorPropertyPanel } from "./edit/EditorPropertyPanel";
import { EditorToolbar } from "./edit/EditorToolbar";
import { EditModeSelector } from "./edit/EditModeSelector";
import { useEditor } from "./edit/editor/editorStore";
import { useEditorActions } from "./edit/editor/useEditor";
import type { EditModeId } from "../lib/edit/modes";

/**
 * Photoshop/Canva 風の 3 カラム編集ワークスペース。
 * Rust IPC と PSD 用 LayerComposer は変更せず、編集タブ UI のみを Fabric.js ベースへ差し替える。
 */
export function EditWorkspace() {
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const busyTool = useEditor((state) => state.busyTool);
  const { chooseImage } = useEditorActions();
  // レイヤー分解モード (高速・スタンダード / 低速・高精度)。
  // 現状は表示と選択まで。高精度(SAM3)の処理接続は段階的に追加する。
  const [editMode, setEditMode] = useState<EditModeId>("standard");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#181818]">
      {/*
        β 版バナー (2026-05-15 STΛCK 指示):
        編集タブは開発中のため、ユーザーに動作不安定の可能性を明示。
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-pink-500/30 bg-pink-500/5 px-4 py-2 text-[11px] font-bold text-pink-200">
        <span className="rounded bg-pink-500 px-1.5 py-0.5 text-[9px] font-black text-white">β</span>
        <span>
          編集タブは開発中の β 版機能です。一部機能が不安定、または未実装の場合があります。
        </span>
      </div>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#242424] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-white">編集タブ</h3>
          <p className="mt-1 truncate text-xs font-bold text-neutral-500">
            {sourceImagePath ?? "画像ドロップで Magic Layer を自動実行"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void chooseImage()}
          disabled={busyTool !== null}
          className="rounded-lg bg-pink-500 px-3 py-2 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {busyTool ? "処理中…" : "画像を選ぶ"}
        </button>
      </header>

      <div className="shrink-0 border-b border-[#242424] px-4 py-3">
        <EditModeSelector activeMode={editMode} onSelectMode={setEditMode} />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <EditorToolbar />
        <EditorCanvas />
        <aside className="flex min-h-0 w-[280px] shrink-0 flex-col border-l border-[#2a2a2a] bg-[#151515]">
          <EditorLayerList />
          <EditorPropertyPanel />
        </aside>
      </div>
    </div>
  );
}

export default EditWorkspace;
