import { convertFileSrc } from "@tauri-apps/api/core";

import { useStoryboardRun, type CutState } from "../lib/store/storyboardRun";

const STATUS_CLASS: Record<CutState["status"], string> = {
  pending: "border-[#343434] bg-[#101010] text-neutral-500",
  running: "border-blue-400/50 bg-blue-500/10 text-blue-100",
  review: "border-yellow-400/50 bg-yellow-500/10 text-yellow-100",
  confirmed: "border-emerald-400/50 bg-emerald-500/10 text-emerald-100",
  failed: "border-red-400/50 bg-red-500/10 text-red-100",
};

/**
 * 状態ラベル (STΛCK 指示 2026-05-15):
 *  「確認待ち」が何を待ってるかが伝わるようにする。
 *  - review = 3案が出揃って AI が一番をベスト判定したあと、ユーザーが確定するのを待ってる状態
 */
const STATUS_LABEL: Record<CutState["status"], string> = {
  pending: "⏳ 待機中",
  running: "🔄 生成中…",
  review: "👀 採用待ち (どれを使うか選んでください)",
  confirmed: "✅ 採用済み",
  failed: "❌ 失敗",
};

export function StoryboardCutCard({ cut }: { cut: CutState }) {
  const adoptTake = useStoryboardRun((s) => s.adoptTake);
  const revertCut = useStoryboardRun((s) => s.revertCut);
  const selectTake = useStoryboardRun((s) => s.selectTake);
  const regenerateCut = useStoryboardRun((s) => s.regenerateCut);
  const skipCut = useStoryboardRun((s) => s.skipCut);

  const selectedIndex = cut.takes.findIndex((t) => t.takeId === cut.selectedTakeId);
  const selected =
    cut.takes.find((take) => take.takeId === cut.selectedTakeId) ?? cut.takes[0];

  const showPrev = () => {
    if (cut.takes.length < 2) return;
    const idx = selectedIndex < 0 ? 0 : selectedIndex;
    const prev = cut.takes[(idx - 1 + cut.takes.length) % cut.takes.length];
    selectTake(cut.cutId, prev.takeId);
  };
  const showNext = () => {
    if (cut.takes.length < 2) return;
    const idx = selectedIndex < 0 ? 0 : selectedIndex;
    const nxt = cut.takes[(idx + 1) % cut.takes.length];
    selectTake(cut.cutId, nxt.takeId);
  };

  return (
    <article className={`rounded-xl border p-3 ${STATUS_CLASS[cut.status]}`}>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={!selected}
          className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-black/30 bg-[#0b0b0b] disabled:cursor-default"
        >
          {selected ? (
            <img
              src={convertFileSrc(selected.imagePath)}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[10px] text-neutral-600">
              No image
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-mono text-xs font-black text-white">{cut.cutId}</h4>
            <span className="text-[11px] font-black">{STATUS_LABEL[cut.status]}</span>
          </div>
          <p className="mt-1 text-[11px] text-neutral-300">
            シーン: {cut.description ?? cut.sceneGroupId ?? "未設定"}
          </p>
          {selected && (
            <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-neutral-300">
              <Score label="Identity" value={selected.scores.identity} />
              <Score label="Outfit" value={selected.scores.outfit} />
              <Score label="Prop" value={selected.scores.prop} />
              <Score label="Face" value={selected.scores.face} />
              <Score label="Hand" value={selected.scores.hand} />
              <Score label="Bg" value={selected.scores.background} />
            </div>
          )}
          {cut.error && (
            <p className="mt-2 text-[11px] font-bold text-red-200">{cut.error}</p>
          )}

          {/* take 切替 (案A/B/Cを比較) */}
          {cut.takes.length > 1 && cut.status !== "running" && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-neutral-300">
              <button
                type="button"
                onClick={showPrev}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-0.5 font-bold hover:border-pink-400"
                aria-label="前の案"
              >
                ◀
              </button>
              <span className="font-mono">
                案 {selectedIndex < 0 ? 1 : selectedIndex + 1} / {cut.takes.length}
              </span>
              <button
                type="button"
                onClick={showNext}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-0.5 font-bold hover:border-pink-400"
                aria-label="次の案"
              >
                ▶
              </button>
            </div>
          )}

          {/* review 状態: 操作ボタン群 */}
          {cut.status === "review" && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => adoptTake(cut.cutId)}
                className="rounded bg-emerald-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-emerald-400"
              >
                採用
              </button>
              <button
                type="button"
                onClick={() => regenerateCut(cut.cutId)}
                className="rounded border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-100 hover:border-amber-400"
              >
                再生成
              </button>
              <button
                type="button"
                onClick={() => skipCut(cut.cutId)}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-200 hover:border-pink-400"
              >
                スキップ
              </button>
            </div>
          )}

          {/* confirmed 状態: 戻すボタン (取り消し対応) */}
          {cut.status === "confirmed" && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => revertCut(cut.cutId)}
                className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[10px] font-bold text-neutral-300 hover:border-rose-400 hover:text-rose-200"
                title="このカットの採用を取り消して再選択する"
              >
                採用を取り消す
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded bg-black/20 px-1.5 py-1 tabular-nums">
      {label}:{Math.round(value)}
    </span>
  );
}
