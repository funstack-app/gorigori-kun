import { useState } from "react";

import type { TextLayerSpec, TextRegion } from "../../lib/edit/types";

import { FontPicker } from "./FontPicker";

type TextLayerCardProps = {
  region: TextRegion;
  initial?: Partial<TextLayerSpec>;
  onChange: (spec: TextLayerSpec) => void;
  onRemove: () => void;
};

export function TextLayerCard({
  region,
  initial,
  onChange,
  onRemove,
}: TextLayerCardProps) {
  const [text, setText] = useState(initial?.text ?? region.text);
  const [fontFamily, setFontFamily] = useState<string>(
    initial?.fontFamily ?? initial?.font ?? "system-ui",
  );
  const [fontSize, setFontSize] = useState<number>(
    initial?.fontSize ?? initial?.size ?? Math.max(12, Math.floor(region.bbox[3] * 0.8)),
  );
  const [color, setColor] = useState<string>(initial?.color ?? "#000000");
  const [fontWeight, setFontWeight] = useState<"normal" | "bold">(
    initial?.fontWeight ?? "normal",
  );
  const [align, setAlign] = useState<"left" | "center" | "right">(
    initial?.align ?? "left",
  );

  const commit = (patch: Partial<TextLayerSpec>) => {
    onChange({
      id: region.id,
      text,
      bbox: region.bbox,
      fontFamily,
      fontSize,
      fontWeight,
      color,
      align,
      ...patch,
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <span className="block text-[10px] font-bold text-neutral-500">
            元テキスト: {region.text}
          </span>
          <input
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              commit({ text: e.target.value });
            }}
            className="mt-1 w-full rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-pink-400"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-[11px] font-bold text-neutral-400 hover:border-red-400 hover:text-red-300"
        >
          削除
        </button>
      </div>

      <FontPicker
        value={fontFamily}
        onChange={(family) => {
          setFontFamily(family);
          commit({ fontFamily: family });
        }}
        languageHint={region.language ?? "ja"}
      />

      <div className="grid grid-cols-3 gap-2">
        <label className="block text-xs">
          <span className="font-bold text-neutral-300">サイズ</span>
          <input
            type="number"
            min={8}
            max={200}
            value={fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFontSize(v);
              commit({ fontSize: v });
            }}
            className="mt-1 w-full rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-neutral-100 outline-none focus:border-pink-400"
          />
        </label>
        <label className="block text-xs">
          <span className="font-bold text-neutral-300">太さ</span>
          <select
            value={fontWeight}
            onChange={(e) => {
              const v = e.target.value as "normal" | "bold";
              setFontWeight(v);
              commit({ fontWeight: v });
            }}
            className="mt-1 w-full rounded border border-[#343434] bg-[#0b0b0b] px-2 py-1 text-neutral-100 outline-none focus:border-pink-400"
          >
            <option value="normal">Regular</option>
            <option value="bold">Bold</option>
          </select>
        </label>
        <label className="block text-xs">
          <span className="font-bold text-neutral-300">色</span>
          <input
            type="color"
            value={color}
            onChange={(e) => {
              setColor(e.target.value);
              commit({ color: e.target.value });
            }}
            className="mt-1 h-[28px] w-full rounded border border-[#343434] bg-[#0b0b0b] outline-none"
          />
        </label>
      </div>

      <div className="flex items-center gap-1 text-[11px]">
        <span className="font-bold text-neutral-300">配置:</span>
        {(["left", "center", "right"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setAlign(option);
              commit({ align: option });
            }}
            className={`flex-1 rounded border px-2 py-1 font-bold transition ${
              align === option
                ? "border-pink-400 bg-pink-500/15 text-pink-100"
                : "border-[#343434] bg-[#0b0b0b] text-neutral-400 hover:border-pink-400"
            }`}
          >
            {option === "left" ? "左" : option === "center" ? "中央" : "右"}
          </button>
        ))}
      </div>
    </div>
  );
}
