import { convertFileSrc } from "@tauri-apps/api/core";
import { useState, type MouseEvent } from "react";

import {
  snapLightAzimuth,
  snapLightElevation,
  type LightAzimuth,
  type LightElevation,
} from "./editToolLogic";

type Props = {
  imagePath: string;
  azimuth: LightAzimuth;
  elevation: LightElevation;
  disabled?: boolean;
  onChange: (value: { azimuth: LightAzimuth; elevation: LightElevation }) => void;
};

const QUICK_DIRECTIONS: ReadonlyArray<{
  label: string;
  azimuth: LightAzimuth;
  elevation: LightElevation;
}> = [
  { label: "上", azimuth: 0, elevation: 90 },
  { label: "前", azimuth: 0, elevation: 0 },
  { label: "右", azimuth: 90, elevation: 0 },
  { label: "左", azimuth: -90, elevation: 0 },
  { label: "後ろ", azimuth: 180, elevation: 0 },
  { label: "下", azimuth: 0, elevation: -90 },
];

const VIEW_WIDTH = 260;
const VIEW_HEIGHT = 164;
const CENTER_X = VIEW_WIDTH / 2;
const CENTER_Y = 72;

function lightPoint(azimuth: LightAzimuth, elevation: LightElevation) {
  return {
    x: CENTER_X + (azimuth / 180) * 98,
    y: CENTER_Y - (elevation / 90) * 46,
  };
}

/** 画像の前に置いたライトを動かす、見た目だけ3Dの操作盤。 */
export function LightOrbitWidget({
  imagePath,
  azimuth,
  elevation,
  disabled = false,
  onChange,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const point = lightPoint(azimuth, elevation);

  const updateFromMouse = (event: MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT;
    onChange({
      azimuth: snapLightAzimuth(((x - CENTER_X) / 98) * 180),
      elevation: snapLightElevation(((CENTER_Y - y) / 46) * 90),
    });
  };

  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className={`w-full select-none rounded-xl border border-[#343434] bg-[#101010] ${
          disabled ? "cursor-not-allowed opacity-50" : dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        aria-label="ライト位置プレビュー"
        role="img"
        onMouseDown={(event) => {
          if (disabled || event.button !== 0) return;
          setDragging(true);
          updateFromMouse(event);
          event.preventDefault();
        }}
        onMouseMove={(event) => {
          if (dragging) updateFromMouse(event);
        }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
      >
        <defs>
          <linearGradient id="light-cone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity=".7" />
            <stop offset="1" stopColor="#fff" stopOpacity=".04" />
          </linearGradient>
          <clipPath id="light-image-plane">
            <path d="M58 73 L202 73 L218 145 L42 145 Z" />
          </clipPath>
        </defs>
        <path d="M58 73 L202 73 L218 145 L42 145 Z" fill="#222" stroke="#555" />
        <image
          href={convertFileSrc(imagePath)}
          x="42"
          y="73"
          width="176"
          height="72"
          preserveAspectRatio="xMidYMid slice"
          clipPath="url(#light-image-plane)"
          opacity=".86"
        />
        <path
          d={`M${point.x} ${point.y} L96 112 L164 112 Z`}
          fill="url(#light-cone)"
          stroke="rgba(255,255,255,.25)"
        />
        <line x1={point.x} y1={point.y} x2={CENTER_X} y2="112" stroke="#f9a8d4" strokeDasharray="3 4" />
        <circle cx={point.x} cy={point.y} r="11" fill="#ec4899" opacity=".2" />
        <circle cx={point.x} cy={point.y} r="6" fill="#fff" stroke="#ec4899" strokeWidth="3" />
        <text x="10" y="18" fill="#a3a3a3" fontSize="9">ドラッグで光の方向を決める</text>
        <text x="250" y="18" textAnchor="end" fill="#fbcfe8" fontSize="9">
          {azimuth}° / {elevation}°
        </text>
      </svg>

      <div className="mt-2 grid grid-cols-6 gap-1">
        {QUICK_DIRECTIONS.map((item) => {
          const active = item.azimuth === azimuth && item.elevation === elevation;
          return (
            <button
              key={item.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ azimuth: item.azimuth, elevation: item.elevation })}
              className={`rounded-md border px-1 py-1.5 text-[10px] font-black transition ${
                active
                  ? "border-pink-400 bg-pink-500/20 text-pink-100"
                  : "border-[#3a3a3a] bg-[#101010] text-neutral-300 hover:border-pink-400"
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default LightOrbitWidget;
