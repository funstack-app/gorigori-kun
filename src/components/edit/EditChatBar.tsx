import type { KeyboardEvent, ReactNode } from "react";

import type { EditToolId } from "./EditToolRail";

export const EDIT_CANDIDATE_COUNT_MIN = 1;
export const EDIT_CANDIDATE_COUNT_MAX = 4;
export const DEFAULT_EDIT_CANDIDATE_COUNT = 2;
export const ERASE_INSTRUCTION_PREFIX = "この範囲のものを消して自然に埋めて。";

export type RegionEditMode = "replace" | "erase";
export type RegionSelectionMode = "rectangle" | "brush";

export function normalizeEditCandidateCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EDIT_CANDIDATE_COUNT;
  return Math.min(
    EDIT_CANDIDATE_COUNT_MAX,
    Math.max(EDIT_CANDIDATE_COUNT_MIN, Math.round(value)),
  );
}

export function buildEraseInstruction(instruction: string): string {
  const detail = instruction.trim();
  return detail ? `${ERASE_INSTRUCTION_PREFIX}\n${detail}` : ERASE_INSTRUCTION_PREFIX;
}

type EditChatBarProps = {
  value: string;
  activeTool: EditToolId;
  candidateCount: number;
  regionMode: RegionEditMode;
  regionSelectionMode: RegionSelectionMode;
  brushSize: number;
  brushEraser: boolean;
  brushHasStrokes: boolean;
  busy: boolean;
  disabled: boolean;
  interactionDisabled?: boolean;
  /** リサイズだけは文章欄を持たず、比率とpxの操作列へ丸ごと変形する。 */
  resizeControls?: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCandidateCountChange: (count: number) => void;
  onRegionModeChange: (mode: RegionEditMode) => void;
  onRegionSelectionModeChange: (mode: RegionSelectionMode) => void;
  onBrushSizeChange: (size: number) => void;
  onBrushEraserChange: (enabled: boolean) => void;
  onBrushClear: () => void;
};

const PASSIVE_TOOL_COPY: Partial<Record<EditToolId, { label: string; hint: string }>> = {
  relight: { label: "ライティング", hint: "左上の光点・方向・強さを決めて実行します" },
  camera: { label: "カメラ", hint: "左上のオービットを動かして視点を決めます" },
  adjust: { label: "調整", hint: "左上のプリセットまたはスライダーで調整します" },
};

