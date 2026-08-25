import {
  CROP_ASPECT_RATIOS,
  MAGNIFIC_ASPECT_RATIOS,
  type CropAspectRatio,
  type MagnificAspectRatio,
} from "./editToolLogic";

export type ResizeMode = "expand" | "crop";

type ResizePanelProps = {
  mode: ResizeMode;
  cropAspect: CropAspectRatio;
  expandAspect: MagnificAspectRatio;
  expandPrompt: string;
  busy?: boolean;
  onModeChange: (mode: ResizeMode) => void;
  onCropAspectChange: (ratio: CropAspectRatio) => void;
  onExpandAspectChange: (ratio: MagnificAspectRatio) => void;
  onExpandPromptChange: (prompt: string) => void;
};

/** リサイズの上段パネル。比率を決め、実行は下の適応バーから行う。 */
export function ResizePanel({
  mode,
  cropAspect,
  expandAspect,
  expandPrompt,
  busy = false,
  onModeChange,
  onCropAspectChange,
  onExpandAspectChange,
  onExpandPromptChange,
}: ResizePanelProps) {
  const ratios = mode === "crop" ? CROP_ASPECT_RATIOS : MAGNIFIC_ASPECT_RATIOS;
  const selected = mode === "crop" ? cropAspect : expandAspect;

  return (
    <div className="px-4 pb-2 pt-2">
      <div className="grid grid-cols-2 rounded-lg border border-[#343434] bg-[#101010] p-1">
        <ModeButton active={mode === "expand"} disabled={busy} onClick={() => onModeChange("expand")}>
          画像拡張
        </ModeButton>
        <ModeButton active={mode === "crop"} disabled={busy} onClick={() => onModeChange("crop")}>
          切り抜き
        </ModeButton>
      </div>

      <p className="mt-3 text-[10px] font-black text-neutral-400">比率</p>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {ratios.map((ratio) => (
          <button
            key={ratio}
            type="button"
            disabled={busy}
            onClick={() => {
              if (mode === "crop") onCropAspectChange(ratio as CropAspectRatio);
              else onExpandAspectChange(ratio as MagnificAspectRatio);
            }}
            className={`rounded-md border px-1.5 py-2 text-[10px] font-black transition ${
              selected === ratio
                ? "border-pink-400 bg-pink-500/20 text-pink-100"
                : "border-[#3a3a3a] bg-[#101010] text-neutral-300 hover:border-pink-400"
            } disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {ratio === "custom" ? "カスタム" : ratio}
          </button>
        ))}
      </div>

      {mode === "expand" ? (
        <label className="mt-3 block text-[10px] font-black text-neutral-400">
          追加したい内容（任意）
          <input
            type="text"
            value={expandPrompt}
            disabled={busy}
            onChange={(event) => onExpandPromptChange(event.target.value)}
            placeholder="例：背景の森を自然につなげる"
            className="mt-1.5 w-full rounded-md border border-[#3a3a3a] bg-[#101010] px-2.5 py-2 text-[11px] font-medium text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400 disabled:opacity-40"
          />
          <span className="mt-1 block font-bold leading-4 text-neutral-600">
            画像拡張はMagnific対応の8比率だけです。カスタムpxは切り抜きで使えます。
          </span>
        </label>
      ) : (
        <p className="mt-3 text-[10px] font-bold leading-4 text-neutral-500">
          キャンバスのピンク枠をドラッグして、残したい範囲を決めます。比率は固定されます。
        </p>
      )}
    </div>
  );
}

type ResizeActionBarProps = {
  mode: ResizeMode;
  cropAspect: CropAspectRatio;
  expandAspect: MagnificAspectRatio;
  cropWidth: number;
  cropHeight: number;
  cropReady: boolean;
  busy: boolean;
  connected: boolean;
  onCropAspectChange: (ratio: CropAspectRatio) => void;
  onExpandAspectChange: (ratio: MagnificAspectRatio) => void;
  onCropWidthChange: (value: number) => void;
  onCropHeightChange: (value: number) => void;
  onRun: () => void;
};

/** textarea の代わりにチャットバーへ入る、リサイズ専用の操作列。 */
export function ResizeActionBar({
  mode,
  cropAspect,
  expandAspect,
  cropWidth,
  cropHeight,
  cropReady,
  busy,
  connected,
  onCropAspectChange,
  onExpandAspectChange,
  onCropWidthChange,
  onCropHeightChange,
  onRun,
}: ResizeActionBarProps) {
  const custom = mode === "crop" && cropAspect === "custom";
  const disabled = busy || (mode === "crop" ? !cropReady : !connected);

  return (
    <div data-resize-action-bar className="flex w-full flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-black text-white">リサイズ</span>
      <select
        aria-label="リサイズ比率"
        value={mode === "crop" ? cropAspect : expandAspect}
        disabled={busy}
        onChange={(event) => {
          if (mode === "crop") onCropAspectChange(event.target.value as CropAspectRatio);
          else onExpandAspectChange(event.target.value as MagnificAspectRatio);
        }}
        className="rounded-md border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-[11px] font-bold text-neutral-200 outline-none focus:border-pink-400 disabled:opacity-40"
      >
        {(mode === "crop" ? CROP_ASPECT_RATIOS : MAGNIFIC_ASPECT_RATIOS).map((ratio) => (
          <option key={ratio} value={ratio}>{ratio === "custom" ? "カスタム" : ratio}</option>
        ))}
      </select>

      {mode === "crop" ? (
        <>
          <DimensionInput
            label="↔"
            ariaLabel="切り抜き幅"
            value={cropWidth}
            editable={custom}
            disabled={busy}
            onChange={onCropWidthChange}
          />
          <DimensionInput
            label="↕"
            ariaLabel="切り抜き高さ"
            value={cropHeight}
            editable={custom}
            disabled={busy}
            onChange={onCropHeightChange}
          />
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-neutral-500">
          空いた部分を自然につなげます
        </span>
      )}

      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        className="ml-auto flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-pink-500 px-4 text-[11px] font-black text-white hover:bg-pink-400 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        {busy ? <Spinner /> : null}
        {busy ? "処理中…" : mode === "crop" ? "切り抜く" : "画像を拡張"}
      </button>
    </div>
  );
}

function ModeButton({
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
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-2 py-1.5 text-[10px] font-black ${
        active ? "bg-pink-500 text-white" : "text-neutral-400 hover:text-white"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function DimensionInput({
  label,
  ariaLabel,
  value,
  editable,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  editable: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] font-bold text-neutral-400">
      <span>{label}</span>
      <input
        type="number"
        aria-label={ariaLabel}
        min={1}
        step={1}
        value={Math.max(1, Math.round(value))}
        readOnly={!editable}
        disabled={disabled}
        onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))}
        className={`w-20 rounded-md border border-[#3a3a3a] bg-[#101010] px-2 py-1.5 text-right font-mono text-neutral-200 outline-none focus:border-pink-400 disabled:opacity-40 ${
          editable ? "" : "cursor-default text-neutral-500"
        }`}
      />
      <span>px</span>
    </label>
  );
}

function Spinner() {
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export default ResizePanel;
