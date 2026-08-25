import { useState, type ReactNode } from "react";

import type { MagnificImageEditTool } from "../../lib/ipc";

export type MagnificPanelTool = Exclude<MagnificImageEditTool, "upscale">;

type MagnificToolPanelProps = {
  tool: MagnificPanelTool;
  busy: boolean;
  connected: boolean;
  onRun: (params: Record<string, unknown>) => void;
};

const ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
] as const;

const LIGHT_DIRECTIONS = [
  { label: "前", azimuth: 0, elevation: 0 },
  { label: "上", azimuth: 0, elevation: 90 },
  { label: "下", azimuth: 0, elevation: -90 },
  { label: "左", azimuth: -90, elevation: 0 },
  { label: "右", azimuth: 90, elevation: 0 },
  { label: "後ろ", azimuth: 180, elevation: 0 },
] as const;

/** B2で作り直すまで使う、Magnific 専用3ツールの暫定設定パネル。 */
export function MagnificToolPanel({
  tool,
  busy,
  connected,
  onRun,
}: MagnificToolPanelProps) {
  if (tool === "expand") {
    return <ExpandPanel busy={busy} connected={connected} onRun={onRun} />;
  }
  if (tool === "camera") {
    return <CameraPanel busy={busy} connected={connected} onRun={onRun} />;
  }
  return <RelightPanel busy={busy} connected={connected} onRun={onRun} />;
}

type PanelProps = Omit<MagnificToolPanelProps, "tool">;

function ExpandPanel({ busy, connected, onRun }: PanelProps) {
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("16:9");
  const [prompt, setPrompt] = useState("");

  return (
    <PanelBody>
      <PanelLabel>広げる比率</PanelLabel>
      <ChipGrid columns={4}>
        {ASPECT_RATIOS.map((ratio) => (
          <Chip
            key={ratio}
            active={aspectRatio === ratio}
            disabled={busy}
            onClick={() => setAspectRatio(ratio)}
          >
            {ratio}
          </Chip>
        ))}
      </ChipGrid>
      <label className="mt-4 block text-[10px] font-black text-neutral-400">
        追加したい内容（任意）
        <input
          type="text"
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例：背景の森を自然につなげる"
          className="mt-1.5 w-full rounded-md border border-[#3a3a3a] bg-[#101010] px-2.5 py-2 text-[11px] font-medium text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-pink-400 disabled:opacity-40"
        />
      </label>
      <RunButton
        busy={busy}
        connected={connected}
        onClick={() =>
          onRun({
            aspectRatio,
            ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          })
        }
      />
    </PanelBody>
  );
}

function CameraPanel({ busy, connected, onRun }: PanelProps) {
  const [rotate, setRotate] = useState(45);
  const [vertical, setVertical] = useState(0);
  const [closeup, setCloseup] = useState(5);

  return (
    <PanelBody>
      <Slider
        label="回転"
        value={rotate}
        suffix="°"
        min={0}
        max={360}
        step={15}
        disabled={busy}
        onChange={setRotate}
      />
      <Slider
        label="垂直"
        value={vertical}
        suffix="°"
        min={-30}
        max={90}
        step={15}
        disabled={busy}
        onChange={setVertical}
      />
      <Slider
        label="寄り"
        value={closeup}
        min={0}
        max={10}
        step={1}
        disabled={busy}
        onChange={setCloseup}
      />
      <RunButton
        busy={busy}
        connected={connected}
        onClick={() => onRun({ rotate, vertical, closeup })}
      />
    </PanelBody>
  );
}

function RelightPanel({ busy, connected, onRun }: PanelProps) {
  const [directionIndex, setDirectionIndex] = useState(0);
  const [intensity, setIntensity] = useState(5);
  const direction = LIGHT_DIRECTIONS[directionIndex];

  return (
    <PanelBody>
      <PanelLabel>光の方向</PanelLabel>
      <ChipGrid columns={3}>
        {LIGHT_DIRECTIONS.map((item, index) => (
          <Chip
            key={item.label}
            active={directionIndex === index}
            disabled={busy}
            onClick={() => setDirectionIndex(index)}
          >
            {item.label}
          </Chip>
        ))}
      </ChipGrid>
      <div className="mt-4">
        <Slider
          label="強さ"
          value={intensity}
          min={1}
          max={10}
          step={1}
          disabled={busy}
          onChange={setIntensity}
        />
      </div>
      <RunButton
        busy={busy}
        connected={connected}
        onClick={() =>
          onRun({
            azimuth: direction.azimuth,
            elevation: direction.elevation,
            intensity,
          })
        }
      />
    </PanelBody>
  );
}

function PanelBody({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1 pt-2">{children}</div>;
}

function PanelLabel({ children }: { children: string }) {
  return <p className="text-[10px] font-black text-neutral-400">{children}</p>;
}

function ChipGrid({
  children,
  columns,
}: {
  children: ReactNode;
  columns: 2 | 3 | 4;
}) {
  const gridClass =
    columns === 4 ? "grid-cols-4" : columns === 3 ? "grid-cols-3" : "grid-cols-2";
  return <div className={`mt-1.5 grid ${gridClass} gap-1.5`}>{children}</div>;
}

function Chip({
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
      className={`rounded-md border px-2 py-1.5 text-[10px] font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-pink-400 bg-pink-500/20 text-pink-100"
          : "border-[#3a3a3a] bg-[#101010] text-neutral-300 hover:border-pink-400 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  suffix = "",
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mb-3 block text-[10px] font-black text-neutral-400">
      <span className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="font-mono text-neutral-200">
          {value}{suffix}
        </span>
      </span>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 w-full accent-pink-500 disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

function RunButton({
  busy,
  connected,
  onClick,
}: {
  busy: boolean;
  connected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy || !connected}
      title={!connected ? "設定で Magnific に接続すると使えます" : "実行"}
      onClick={onClick}
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-pink-500 px-3 py-2 text-[11px] font-black text-white shadow-lg shadow-pink-500/20 hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? <Spinner /> : null}
      {busy ? "処理中…" : "実行"}
    </button>
  );
}

function Spinner() {
  return (
    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}

export default MagnificToolPanel;
