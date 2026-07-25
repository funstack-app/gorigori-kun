import { useState } from "react";

import { SafeImage } from "./SafeImage";

import type { CutState } from "../lib/store/storyboardRun";

/* ---------- フラットラインアイコン (絵文字を使わない。STΛCK 指示 2026-07-25) ---------- */

/** 見出し脇のカチンコ(絵コンテの方向性チェック) */
function ClapperIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z" />
      <path d="M3.5 10L5 5l16 2-.6 3" />
      <path d="M8.5 5.6L7.4 10M13.5 6.2L12.4 10M18 6.9L17 10" />
    </svg>
  );
}

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
        <h3 className="flex items-center gap-2 text-lg font-black text-white">
          <ClapperIcon />
          方向性チェック
        </h3>
        <p className="mt-1.5 text-[12px] text-neutral-400">
          ここまで3カット生成して一時停止しました。続けるか決めてください。
        </p>

        {/* 生成済みカットのプレビュー: 小見出しで「何を見せているか」を明示する */}
        <p className="mt-4 text-[12px] font-bold text-neutral-200">生成できた3カット</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {cuts.slice(0, 3).map((cut) => {
            const take = cut.takes.find((item) => item.takeId === cut.selectedTakeId) ?? cut.takes[0];
            return (
              <div key={cut.cutId} className="rounded-lg border border-[#343434] bg-[#101010] p-2">
                <div className="aspect-square overflow-hidden rounded bg-[#0b0b0b]">
                  {take && <SafeImage path={take.imagePath} alt="" className="h-full w-full object-cover" />}
                </div>
                <p className="mt-1 text-center font-mono text-[10px] font-bold tabular-nums text-neutral-400">{cut.cutId}</p>
              </div>
            );
          })}
        </div>
        {/* 選択肢: 区切り線 + 小見出しで「ここが決めるところ」と分かるようにする */}
        <div className="mt-5 border-t border-[#2a2a2a] pt-4">
          <p className="text-[12px] font-bold text-neutral-200">この先どうしますか</p>
          <p className="mt-0.5 text-[10px] text-neutral-500">
            おすすめは「このまま続ける」。方向性が違うときだけ左の3つを使ってください
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => void runAction(onReset)} className="rounded-lg border border-[#343434] px-3 py-2 text-[11px] font-bold text-neutral-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">全部やり直す</button>
            <button type="button" disabled={busy} onClick={() => void runAction(onCancel)} className="rounded-lg border border-red-400/40 px-3 py-2 text-[11px] font-bold text-red-200 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50">ここで中止</button>
            <button type="button" disabled={busy} onClick={() => void runAction(onRegenerateCut)} className="rounded-lg border border-[#343434] px-3 py-2 text-[11px] font-bold text-neutral-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">Cut3 だけ再生成</button>
            <button type="button" disabled={busy} onClick={() => void runAction(onContinue)} className="rounded-lg bg-pink-500 px-4 py-2 text-[13px] font-black text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:opacity-50">このまま続ける</button>
          </div>
        </div>
      </div>
    </div>
  );
}
