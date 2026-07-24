import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";

import type { CutState } from "../lib/store/storyboardRun";

export function StoryboardCheckpointDialog({
  cuts,
  onContinue,
  onCancel,
  onReset,
  onRegenerateCut,
}: {
  cuts: CutState[];
  onContinue: () => void | Promise<unknown>;
  /** 生成を中止する (生成済みカットは保持)。Rust の停止ループへ cancel を送る。 */
  onCancel: () => void | Promise<unknown>;
  onReset: () => void | Promise<unknown>;
  onRegenerateCut: () => void | Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);

  async function runAction(action: () => void | Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-xl rounded-2xl border border-pink-400/50 bg-[#181818] p-5 shadow-2xl">
        <h3 className="text-lg font-black text-white">🎬 方向性チェック</h3>
        <p className="mt-2 text-sm text-neutral-300">
          ここまで3カット生成して一時停止しました。続けるか決めてください。
        </p>
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
          <button type="button" disabled={busy} onClick={() => void runAction(onReset)} className="rounded-lg border border-[#343434] px-3 py-2 text-xs font-bold text-neutral-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">全部やり直す</button>
          <button type="button" disabled={busy} onClick={() => void runAction(onCancel)} className="rounded-lg border border-red-400/40 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50">ここで中止</button>
          <button type="button" disabled={busy} onClick={() => void runAction(onRegenerateCut)} className="rounded-lg border border-[#343434] px-3 py-2 text-xs font-bold text-neutral-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">Cut3 だけ再生成</button>
          <button type="button" disabled={busy} onClick={() => void runAction(onContinue)} className="rounded-lg bg-pink-500 px-4 py-2 text-xs font-black text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-50">このまま続ける</button>
        </div>
      </div>
    </div>
  );
}
