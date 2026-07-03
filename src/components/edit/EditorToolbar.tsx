import type { ReactNode } from "react";

import type { EditorTool } from "./editor/editorStore";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";

// 基本の画像編集に必要なものだけを常設する (2026-07-03 STΛCK指摘「メニューが多すぎる」)。
// 旧方式の分解・人物切り抜き・マジックグラブ・テキスト検出は右パネルの「上級者向け」へ。
const TOOLS: Array<{ id: EditorTool; icon: ReactNode; label: string }> = [
  { id: "select", icon: <CursorIcon />, label: "選択" },
  { id: "words", icon: <WordsIcon />, label: "ことばで分離" },
  { id: "text-add", icon: <TextIcon />, label: "テキスト追加" },
  { id: "clickseg", icon: <TargetIcon />, label: "クリック切り抜き" },
  { id: "inpaint", icon: <EraserIcon />, label: "領域消去" },
];

export function EditorToolbar() {
  const active = useEditor((state) => state.activeTool);
  const busy = useEditor((state) => state.busyTool);
  const canUndo = useEditor((state) => state.canUndo);
  const canRedo = useEditor((state) => state.canRedo);
  const actions = useEditorActions();

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[#2a2a2a] bg-[#1a1a1a] py-2">
      {TOOLS.map((tool) => {
        const isBusy = busy === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            onClick={() => void actions.run(tool.id)}
            title={tool.label}
            disabled={busy !== null && !isBusy}
            className={`flex h-10 w-10 items-center justify-center rounded-md border transition hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${
              active === tool.id
                ? "border-pink-500 bg-pink-500/20 text-pink-100"
                : "border-transparent text-neutral-400"
            }`}
          >
            {isBusy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
            ) : (
              tool.icon
            )}
          </button>
        );
      })}

      {/* 区切り + Undo/Redo。ツールではなく履歴操作なので下部に分けて置く。 */}
      <span className="my-1 h-px w-6 bg-[#2a2a2a]" aria-hidden />
      <button
        type="button"
        onClick={() => void actions.performUndo()}
        title="元に戻す (⌘Z)"
        disabled={!canUndo}
        className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-neutral-400 transition hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      >
        <UndoIcon />
      </button>
      <button
        type="button"
        onClick={() => void actions.performRedo()}
        title="やり直す (⇧⌘Z)"
        disabled={!canRedo}
        className="flex h-10 w-10 items-center justify-center rounded-md border border-transparent text-neutral-400 transition hover:bg-[#1a1a1a] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
      >
        <RedoIcon />
      </button>
    </aside>
  );
}

/* --- フラットアイコン (絵文字を廃止。stroke 1.6 / 20px で統一) --- */

const SVG_PROPS = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CursorIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M4 3l7 17 2.5-6.5L20 11 4 3z" />
    </svg>
  );
}


function TargetIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M5 6h14M5 6V4.5h14V6M12 6v13M9 19h6" />
    </svg>
  );
}



function EraserIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M8 19l-4-4a1.5 1.5 0 010-2L13 4a1.5 1.5 0 012 0l5 5a1.5 1.5 0 010 2l-8 8H8z" />
      <path d="M8 19h12" />
    </svg>
  );
}


function WordsIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M4 5h16v11H9l-4 4V5z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}


function UndoIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h11a5 5 0 015 5v1" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg {...SVG_PROPS} aria-hidden>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12H9a5 5 0 00-5 5v1" />
    </svg>
  );
}
