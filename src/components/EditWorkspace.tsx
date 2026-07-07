import { useEffect } from "react";

import { EditorCanvas } from "./edit/EditorCanvas";
import { EditorLayerList } from "./edit/EditorLayerList";
import { EditorPropertyPanel } from "./edit/EditorPropertyPanel";
import { EditorToolbar } from "./edit/EditorToolbar";
import { EditModeSelector } from "./edit/EditModeSelector";
import { EditPrimaryAction } from "./edit/EditPrimaryAction";
import { WordsToolPanel } from "./edit/WordsToolPanel";
import { ShapeToolPanel } from "./edit/ShapeToolPanel";
import { LayerSplitterPanel } from "./edit/LayerSplitterPanel";
import { useEditor } from "./edit/editor/editorStore";
import { useEditorActions } from "./edit/editor/useEditor";

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 編集ワークスペース (2026-07-02 タスク主導へ再設計)。
 *
 * 設計方針: 道具を並べるのではなく「今やること」を1つに絞って見せる。
 * 生の数値プロパティや分解モードのスペック説明を最初に見せない。
 *
 * レイアウト:
 * - 上部: 薄いバー1本 (画像名 / 分解モードの select / 画像を選ぶ)。
 * - 左端: 縦のツールレール (48px, アイコン + tooltip)。
 * - 中央: キャンバスが残り全域を占める (主役)。
 * - 右: 固定 300px パネル。上から
 *     ① 主導線パネル (EditPrimaryAction): 画像を開いた直後は大ボタン
 *        「レイヤーに分解する」+ 1行説明。実行中は進捗。分解済みなら自身を畳む。
 *     ② レイヤー一覧 (主役・可変・高さの大半)。
 *     ③ プロパティ (レイヤーを選んでいるときだけ表示。生の座標数値は「詳細」に畳む)。
 *     ④ 追加ツール (区分を廃止して常時表示に統一): その他ツール / 分解モード / レイヤースプリッター。
 *
 * Rust IPC と PSD 用 LayerComposer は変更せず、UI 構成のみを整える。
 */
export function EditWorkspace() {
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const activeTool = useEditor((state) => state.activeTool);
  const selectedLayerId = useEditor((state) => state.selectedLayerId);
  const busyTool = useEditor((state) => state.busyTool);
  const editMode = useEditor((state) => state.editMode);
  const setEditMode = useEditor((state) => state.setEditMode);
  const { chooseImage, performUndo, performRedo, exportPng } = useEditorActions();

  // Cmd/Ctrl+Z = 元に戻す / Cmd/Ctrl+Shift+Z = やり直す。
  // 編集タブ表示中だけ有効 (このコンポーネントがマウントされている間だけ listener を張る)。
  // input / textarea / contentEditable にフォーカスがあるときは発火しない
  // (テキスト入力・レイヤー名編集の標準 Undo を奪わないため)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        void performRedo();
      } else {
        void performUndo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [performUndo, performRedo]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#1e1e1e]">
      {/* 上部バー: 薄い1本 (高さ ~40px)。説明文なし、tooltip へ寄せる。 */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[#2a2a2a] bg-[#252525] px-3">
        <span
          className="rounded bg-pink-500/80 px-1 py-0.5 text-[9px] font-black text-white"
          title="編集タブは開発中の β 版機能です。一部が不安定・未実装の場合があります。"
        >
          β
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs font-bold text-neutral-300"
          title={sourceImagePath ?? undefined}
        >
          {sourceImagePath ? basename(sourceImagePath) : "画像未選択"}
        </span>
        <button
          type="button"
          onClick={() => void exportPng()}
          disabled={busyTool !== null || !sourceImagePath}
          className="rounded-md border border-[#3a3a3a] bg-[#1a1a1a] px-3 py-1.5 text-[11px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          書き出し
        </button>
        <button
          type="button"
          onClick={() => void chooseImage()}
          disabled={busyTool !== null}
          className="rounded-md bg-pink-500 px-3 py-1.5 text-[11px] font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {busyTool ? "処理中…" : "画像を選ぶ"}
        </button>
      </header>

      {/* 本体: 左レール / キャンバス / 右パネル */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <EditorToolbar />
        <EditorCanvas />
        <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-x-hidden overflow-y-hidden border-l border-[#2a2a2a] bg-[#252525] [&_*]:max-w-full [&_*]:min-w-0">
          {/* ① 主導線: 分解前は大ボタン、実行中は進捗。分解済みは自身を畳む。 */}
          <EditPrimaryAction />
          {/* ①' ことばで分離: 左レールで選んだときだけ入力パネルを出す。 */}
          {activeTool === "words" ? <WordsToolPanel /> : null}
          {activeTool === "shape" ? <ShapeToolPanel /> : null}
          {/* ② レイヤー一覧: 主役。残り高さの大半を占める。 */}
          <EditorLayerList />
          {/* ③ プロパティ: レイヤーを選んでいるときだけ表示 (未選択時は場所を取らない)。 */}
          {selectedLayerId ? (
            <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-[#2a2a2a]">
              <EditorPropertyPanel />
            </div>
          ) : null}
          {/* ④ 追加ツール: 区分（上級者向け）を廃止し、統一パネルとして常時表示する。 */}
          <div className="shrink-0 space-y-3 overflow-y-auto border-t border-[#2a2a2a] p-3">
            <div>
              <p className="mb-2 text-[10px] font-bold text-neutral-500">その他のツール</p>
              <AdvancedToolButtons />
            </div>
            <div className="border-t border-[#2a2a2a] pt-3">
              <p className="mb-2 text-[10px] font-bold text-neutral-500">分解のしかた・モデル追加</p>
              <EditModeSelector activeMode={editMode} onSelectMode={setEditMode} />
            </div>
            <div className="border-t border-[#2a2a2a] pt-3">
              <p className="mb-2 text-[10px] font-bold text-neutral-500">レイヤースプリッター (実験機能)</p>
              <LayerSplitterPanel />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** 常設レールから外した旧ツール群 (使う人だけ上級者向けから)。 */
function AdvancedToolButtons() {
  const busyTool = useEditor((state) => state.busyTool);
  const actions = useEditorActions();
  const tools: Array<{ id: Parameters<typeof actions.run>[0]; label: string }> = [
    { id: "magic", label: "自動レイヤー分解 (旧方式)" },
    { id: "redo-decompose", label: "再分解" },
    { id: "bgremove", label: "人物切り抜き" },
    { id: "grab", label: "マジックグラブ" },
    { id: "text-detect", label: "テキスト検出" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => void actions.run(tool.id)}
          disabled={busyTool !== null}
          className="rounded-md border border-[#343434] bg-[#161616] px-2.5 py-1.5 text-[10px] font-bold text-neutral-300 transition hover:border-pink-400 hover:text-white disabled:opacity-40"
        >
          {tool.label}
        </button>
      ))}
    </div>
  );
}

export default EditWorkspace;