export function EditChatBar({
  value,
  activeTool,
  candidateCount,
  regionMode,
  regionSelectionMode,
  brushSize,
  brushEraser,
  brushHasStrokes,
  busy,
  disabled,
  interactionDisabled = false,
  resizeControls,
  onChange,
  onSubmit,
  onCandidateCountChange,
  onRegionModeChange,
  onRegionSelectionModeChange,
  onBrushSizeChange,
  onBrushEraserChange,
  onBrushClear,
}: EditChatBarProps) {
  const submitFromKeyboard = (
    event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
  ) => {
    const submitKey = event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey);
    if (!submitKey) return;
    event.preventDefault();
    if (!disabled) onSubmit();
  };

  if (activeTool === "crop") {
    return (
      <div
        data-edit-chat-bar
        className="w-[min(720px,calc(100vw-2rem))] rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] px-4 py-3 shadow-2xl"
      >
        {resizeControls ?? <span className="text-[11px] text-neutral-500">リサイズ設定を選んでください</span>}
      </div>
    );
  }

  const passive = PASSIVE_TOOL_COPY[activeTool];
  if (passive) {
    return (
      <div
        data-edit-chat-bar
        className="flex w-[min(560px,calc(100vw-2rem))] items-center gap-3 rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] px-4 py-3 shadow-2xl"
      >
        <span className="shrink-0 text-xs font-black text-white">{passive.label}</span>
        <span className="min-w-0 truncate text-[11px] font-bold text-neutral-500">{passive.hint}</span>
      </div>
    );
  }

  if (activeTool === "restyle") {
    return (
      <div
        data-edit-chat-bar
        className="flex w-[min(680px,calc(100vw-2rem))] items-center gap-2 rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] px-4 py-3 shadow-2xl"
      >
        <span className="shrink-0 text-xs font-black text-white">スタイル</span>
        <input
          type="text"
          value={value}
          disabled={interactionDisabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={submitFromKeyboard}
          placeholder="例：やわらかな水彩画"
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-500 disabled:opacity-40"
        />
        <SubmitButton busy={busy} disabled={disabled} label="リスタイルを実行" onClick={onSubmit} />
      </div>
    );
  }

  const placeholder = activeTool === "region"
    ? regionSelectionMode === "brush"
      ? "直したいところを塗って、変更したい内容を説明してください"
      : "選択範囲を囲んで、変更したい内容を説明してください"
    : "どこを変更したいですか？";

  return (
    <div
      data-edit-chat-bar
      className={`${
        activeTool === "region" && regionSelectionMode === "brush"
          ? "w-[min(760px,calc(100vw-2rem))]"
          : "w-[min(560px,calc(100vw-2rem))]"
      } rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] px-4 pb-2 pt-3 shadow-2xl`}
    >
      <textarea
        value={value}
        disabled={interactionDisabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitFromKeyboard}
        rows={2}
        placeholder={placeholder}
        className="max-h-[6.5rem] min-h-10 w-full resize-none bg-transparent text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500 disabled:opacity-40"
      />
      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="flex min-h-7 min-w-0 flex-col gap-1.5">
          {activeTool === "region" ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <ModeChip
                  active={regionSelectionMode === "rectangle"}
                  disabled={interactionDisabled || busy}
                  onClick={() => onRegionSelectionModeChange("rectangle")}
                >
                  四角
                </ModeChip>
                <span className="text-[10px] font-bold text-neutral-600" aria-hidden>⇄</span>
                <ModeChip
                  active={regionSelectionMode === "brush"}
                  disabled={interactionDisabled || busy}
                  onClick={() => onRegionSelectionModeChange("brush")}
                >
                  ブラシ
                </ModeChip>
                <span className="mx-0.5 h-4 border-l border-[#333]" aria-hidden />
                <ModeChip
                  active={regionMode === "replace"}
                  disabled={interactionDisabled}
                  onClick={() => onRegionModeChange("replace")}
                >
                  差し替え
                </ModeChip>
                <ModeChip
                  active={regionMode === "erase"}
                  disabled={interactionDisabled}
                  onClick={() => onRegionModeChange("erase")}
                >
                  消去
                </ModeChip>
              </div>
              {regionSelectionMode === "brush" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-[11px] font-bold text-neutral-400">
                    <span className="whitespace-nowrap">サイズ</span>
                    <input
                      type="range"
                      min={10}
                      max={120}
                      step={1}
                      value={brushSize}
                      disabled={interactionDisabled || busy}
                      onChange={(event) => onBrushSizeChange(Number(event.target.value))}
                      aria-label="ブラシサイズ"
                      className="w-28 accent-pink-500 disabled:opacity-40"
                    />
                    <span className="w-10 font-mono text-neutral-500">{brushSize}px</span>
                  </label>
                  <ModeChip
                    active={brushEraser}
                    disabled={interactionDisabled || busy}
                    onClick={() => onBrushEraserChange(!brushEraser)}
                  >
                    消しゴム
                  </ModeChip>
                  <button
                    type="button"
                    onClick={onBrushClear}
                    disabled={interactionDisabled || busy || !brushHasStrokes}
                    className="rounded-full border border-[#333] px-2.5 py-0.5 text-[11px] text-neutral-400 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    クリア
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {activeTool === "ai" ||
          (activeTool === "region" && regionSelectionMode === "brush") ? (
            <label className="flex items-center gap-1 text-[11px] text-neutral-400">
              <span>候補</span>
              <select
                aria-label="候補枚数"
                value={candidateCount}
                disabled={interactionDisabled || busy}
                onChange={(event) =>
                  onCandidateCountChange(normalizeEditCandidateCount(Number(event.target.value)))
                }
                className="rounded-md border border-[#3a3a3a] bg-[#121212] px-1.5 py-1 text-neutral-200 outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>{count}枚</option>
                ))}
              </select>
            </label>
          ) : null}
          <SubmitButton busy={busy} disabled={disabled} label="編集を実行" onClick={onSubmit} round />
        </div>
      </div>
    </div>
  );
}

function SubmitButton({
  busy,
  disabled,
  label,
  onClick,
  round = false,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  round?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex h-8 shrink-0 items-center justify-center bg-pink-500 text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500 ${
        round ? "w-8 rounded-full" : "gap-2 rounded-lg px-3 text-[11px] font-black"
      }`}
    >
      {busy ? <Spinner /> : round ? <span className="-mt-0.5 text-lg leading-none">↑</span> : "実行"}
    </button>
  );
}

function ModeChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-2.5 py-0.5 text-[11px] ${
        active ? "bg-pink-500 text-white" : "border border-[#333] text-neutral-400"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export default EditChatBar;
