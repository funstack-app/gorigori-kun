import { useState } from "react";

import { useMultiAngleRun } from "../../../lib/store/multiAngleRun";
import {
  ANGLE_CUTS,
  ANGLE_PRESETS,
  MAX_CUTS,
  type AngleCut,
} from "../../../lib/multiangle/angles";
import { ModalPortal } from "../../ModalPortal";

/**
 * 構図ピッカー（中央ポップアップ）
 *
 * ユーザー合意 (2026-06-06):
 *   - 30個の構図カードを「マネキン見本画像」付きで一覧表示
 *   - 好きなものを複数選択（最大30）。上限に達したら追加不可
 *   - プリセット（最小8/標準16/網羅30）で一括選択も可能
 *   - 確定で閉じ、選んだカットだけが並列生成対象になる
 *
 * 見本画像は public/angle-samples/{id}.png（GPT Image で事前生成、使い回し）。
 * 未生成の場合はプレースホルダを表示する。
 */

const GROUP_LABELS: Record<AngleCut["group"], string> = {
  full: "全身",
  medium: "ミディアム",
  closeup: "顔アップ",
  special: "特殊",
};

const GROUP_ORDER: AngleCut["group"][] = ["full", "medium", "closeup", "special"];

function sampleSrc(id: string): string {
  // public/ 配下は Vite が配信。convertFileSrc は不要（http 配信される）。
  return `/angle-samples/${id}.png`;
}

export function AnglePickerModal({ onClose }: { onClose: () => void }) {
  const selectedCutIds = useMultiAngleRun((s) => s.selectedCutIds);
  const toggleCut = useMultiAngleRun((s) => s.toggleCut);
  const applyPreset = useMultiAngleRun((s) => s.applyPreset);
  const clearSelection = useMultiAngleRun((s) => s.clearSelection);

  const [brokenSamples, setBrokenSamples] = useState<Set<string>>(new Set());

  const count = selectedCutIds.length;
  const atLimit = count >= MAX_CUTS;

  return (
    <ModalPortal>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダ */}
        <div className="flex items-center justify-between border-b border-[#242424] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-white">構図を選ぶ</h2>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              欲しいカットを複数選択（最大 {MAX_CUTS} 枚）。選んだものだけ一気に生成します。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-[12px] font-black ${
                atLimit
                  ? "bg-amber-500/20 text-amber-200"
                  : "bg-pink-500/20 text-pink-100"
              }`}
            >
              選択中 {count} / {MAX_CUTS}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              閉じる
            </button>
          </div>
        </div>

        {/* プリセット行 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[#242424] bg-[#121212] px-5 py-3">
          <span className="text-[11px] font-bold text-neutral-500">おまかせ:</span>
          {ANGLE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.cutIds)}
              className="rounded-full border border-[#343434] bg-[#101010] px-3 py-1 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto rounded-full border border-[#343434] px-3 py-1 text-[11px] font-bold text-neutral-400 hover:border-red-400 hover:text-red-200"
          >
            選択をクリア
          </button>
        </div>

        {/* カードグリッド */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {GROUP_ORDER.map((group) => {
            const cuts = ANGLE_CUTS.filter((c) => c.group === group);
            if (cuts.length === 0) return null;
            return (
              <div key={group} className="mb-5">
                <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-neutral-500">
                  {GROUP_LABELS[group]}
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                  {cuts.map((cut) => {
                    const selected = selectedCutIds.includes(cut.id);
                    const disabled = !selected && atLimit;
                    const broken = brokenSamples.has(cut.id);
                    return (
                      <button
                        key={cut.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleCut(cut.id)}
                        title={cut.label}
                        className={`group relative flex flex-col overflow-hidden rounded-xl border text-left transition ${
                          selected
                            ? "border-pink-400 ring-2 ring-pink-400/50"
                            : disabled
                              ? "cursor-not-allowed border-[#242424] opacity-40"
                              : "border-[#2a2a2a] hover:border-pink-400/60"
                        }`}
                      >
                        <div className="relative aspect-square w-full bg-[#0d0d0d]">
                          {!broken ? (
                            <img
                              src={sampleSrc(cut.id)}
                              alt={cut.label}
                              className="h-full w-full object-cover"
                              onError={() =>
                                setBrokenSamples((prev) =>
                                  new Set(prev).add(cut.id),
                                )
                              }
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] text-neutral-600">
                              見本準備中
                            </div>
                          )}
                          {selected && (
                            <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-pink-500 text-[11px] font-black text-white">
                              ✓
                            </div>
                          )}
                        </div>
                        <div className="px-2 py-1.5 text-[11px] font-bold text-neutral-200">
                          {cut.label}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* フッタ確定 */}
        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={count === 0}
            className={`rounded-xl px-5 py-2.5 text-[13px] font-black transition ${
              count === 0
                ? "cursor-not-allowed bg-[#242424] text-neutral-600"
                : "bg-pink-500 text-white hover:bg-pink-400"
            }`}
          >
            {count > 0 ? `${count} カットを確定` : "1つ以上選んでください"}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
