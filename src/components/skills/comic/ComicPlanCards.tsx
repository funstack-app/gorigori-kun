import { useState, type ReactNode } from "react";

import { MAX_PANELS_PER_PAGE } from "../../../lib/comic/prompts";
import { effectivePageSlots } from "../../../lib/comic/panelLayoutOps";
import { panelGuidePoints } from "../../../lib/comic/panelReedit";
import type { ComicPanelSlot } from "../../../lib/comic/layoutTemplates";
import type {
  ComicPanel,
  ComicReadingDirection,
  ComicStoryPage,
} from "../../../lib/comic/types";
import { SceneSectionModal } from "../../scene/SceneSectionModal";
import { BalloonEditor, SfxEditor } from "./BalloonEditor";

type ComicPlanCardsProps = {
  page: ComicStoryPage;
  storyTemplateId: string | null;
  readingDirection: ComicReadingDirection;
  updateStoryPage: (pageNo: number, patch: Partial<ComicStoryPage>) => void;
  updateStoryPanel: (
    pageNo: number,
    panelIndex: number,
    patch: Partial<ComicPanel>,
  ) => void;
  onInsertPanel: (
    pageNo: number,
    afterPosition: number,
    preset: "blank" | "transition",
  ) => void;
  onRemovePanel: (pageNo: number, panelIndex: number) => void;
};

type PanelCardProps = {
  panel: ComicPanel;
  slots: ComicPanelSlot[] | null;
  onClick: () => void;
};

