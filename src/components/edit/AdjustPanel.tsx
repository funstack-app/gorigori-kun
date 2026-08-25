import { convertFileSrc } from "@tauri-apps/api/core";
import { useState, type ReactNode } from "react";

import {
  ADJUST_PRESETS,
  isNeutralAdjust,
  type AdjustValues,
} from "./editor/adjustFilters";
import type { TransformKind } from "./editor/canvasTransforms";

type Props = {
  imagePath: string;
  values: AdjustValues;
  onChange: (patch: Partial<AdjustValues>) => void;
  onCommit: () => void;
  onPreset: (values: AdjustValues) => void;
  onReset: () => void;
  onTransform: (kind: TransformKind) => void;
  busy?: boolean;
};

type SliderSpec = {
  key: "brightness" | "contrast" | "saturation" | "hue" | "noise";
  label: string;
  min: number;
  max: number;
  step: number;
};

const LIGHT_SLIDERS: readonly SliderSpec[] = [
  { key: "brightness", label: "明るさ", min: -0.5, max: 0.5, step: 0.01 },
  { key: "contrast", label: "コントラスト", min: -0.5, max: 0.5, step: 0.01 },
];

const COLOR_SLIDERS: readonly SliderSpec[] = [
  { key: "saturation", label: "彩度", min: -1, max: 1, step: 0.01 },
  { key: "hue", label: "色温度", min: -180, max: 180, step: 1 },
  { key: "noise", label: "粒子", min: 0, max: 100, step: 1 },
];

const TRANSFORMS: ReadonlyArray<{ kind: TransformKind; label: string }> = [
  { kind: "rotate-left", label: "90°左回転" },
  { kind: "rotate-right", label: "90°右回転" },
  { kind: "flip-h", label: "左右反転" },
  { kind: "flip-v", label: "上下反転" },
];

/** ローカル調整。プリセットと3つのアコーディオンを1つのパネルへまとめる。 */
export function AdjustPanel({
  imagePath,
  values,
  onChange,
  onCommit,
  onPreset,
  onReset,
  onTransform,
  busy = false,
}: Props) {
  const [open, setOpen] = useState({ light: true, color: false, rotate: false });
  const neutral = isNeutralAdjust(values);
  const src = convertFileSrc(imagePath);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
      <p className="text-[10px] font-bold leading-4 text-neutral-500">
        画像の中だけで処理するので、AIの待ち時間や料金はありません。
      </p>

      <p className="mt-3 text-[10px] font-black text-neutral-400">プリセット</p>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {ADJUST_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onPreset(preset.values)}
            disabled={busy}
            className="group overflow-hidden rounded-lg border border-[#343434] bg-[#101010] hover:border-pink-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <img
              src={src}
              alt=""
              className="aspect-[4/3] w-full object-cover"
              style={{ filter: preset.cssFilter }}
            />
            <span className="block truncate px-1 py-1 text-[8px] font-bold text-neutral-300 group-hover:text-white">
              {preset.label}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        <Accordion
          title="ライト"
          open={open.light}
          onToggle={() => setOpen((current) => ({ ...current, light: !current.light }))}
        >
          <SliderGroup
            sliders={LIGHT_SLIDERS}
            values={values}
            busy={busy}
            onChange={onChange}
            onCommit={onCommit}
          />
        </Accordion>

        <Accordion
          title="カラー"
          open={open.color}
          onToggle={() => setOpen((current) => ({ ...current, color: !current.color }))}
        >
          <SliderGroup
            sliders={COLOR_SLIDERS}
            values={values}
            busy={busy}
            onChange={onChange}
            onCommit={onCommit}
          />
        </Accordion>

        <Accordion
          title="回転"
          open={open.rotate}
          onToggle={() => setOpen((current) => ({ ...current, rotate: !current.rotate }))}
        >
          <div className="grid grid-cols-2 gap-1.5">
            {TRANSFORMS.map((item) => (
              <button
                key={item.kind}
                type="button"
                onClick={() => onTransform(item.kind)}
                disabled={busy}
                className="rounded-md border border-[#3a3a3a] bg-[#101010] px-2 py-2 text-[10px] font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {item.label}
              </button>
            ))}
          </div>
        </Accordion>
      </div>

      <button
        type="button"
        onClick={onReset}
        disabled={busy || neutral}
        className="mt-3 w-full rounded-md border border-[#3a3a3a] bg-[#101010] px-2 py-2 text-[10px] font-black text-neutral-300 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        すべてリセット
      </button>
    </div>
  );
}

function Accordion({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-[#333] bg-[#1c1c1c]">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center justify-between px-2.5 py-2 text-left text-[10px] font-black text-neutral-200 hover:text-white"
      >
        <span>{title}</span>
        <span className={`text-pink-300 transition ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {open ? <div className="border-t border-[#333] p-2.5">{children}</div> : null}
    </section>
  );
}

function SliderGroup({
  sliders,
  values,
  busy,
  onChange,
  onCommit,
}: {
  sliders: readonly SliderSpec[];
  values: AdjustValues;
  busy: boolean;
  onChange: (patch: Partial<AdjustValues>) => void;
  onCommit: () => void;
}) {
  return (
    <div className="space-y-2.5">
      {sliders.map((slider) => (
        <label key={slider.key} className="block">
          <span className="flex items-center justify-between text-[10px] font-bold text-neutral-400">
            <span>{slider.label}</span>
            <span className="tabular-nums text-neutral-500">
              {formatValue(slider, values[slider.key])}
            </span>
          </span>
          <input
            type="range"
            aria-label={slider.label}
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={values[slider.key]}
            disabled={busy}
            onChange={(event) =>
              onChange({ [slider.key]: Number(event.target.value) } as Partial<AdjustValues>)
            }
            onPointerUp={onCommit}
            onKeyUp={onCommit}
            onTouchEnd={onCommit}
            className="mt-1 w-full accent-pink-500 disabled:cursor-not-allowed disabled:opacity-40"
          />
        </label>
      ))}
    </div>
  );
}

function formatValue(slider: SliderSpec, value: number): string {
  if (slider.key === "hue") return `${Math.round(value)}°`;
  if (slider.key === "noise") return String(Math.round(value));
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)}`;
}

export default AdjustPanel;
