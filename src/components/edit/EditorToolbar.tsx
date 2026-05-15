import type { ReactNode } from "react";

import type { EditorTool } from "./editor/editorStore";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";

const TOOLS: Array<{ id: EditorTool; icon: ReactNode; label: string }> = [
  { id: "select", icon: "🖱", label: "選択" },
  { id: "bgremove", icon: "✂️", label: "人物切り抜き" },
  { id: "clickseg", icon: "🎯", label: "クリック切り抜き" },
  { id: "text-add", icon: "📝", label: "テキスト追加" },
  { id: "text-detect", icon: "🔍", label: "テキスト検出" },
  { id: "inpaint", icon: "🎨", label: "領域消去" },
  { id: "magic", icon: "✨", label: "Magic Layer" },
  { id: "redo-decompose", icon: "🔄", label: "再分解" },
];

export function EditorToolbar() {
  const active = useEditor((state) => state.activeTool);
  const busy = useEditor((state) => state.busyTool);
  const actions = useEditorActions();

  return (
    <aside className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-[#2a2a2a] bg-[#101010] py-2">
      {TOOLS.map((tool) => {
        const isBusy = busy === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            onClick={() => void actions.run(tool.id)}
            title={tool.label}
            disabled={busy !== null && !isBusy}
            className={`flex h-10 w-10 items-center justify-center rounded-md border text-xl transition hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${
              active === tool.id
                ? "border-pink-500 bg-pink-500/20 text-pink-100"
                : "border-transparent text-neutral-400"
            }`}
          >
            {isBusy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" /> : tool.icon}
          </button>
        );
      })}
    </aside>
  );
}