/** ネームの1コマ。ページ内の位置と内容の要約だけを常時見せる。 */
function PanelCard({ panel, slots, onClick }: PanelCardProps) {
  const firstBalloon = panel.balloons.find((balloon) => balloon.text.trim())?.text.trim();
  const firstSfx = panel.sfx.find((item) => item.text.trim())?.text.trim();

  return (
    <button
      type="button"
      onClick={onClick}
      dir="ltr"
      aria-label={`ページ内のコマ ${panel.index} を編集`}
      className="group flex h-full w-full flex-col gap-2 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2 text-left transition hover:border-pink-400 hover:bg-[#141414]"
    >
      {slots ? (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="mx-auto aspect-[3/4] h-24 max-w-full rounded border border-[#2a2a2a] bg-[#171717]"
          aria-hidden="true"
        >
          {slots.map((slot, index) => {
            const selected = index === panel.index - 1;
            const points = panelGuidePoints(slot)
              .map((point) => `${point.x},${point.y}`)
              .join(" ");
            return (
              <polygon
                key={index}
                points={points}
                fill={selected ? "#ec4899" : "#292929"}
                fillOpacity={selected ? 0.9 : 0.85}
                stroke={selected ? "#f9a8d4" : "#525252"}
                strokeWidth={selected ? 1.5 : 0.75}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
      ) : (
        <div className="mx-auto flex aspect-[3/4] h-24 max-w-full items-center justify-center">
          <span className="rounded-full border border-pink-500/40 bg-pink-500/10 px-2 py-1 text-sm font-black text-pink-200">
            {String(panel.index).padStart(2, "0")}
          </span>
        </div>
      )}

      <div className="min-h-[4.5rem] w-full space-y-0.5 text-[11px] leading-snug">
        <p className="truncate font-black text-pink-200">コマ {panel.index}</p>
        <p className="truncate text-neutral-300">
          {firstBalloon ? `「${firstBalloon}」` : "無言"}
        </p>
        {firstSfx ? <p className="truncate text-neutral-400">♪{firstSfx}</p> : null}
        {panel.characters.length > 0 ? (
          <p className="truncate text-neutral-500">{panel.characters.join("、")}</p>
        ) : null}
      </div>
    </button>
  );
}

function Field({ label, className = "", children }: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <span className="mb-1 block text-[11px] font-medium text-neutral-500">{label}</span>
      {children}
    </div>
  );
}

/**
 * ページ内のネームをカードで一覧し、編集は標準モーダルへ集約する。
 * state の正本は親の storyPages のままで、入力はすべて既存更新関数へ即時反映する。
 */
export function ComicPlanCards({
  page,
  storyTemplateId,
  readingDirection,
  updateStoryPage,
  updateStoryPanel,
  onInsertPanel,
  onRemovePanel,
}: ComicPlanCardsProps) {
  const [selectedPanelIndex, setSelectedPanelIndex] = useState<number | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const selectedPanel = page.panels.find((panel) => panel.index === selectedPanelIndex) ?? null;
  const full = page.panels.length >= MAX_PANELS_PER_PAGE;
  const slots = effectivePageSlots({
    page,
    storyTemplateId,
    direction: readingDirection,
  });

  const insertPanel = (
    afterPosition: number,
    preset: "blank" | "transition",
  ) => {
    onInsertPanel(page.page, afterPosition, preset);
    setAddMenuOpen(false);
    setSelectedPanelIndex(null);
  };

  return (
    <>
      {storyTemplateId === null ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setPageSettingsOpen(true)}
            className="rounded border border-[#2a2a2a] bg-[#141414] px-2 py-1 text-[11px] text-neutral-400 transition hover:border-pink-500/40 hover:text-pink-200"
          >
            ページ設定
          </button>
        </div>
      ) : null}

      <div
        className="grid auto-rows-fr grid-cols-3 gap-2 sm:grid-cols-4"
        dir={readingDirection === "rtl" ? "rtl" : "ltr"}
      >
        {page.panels.map((panel) => (
          <PanelCard
            key={panel.index}
            panel={panel}
            slots={slots}
            onClick={() => setSelectedPanelIndex(panel.index)}
          />
        ))}

        <div className="relative h-full" dir="ltr">
          <button
            type="button"
            onClick={() => setAddMenuOpen((open) => !open)}
            disabled={full}
            title={full ? "1ページは最大8コマです" : undefined}
            className="flex h-full min-h-40 w-full items-center justify-center rounded-lg border border-dashed border-[#3a3a3a] bg-[#101010] p-3 text-xs font-bold text-neutral-400 transition hover:border-pink-500/50 hover:text-pink-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ＋ コマを追加
          </button>
          {addMenuOpen && !full ? (
            <div className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-1 rounded-md border border-[#343434] bg-[#151515] p-1.5 shadow-xl">
              <button
                type="button"
                onClick={() => insertPanel(page.panels.length, "blank")}
                className="rounded px-2 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-pink-500/10 hover:text-pink-200"
              >
                コマを挿入
              </button>
              <button
                type="button"
                onClick={() => insertPanel(page.panels.length, "transition")}
                className="rounded px-2 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-pink-500/10 hover:text-pink-200"
              >
                場面転換を挿入
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <SceneSectionModal
        open={pageSettingsOpen}
        number={`P${String(page.page).padStart(2, "0")}`}
        title={`ページ${page.page} 設定`}
        onClose={() => setPageSettingsOpen(false)}
      >
        <Field label="コマ割り方針（英語）">
          <input
            value={page.layoutHint}
            onChange={(event) =>
              updateStoryPage(page.page, { layoutHint: event.target.value })
            }
            className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
          />
        </Field>
      </SceneSectionModal>

      <SceneSectionModal
        open={selectedPanel !== null}
        number={selectedPanel ? String(selectedPanel.index).padStart(2, "0") : ""}
        title={selectedPanel ? `ページ${page.page} コマ${selectedPanel.index}` : ""}
        onClose={() => setSelectedPanelIndex(null)}
      >
        {selectedPanel ? (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="構図・カメラ">
                <input
                  value={selectedPanel.composition}
                  onChange={(event) =>
                    updateStoryPanel(page.page, selectedPanel.index, {
                      composition: event.target.value,
                    })
                  }
                  className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                />
              </Field>
              <Field label="演技・表情">
                <input
                  value={selectedPanel.acting}
                  onChange={(event) =>
                    updateStoryPanel(page.page, selectedPanel.index, {
                      acting: event.target.value,
                    })
                  }
                  className="w-full rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
                />
              </Field>
            </div>

            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label="吹き出しと擬音の編集"
            >
              <BalloonEditor
                balloons={selectedPanel.balloons}
                onChange={(balloons) =>
                  updateStoryPanel(page.page, selectedPanel.index, { balloons })
                }
              />
              <SfxEditor
                sfx={selectedPanel.sfx}
                onChange={(sfx) =>
                  updateStoryPanel(page.page, selectedPanel.index, { sfx })
                }
              />
            </div>

            <Field label="生成プロンプト">
              <textarea
                value={selectedPanel.prompt}
                onChange={(event) =>
                  updateStoryPanel(page.page, selectedPanel.index, {
                    prompt: event.target.value,
                  })
                }
                rows={2}
                className="w-full resize-y rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none"
              />
            </Field>

            <div className="flex flex-wrap items-center gap-2 border-t border-[#2a2a2a] pt-3">
              <span className="text-[11px] text-neutral-500">
                このコマの前にコマを挿入
              </span>
              <button
                type="button"
                onClick={() => insertPanel(selectedPanel.index - 1, "blank")}
                disabled={full}
                title={full ? "1ページは最大8コマです" : undefined}
                className="rounded border border-dashed border-[#343434] bg-[#141414] px-2 py-1 text-[11px] text-neutral-300 transition hover:border-pink-500/40 hover:text-pink-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                コマを挿入
              </button>
              <button
                type="button"
                onClick={() => insertPanel(selectedPanel.index - 1, "transition")}
                disabled={full}
                title={full ? "1ページは最大8コマです" : undefined}
                className="rounded border border-dashed border-[#343434] bg-[#141414] px-2 py-1 text-[11px] text-neutral-300 transition hover:border-pink-500/40 hover:text-pink-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                場面転換を挿入
              </button>
              <button
                type="button"
                onClick={() => {
                  onRemovePanel(page.page, selectedPanel.index);
                  setSelectedPanelIndex(null);
                }}
                disabled={page.panels.length <= 1}
                className="ml-auto rounded border border-[#343434] bg-[#141414] px-2 py-1 text-[11px] text-neutral-400 transition hover:border-rose-500/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
                title="このコマを削除"
              >
                このコマを削除
              </button>
            </div>
          </div>
        ) : null}
      </SceneSectionModal>
    </>
  );
}
