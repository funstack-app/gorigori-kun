import { useEditLayers } from "../lib/store/editLayers";
import { useEditTab } from "../lib/store/editTab";
import type { CutState } from "../lib/store/storyboardRun";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";

function selectedImagePath(cut: CutState): string | null {
  const selected = cut.takes.find((take) => take.takeId === cut.selectedTakeId) ?? cut.takes[0];
  return selected?.imagePath ?? null;
}

export function openImageInEditTab(imagePath: string) {
  useWorkspace.getState().setActiveTab("edit");
  useEditTab.getState().setSelectedImagePath(imagePath);
  const editLayers = useEditLayers.getState();
  editLayers.setSource(imagePath);
  editLayers.setLayers([]);
  useToasts.getState().push({
    kind: "success",
    text: "完了画像を編集タブで開きました。",
    ttlMs: 2600,
  });
}

export function SkillRunActions({ cuts }: { cuts: CutState[] }) {
  const editableCuts = cuts
    .map((cut) => ({ cut, imagePath: selectedImagePath(cut) }))
    .filter((item): item is { cut: CutState; imagePath: string } => Boolean(item.imagePath));

  if (editableCuts.length === 0) return null;

  return (
    <div className="rounded-xl border border-pink-400/30 bg-pink-500/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-black text-pink-100">編集タブへ送る</p>
          <p className="mt-0.5 text-[10px] text-pink-100/70">採用画像を Magic Layer 編集に渡します。</p>
        </div>
        <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px] font-black text-pink-100">
          {editableCuts.length} 件
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {editableCuts.map(({ cut, imagePath }) => (
          <button
            key={cut.cutId}
            type="button"
            onClick={() => openImageInEditTab(imagePath)}
            className="rounded-lg border border-pink-300/40 bg-[#101010] px-3 py-1.5 text-[11px] font-black text-pink-100 hover:border-pink-200 hover:text-white"
          >
            {cut.cutId} を編集タブで開く ✨
          </button>
        ))}
      </div>
    </div>
  );
}
