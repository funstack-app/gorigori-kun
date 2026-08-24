import type { KeyboardEvent } from "react";

import type { EditToolId } from "./EditToolRail";

type EditChatBarProps = {
  value: string;
  activeTool: EditToolId | "select";
  hasRegion: boolean;
  busy: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSelectWhole: () => void;
  onSelectRegion: () => void;
};

export function EditChatBar({
  value,
  activeTool,
  hasRegion,
  busy,
  disabled,
  onChange,
  onSubmit,
  onSelectWhole,
  onSelectRegion,
}: EditChatBarProps) {
  const placeholder =
    activeTool === "crop"
      ? "画像を拡張し、変更したい内容を記述（任意）"
      : activeTool === "region" && hasRegion
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
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitFromKeyboard}
        rows={2}
        placeholder={placeholder}
        className="max-h-[6.5rem] min-h-10 w-full resize-none bg-transparent text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500"
      />
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onSelectWhole}
            className={`rounded-full px-2.5 py-0.5 text-[11px] ${
              activeTool === "ai"
                ? "bg-neutral-200 text-black"
                : "border border-[#333] text-neutral-400"
            }`}
          >
            全体
          </button>
          <button
            type="button"
            onClick={onSelectRegion}
            disabled={!hasRegion}
            className={`rounded-full px-2.5 py-0.5 text-[11px] ${
              activeTool === "region" && hasRegion
                ? "bg-neutral-200 text-black"
                : `border border-[#333] text-neutral-400 ${
                    hasRegion ? "" : "cursor-not-allowed opacity-40"
                  }`
            }`}
          >
            囲った場所
          </button>
        </div>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          aria-label="編集を実行"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-200 text-black hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {busy ? <Spinner /> : <span className="-mt-0.5 text-lg leading-none">↑</span>}
        </button>
      </div>
    </div>
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
