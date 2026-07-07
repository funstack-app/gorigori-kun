import { useMemo, useState } from "react";

import { useEditMagic } from "../../lib/store/editMagic";
import { useEditor } from "./editor/editorStore";
import { useEditorActions } from "./editor/useEditor";
import { layerMetasFromCanvas } from "./editor/layerHelpers";
import { SOURCE_PREVIEW_ID } from "./editor/magicLayerToFabric";
import { EditModeSelector } from "./EditModeSelector";

/**
 * 編集タブの「主導線」パネル (タスク主導への再設計 2026-07-02)。
 *
 * 狙い: 画像を開いた直後、右パネルの一番上に「やること」を1つだけ大きく置く。
 * 生の数値プロパティやスペック説明ではなく、「レイヤーに分解する」という
 * 行為そのものを最初に見せる。使う人は「何を押せばいいか」を迷わない。
 *
 * 状態遷移:
 * 1. 画像あり & レイヤーなし        → 大ボタン「レイヤーに分解する」+ 1行説明 + 小さな「設定」
 * 2. 分解実行中 (busy or progress)  → 同じ場所に進捗表示 (既存の magic progress イベント)
 * 3. 分解済み (レイヤーあり)         → このパネルは自身を畳む (何も描かない) → レイヤー一覧が主役
 *
 * モード選択 (高速/人物パーツ・物体分解ON) は既定のまま隠し、「設定」リンクを
 * 押したときだけ展開する。既定は standard + 物体分解ON (editorStore の初期値)。
 */
export function EditPrimaryAction() {
  const canvas = useEditor((state) => state.canvas);
  const revision = useEditor((state) => state.revision);
  const sourceImagePath = useEditor((state) => state.sourceImagePath);
  const busyTool = useEditor((state) => state.busyTool);
  const magicProgress = useEditMagic((state) => state.progress);
  const magicRunning = useEditMagic((state) => state.running);
  const { runWordsAuto } = useEditorActions();
  const editMode = useEditor((state) => state.editMode);
  const setEditMode = useEditor((state) => state.setEditMode);
  const [showSettings, setShowSettings] = useState(false);

  // 「切り分けられる本体レイヤー」が既にあるか。プレビュー用のマスクは数に入れない。
  const decomposableLayerCount = useMemo(
    () =>
      layerMetasFromCanvas(canvas).filter(
        (layer) => layer.kind !== "mask" && layer.id !== SOURCE_PREVIEW_ID,
      ).length,
    [canvas, revision],
  );

  const running =
    magicRunning || busyTool === "magic" || busyTool === "redo-decompose" || busyTool === "words";

  // 実行中は場所を保ったまま進捗を出す。
  if (running) {
    return (
      <div className="shrink-0 border-b border-[#2a2a2a] bg-[#101010] p-4">
        <div className="flex items-center gap-3">
          <Spinner />
          <div className="min-w-0">
            <p className="text-xs font-black text-neutral-100">レイヤーに分解しています…</p>
            <p className="mt-0.5 truncate text-[11px] font-bold text-neutral-400">
              {magicProgress ? PROGRESS_LABELS[magicProgress.kind] ?? "処理中…" : "処理中…"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 分解済み: 自身を畳む。レイヤー一覧に主役を譲る。
  if (decomposableLayerCount > 0) return null;

  // 画像がまだ無ければ何も出さない (キャンバス側のドロップ案内が主導線)。
  if (!sourceImagePath) return null;

  return (
    <div className="shrink-0 border-b border-[#2a2a2a] bg-[#101010] p-4">
      <button
        type="button"
        onClick={() => void runWordsAuto()}
        className="w-full rounded-xl bg-pink-500 px-4 py-3 text-sm font-black text-white shadow-lg shadow-pink-500/20 transition hover:bg-pink-600"
      >
        レイヤーに分解する
      </button>
      <p className="mt-2 text-center text-[11px] font-bold leading-4 text-neutral-400">
        人物・小物・背景・文字に自動で切り分けます
      </p>
      <button
        type="button"
        onClick={() => setShowSettings((v) => !v)}
        className="mx-auto mt-2 block text-[11px] font-bold text-neutral-500 underline decoration-dotted hover:text-pink-200"
      >
        {showSettings ? "設定を閉じる" : "設定（分解のしかた・モデル追加）"}
      </button>
      {showSettings ? (
        <div className="mt-3 border-t border-[#2a2a2a] pt-3">
          <EditModeSelector activeMode={editMode} onSelectMode={setEditMode} />
        </div>
      ) : null}
    </div>
  );
}

const PROGRESS_LABELS: Record<string, string> = {
  started: "準備しています…",
  detectingText: "文字を探しています…",
  removingText: "文字を消しています…",
  segmenting: "人物を切り抜いています…",
  segmentingObjects: "物体を探しています…",
  inpaintingBackground: "背景を補完しています…",
  buildingTextLayers: "レイヤーを組み立てています…",
  completed: "完了しました",
  failed: "失敗しました",
};

function Spinner() {
  return (
    <svg
      className="h-5 w-5 shrink-0 animate-spin text-pink-400"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default EditPrimaryAction;
