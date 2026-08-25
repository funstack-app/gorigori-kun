import { useState, type ReactNode } from "react";

import { CameraOrbitWidget } from "./CameraOrbitWidget";
import {
  snapLightAzimuth,
  snapLightElevation,
  type LightAzimuth,
  type LightElevation,
} from "./editToolLogic";
import { LightOrbitWidget } from "./LightOrbitWidget";

export type MagnificPanelTool = "camera" | "relight";

type MagnificToolPanelProps = {
  tool: MagnificPanelTool;
  imagePath: string;
  busy: boolean;
  connected: boolean;
  onRun: (params: Record<string, unknown>) => void;
};

export function MagnificToolPanel({
  tool,
  imagePath,
  busy,
  connected,
  onRun,
}: MagnificToolPanelProps) {
  if (tool === "camera") {
    return (
      <CameraPanel
        imagePath={imagePath}
        busy={busy}
        connected={connected}
        onRun={onRun}
      />
    );
  }
  return (
    <RelightPanel
      imagePath={imagePath}
      busy={busy}
      connected={connected}
      onRun={onRun}
    />
  );
}

type PanelProps = Omit<MagnificToolPanelProps, "tool">;

function CameraPanel({ imagePath, busy, connected, onRun }: PanelProps) {
  const [rotate, setRotate] = useState(45);
  const [vertical, setVertical] = useState(0);
  const [closeup, setCloseup] = useState(5);

  return (
    <PanelBody>
      <CameraOrbitWidget
        imagePath={imagePath}
        rotate={rotate}
        vertical={vertical}
        closeup={closeup}
        disabled={busy}
        onChange={(next) => {
          setRotate(next.rotate);
          setVertical(next.vertical);
        }}
      />
      <div className="mt-3">
        <Slider label="回転" value={rotate} suffix="°" min={0} max={360} step={1} disabled={busy} onChange={setRotate} />
        <Slider label="高さ" value={vertical} suffix="°" min={-30} max={90} step={1} disabled={busy} onChange={setVertical} />
        <Slider label="寄り" value={closeup} min={0} max={10} step={1} disabled={busy} onChange={setCloseup} />
      </div>
      <RunButton
        busy={busy}
        connected={connected}
        onClick={() => onRun({ rotate, vertical, closeup })}
      />
    </PanelBody>
  );
}

/** ライト色のクイックスワッチ (Magnific 準拠: 白/暖黄/橙/青 + 自由色)。 */
const LIGHT_COLORS = ["#ffffff", "#ffd27f", "#ff9d5c", "#7fc5ff"] as const;

function RelightPanel({ imagePath, busy, connected, onRun }: PanelProps) {
  const [azimuth, setAzimuth] = useState<LightAzimuth>(0);
  const [elevation, setElevation] = useState<LightElevation>(0);
  const [intensity, setIntensity] = useState(5);
  const [color, setColor] = useState<string>("#ffffff");

  return (
    <PanelBody>
      <LightOrbitWidget
        imagePath={imagePath}
        azimuth={azimuth}
        elevation={elevation}
        intensity={intensity}
        color={color}
        disabled={busy}
        onChange={(next) => {
          setAzimuth(next.azimuth);
          setElevation(next.elevation);
        }}
      />
      <div className="mt-3">
        <Slider
          label="横方向"
          value={azimuth}
          suffix="°"
          min={-135}
          max={180}
          step={45}
          disabled={busy}
          onChange={(value) => setAzimuth(snapLightAzimuth(value))}
        />
        <Slider
          label="高さ"
          value={elevation}
          suffix="°"
          min={-90}
          max={90}
          step={45}
          disabled={busy}
          onChange={(value) => setElevation(snapLightElevation(value))}
        />
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
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-[#343434] bg-[#101010] px-2.5 py-2">
        <span className="text-[10px] font-bold text-neutral-400">ライト色</span>
        <div className="flex items-center gap-1.5">
          {LIGHT_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              disabled={busy}
              onClick={() => setColor(swatch)}
              aria-label={`ライト色 ${swatch}`}
              className={`h-5 w-5 rounded-full border transition ${
                color.toLowerCase() === swatch
                  ? "border-pink-400 ring-2 ring-pink-400/60"
                  : "border-white/25 hover:border-white/60"
              }`}
              style={{ background: swatch }}
            />
          ))}
          <label
            className="relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border border-white/25 hover:border-white/60"
            title="自由な色を選ぶ"
            style={{
              background:
                "conic-gradient(#f66 0deg, #fc6 60deg, #6f6 140deg, #6cf 220deg, #a6f 300deg, #f66 360deg)",
            }}
          >
            <input
              type="color"
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </div>
      <RunButton
        busy={busy}
        connected={connected}
        onClick={() =>
          onRun(
            color.toLowerCase() === "#ffffff"
              ? { azimuth, elevation, intensity }
              : { azimuth, elevation, intensity, color },
          )
        }
      />
    </PanelBody>
  );
}

function PanelBody({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1 pt-2">{children}</div>;
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
    <label className="mb-2.5 block text-[10px] font-black text-neutral-400">
      <span className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="font-mono text-neutral-200">{value}{suffix}</span>
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
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export default MagnificToolPanel;
