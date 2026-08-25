import { convertFileSrc } from "@tauri-apps/api/core";
import { useRef, useState, type PointerEvent } from "react";

import {
  snapLightAzimuth,
  snapLightElevation,
  type LightAzimuth,
  type LightElevation,
} from "./editToolLogic";

/**
 * 再ライティングの 3D プレビュー (Magnific 本家と同じ見た目 / 2026-08-26 STΛCK指示)。
 *
 * - 遠近グリッドの床 + 立っている画像プレーン
 * - 光源の玉をドラッグすると、光錐 (コーン) がプレーンへ当たる向きが変わる
 * - API は 8方位 × 5段しか受けないため、ドラッグはその位置へスナップする
 *   (見た目は3Dでも、作られるのは同じ直接MCP引数)
 */

type Props = {
  imagePath: string;
  azimuth: LightAzimuth;
  elevation: LightElevation;
  /** 強さ 1-10。光錐の濃さに反映する。 */
  intensity?: number;
  /** ライト色 (#rrggbb)。白 = neutral。 */
  color?: string;
  disabled?: boolean;
  onChange: (value: { azimuth: LightAzimuth; elevation: LightElevation }) => void;
};

const W = 260;
const H = 196;
const CX = 130;
/** プレーン(画像)の中心と実寸 (画面座標)。 */
const PLANE = { cx: CX + 18, cy: 96, width: 88, height: 66 };

/** 光源の画面位置。方位で左右へ回り、高さで上下する。 */
function lightPoint(azimuth: number, elevation: number) {
  const azRad = (azimuth * Math.PI) / 180;
  const depth = Math.cos(azRad); // 1=正面, -1=真後ろ
  return {
    x: CX - 34 + Math.sin(azRad) * 88,
    y: 96 - (elevation / 90) * 56 + (1 - Math.abs(depth)) * 6,
    behind: depth < 0,
  };
}

export function LightOrbitWidget({
  imagePath,
  azimuth,
  elevation,
  intensity = 5,
  color = "#ffffff",
  disabled = false,
  onChange,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  const light = lightPoint(azimuth, elevation);
  const beamOpacity = 0.16 + (Math.max(1, Math.min(10, intensity)) / 10) * 0.38;

  const updateFromPointer = (event: PointerEvent) => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * W;
    const y = ((event.clientY - rect.top) / rect.height) * H;
    const azimuthRaw = ((x - (CX - 34)) / 88) * 90; // 中央=0°, 端で±90°超
    const elevationRaw = ((96 - y) / 56) * 90;
    onChange({
      azimuth: snapLightAzimuth(azimuthRaw),
      elevation: snapLightElevation(elevationRaw),
    });
  };

  const begin = (event: PointerEvent) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setDragging(true);
    updateFromPointer(event);
  };
  const move = (event: PointerEvent) => {
    if (!dragging) return;
    event.preventDefault();
    updateFromPointer(event);
  };
  const end = (event: PointerEvent) => {
    if (!dragging) return;
    if ((event.currentTarget as Element).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const src = convertFileSrc(imagePath);
  const planeLeft = PLANE.cx - PLANE.width / 2;
  const planeRight = PLANE.cx + PLANE.width / 2;
  const planeBottom = PLANE.cy + PLANE.height / 2;
  const planeTop = PLANE.cy - PLANE.height / 2;

  return (
    <div
      ref={hostRef}
      className="relative select-none overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0d]"
      style={{
        width: "100%",
        aspectRatio: `${W} / ${H}`,
        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="presentation"
    >
      {/* ごく薄い遠近グリッド */}
      <div
        className="pointer-events-none absolute left-1/2 top-[62%]"
        style={{
          width: 420,
          height: 420,
          transform: "translate(-50%, -50%) perspective(420px) rotateX(74deg)",
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(148,155,190,0.10) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(148,155,190,0.10) 0 1px, transparent 1px 26px)",
          maskImage: "radial-gradient(closest-side, black 30%, transparent 70%)",
          WebkitMaskImage: "radial-gradient(closest-side, black 30%, transparent 70%)",
        }}
      />

      {/* 光錐: プロジェクターからプレーン全体へ (発光なし・柔らかい面) */}
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <linearGradient
            id="light-beam"
            gradientUnits="userSpaceOnUse"
            x1={light.x}
            y1={light.y}
            x2={PLANE.cx}
            y2={PLANE.cy}
          >
            <stop offset="0%" stopColor={color} stopOpacity={beamOpacity} />
            <stop offset="100%" stopColor={color} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <polygon
          points={`${light.x},${light.y} ${planeLeft},${planeTop} ${planeLeft},${planeBottom} ${planeRight},${planeBottom} ${planeRight},${planeTop}`}
          fill="url(#light-beam)"
          opacity={light.behind ? 0.35 : 1}
        />
      </svg>

      {/* 床の接地影 */}
      <div
        className="pointer-events-none absolute rounded-[50%] bg-black/70 blur-[6px]"
        style={{
          left: planeLeft + 4,
          top: planeBottom + 4,
          width: PLANE.width + 8,
          height: 13,
        }}
      />

      {/* 立っている画像プレーン (強めの遠近で立体に見せる) */}
      <div
        className="pointer-events-none absolute"
        style={{
          left: planeLeft,
          top: planeTop,
          width: PLANE.width,
          height: PLANE.height,
          perspective: 260,
        }}
      >
        <img
          src={src}
          alt=""
          className="h-full w-full rounded-[2px] object-cover"
          style={{
            transform: "rotateY(-26deg) rotateX(2deg)",
            boxShadow: `0 8px 16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.12), ${light.x < PLANE.cx ? "-2px" : "2px"} ${light.y < PLANE.cy ? "-2px" : "2px"} 10px ${color}33`,
            filter: light.behind ? "brightness(0.8)" : undefined,
          }}
          draggable={false}
        />
      </div>

      {/* プロジェクター (光源)。掴んで動かす対象はビュー全体 */}
      <div
        className="pointer-events-none absolute"
        style={{
          left: light.x - 11,
          top: light.y - 8,
          width: 22,
          height: 15,
          borderRadius: 4,
          background: "linear-gradient(180deg, #3d3d46 0%, #23232a 100%)",
          border: "1px solid rgba(255,255,255,0.22)",
          opacity: light.behind ? 0.6 : 1,
          transform: `rotate(${(Math.atan2(PLANE.cy - light.y, PLANE.cx - light.x) * 180) / Math.PI}deg)`,
        }}
      >
        {/* レンズ (発光させず、色だけ見せる) */}
        <span
          className="absolute right-[-4px] top-1/2 h-[9px] w-[9px] -translate-y-1/2 rounded-full"
          style={{ background: color, border: "1px solid rgba(0,0,0,0.5)" }}
        />
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[10px] font-bold text-neutral-400">
        ドラッグしてライトの位置を調整
      </p>
    </div>
  );
}

export default LightOrbitWidget;
