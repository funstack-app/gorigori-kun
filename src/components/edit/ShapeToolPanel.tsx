import { useState } from "react";

import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";

const SHAPES: Array<{ kind: "rect" | "circle" | "line" | "arrow"; label: string }> = [
  { kind: "rect", label: "四角" },
  { kind: "circle", label: "丸" },
  { kind: "line", label: "線" },
  { kind: "arrow", label: "矢印" },
];

/** 図形ツールの入力パネル。左レールの「図形」を選ぶと右パネルに出る。 */
export function ShapeToolPanel() {
  const [color, setColor] = useState("#ff4d8d");
  const busyTool = useEditor((state) => state.busyTool);
  const { addShape } = useEditorActions();

  return (
    <div className="shrink-0 border-b border-[#2a2a2a] bg-[#212121] p-3">
      <h3 className="mb-2 text-xs font-black text-white">図形を追加</h3>
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {SHAPES.map((shape) => (
            <button
              key={shape.kind}
              type="button"
              onClick={() => void addShape(shape.kind, color)}
              disabled={busyTool !== null}
              className="rounded-md border border-[#343434] bg-[#161616] px-3 py-1.5 text-[11px] font-bold text-neutral-200 transition hover:border-pink-400 hover:text-white disabled:opacity-40"
            >
              {shape.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[10px] font-bold text-neutral-400">
          色
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-7 w-9 cursor-pointer rounded border border-[#343434] bg-transparent"
          />
        </label>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-500">
        追加した図形は選択して移動・拡大縮小、右のプロパティで色を変更できます。
      </p>
    </div>
  );
}
