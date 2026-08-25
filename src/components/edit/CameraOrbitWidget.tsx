import { convertFileSrc } from "@tauri-apps/api/core";
import { useState, type MouseEvent } from "react";

import { clampCameraVertical, normalizeCameraRotate } from "./editToolLogic";

type Props = {
  imagePath: string;
  rotate: number;
  vertical: number;
  disabled?: boolean;
  onChange: (value: { rotate: number; vertical: number }) => void;
};

const VIEW_WIDTH = 260;
const VIEW_HEIGHT = 172;
const CENTER_X = 130;
const CENTER_Y = 92;
const RADIUS_X = 104;
const RADIUS_Y = 48;

function cameraPoint(rotate: number, vertical: number) {
  const radians = (normalizeCameraRotate(rotate) * Math.PI) / 180;
  return {
    x: CENTER_X + Math.sin(radians) * RADIUS_X,
    y: CENTER_Y - Math.cos(radians) * RADIUS_Y - ((vertical - 30) / 120) * 22,
  };
}

/** 楕円の周りの玉を動かし、カメラの水平回転と高さへ変換する。 */
export function CameraOrbitWidget({
  imagePath,
  rotate,
  vertical,
  disabled = false,
  onChange,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const point = cameraPoint(rotate, vertical);

  const updateFromMouse = (event: MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT;
    const dx = (x - CENTER_X) / RADIUS_X;
    const dy = (y - CENTER_Y) / RADIUS_Y;
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const verticalValue = 90 - ((y - (CENTER_Y - RADIUS_Y)) / (RADIUS_Y * 2)) * 120;
    onChange({
      rotate: normalizeCameraRotate(angle),
      vertical: clampCameraVertical(verticalValue),
    });
  };

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className={`w-full select-none rounded-xl border border-[#343434] bg-[#101010] ${
        disabled ? "cursor-not-allowed opacity-50" : dragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      aria-label="カメラ軌道プレビュー"
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
        <clipPath id="camera-image-plane">
          <rect x="85" y="53" width="90" height="76" rx="7" />
        </clipPath>
      </defs>
      <text x="10" y="17" fill="#a3a3a3" fontSize="9">玉をドラッグして視点を回す</text>
      <text x="250" y="17" textAnchor="end" fill="#fbcfe8" fontSize="9">
        {rotate}° / {vertical}°
      </text>
      <ellipse
        cx={CENTER_X}
        cy={CENTER_Y}
        rx={RADIUS_X}
        ry={RADIUS_Y}
        fill="none"
        stroke="#525252"
        strokeWidth="2"
        strokeDasharray="4 5"
      />
      <rect x="85" y="53" width="90" height="76" rx="7" fill="#222" stroke="#555" />
      <image
        href={convertFileSrc(imagePath)}
        x="85"
        y="53"
        width="90"
        height="76"
        preserveAspectRatio="xMidYMid slice"
        clipPath="url(#camera-image-plane)"
        opacity=".88"
      />
      <line x1={point.x} y1={point.y} x2={CENTER_X} y2={CENTER_Y} stroke="#f9a8d4" strokeDasharray="3 4" />
      <circle cx={point.x} cy={point.y} r="13" fill="#ec4899" opacity=".2" />
      <circle cx={point.x} cy={point.y} r="7" fill="#ec4899" stroke="white" strokeWidth="2" />
      <path
        d={`M${point.x - 5} ${point.y - 3}h10v7h-10z M${point.x + 5} ${point.y - 1}l5-3v7l-5-3`}
        fill="white"
        transform={`scale(.55) translate(${point.x * .82} ${point.y * .82})`}
        opacity=".9"
      />
    </svg>
  );
}

export default CameraOrbitWidget;
