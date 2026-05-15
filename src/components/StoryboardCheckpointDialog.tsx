import { convertFileSrc } from "@tauri-apps/api/core";

import type { CutState } from "../lib/store/storyboardRun";

export function StoryboardCheckpointDialog({
  cuts,
  onContinue,
  onReset,
  onRegenerateCut,
}: {
  cuts: CutState[];
  onContinue: () => void;
  onReset: () => void;
  onRegenerateCut: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-xl rounded-2xl border border-pink-400/50 bg-[#181818] p-5 shadow-2xl">
        <h3 className="text-lg font-black text-white">🎬 方向性チェック</h3>
        <p className="mt-2 text-sm text-neutral-300">ここまで3カット生成しました。このまま続行しますか？</p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {cuts.slice(0, 3).map((cut) => {
            const take = cut.takes.find((item) => item.takeId === cut.selectedTakeId) ?? cut.takes[0];
            return (
              <div key={cut.cutId} className="rounded-lg border border-[#343434] bg-[#101010] p-2">
                <div className="aspect-square overflow-hidden rounded bg-[#0b0b0b]">
                  {take && <img src={convertFileSrc(take.imagePath)} alt="" className="h-full w-full object-cover" />}
                </div>
                <p className="mt-1 text-center font-mono text-[10px] text-neutral-400">{cut.cutId}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onReset} className="rounded-lg border border-[#343434] px-3 py-2 text-xs font-bold text-neutral-300 hover:text-white">全部やり直す</button>
          <button type="button" onClick={onRegenerateCut} className="rounded-lg border border-[#343434] px-3 py-2 text-xs font-bold text-neutral-300 hover:text-white">Cut3 だけ再生成</button>
          <button type="button" onClick={onContinue} className="rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-400">このまま続ける</button>
        </div>
      </div>
    </div>
  );
}
