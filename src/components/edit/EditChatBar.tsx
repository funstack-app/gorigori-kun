import type { KeyboardEvent } from "react";

import type { EditToolId } from "./EditToolRail";

export const EDIT_CANDIDATE_COUNT_MIN = 1;
export const EDIT_CANDIDATE_COUNT_MAX = 4;
export const DEFAULT_EDIT_CANDIDATE_COUNT = 2;
export const ERASE_INSTRUCTION_PREFIX = "この範囲のものを消して自然に埋めて。";

export type RegionEditMode = "replace" | "erase";

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
  busy: boolean;
  disabled: boolean;
  interactionDisabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCandidateCountChange: (count: number) => void;
  onRegionModeChange: (mode: RegionEditMode) => void;
};

export function EditChatBar({
  value,
  activeTool,
  candidateCount,
  regionMode,
  busy,
  disabled,
  interactionDisabled = false,
  onChange,
  onSubmit,
  onCandidateCountChange,
  onRegionModeChange,
}: EditChatBarProps) {
  const acceptsInstruction =
    activeTool === "ai" || activeTool === "region" || activeTool === "restyle";
  const placeholder =
    activeTool === "crop"
      ? "左上のパネルで切り抜く範囲を指定してください"
      : activeTool === "adjust"
        ? "左上のパネルで画像を調整してください"
        : activeTool === "restyle"
          ? "どんな雰囲気に変えたいですか？"
        : activeTool === "region"
        ? "選択範囲を囲んで、変更したい内容を説明してください"
        : "どこを変更したいですか？";

  const submitFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const submitKey = event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey);
    if (!submitKey) return;
    event.preventDefault();
    if (!disabled) onSubmit();
  };

  return (
    <div
      data-edit-chat-bar
      className="w-[min(560px,calc(100vw-2rem))] rounded-2xl border border-[#2a2a2a] bg-[#1b1b1b] px-4 pb-2 pt-3 shadow-2xl"
    >
      <textarea
        value={value}
        disabled={interactionDisabled || !acceptsInstruction}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitFromKeyboard}
        rows={2}
        placeholder={placeholder}
        className="max-h-[6.5rem] min-h-10 w-full resize-none bg-transparent text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500"
      />
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex min-h-7 items-center gap-1.5">
          {activeTool === "region" ? (
            <>
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
            </>
          ) : activeTool === "crop" || activeTool === "adjust" ? (
            <span className="text-[11px] text-neutral-500">パネル操作のみ</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {activeTool === "ai" ? (
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
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled}
            aria-label="編集を実行"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-pink-500 text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy ? <Spinner /> : <span className="-mt-0.5 text-lg leading-none">↑</span>}
          </button>
        </div>
      </div>
    </div>
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
