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

/**
 * 光源の画面位置。プレーンの周りを回る軌道に置く (プレーンに重ならない)。
 * 方位: 0=手前下, ±90=左右, 180=後ろ上。高さ: 90 で真上、-90 で真下。
 */
function lightPoint(azimuth: number, elevation: number) {
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  const ce = Math.cos(elRad);
  const depth = Math.cos(azRad); // 1=正面, -1=真後ろ
  return {
    x: PLANE.cx + (70 * Math.sin(azRad) - 30 * depth) * ce,
    y: PLANE.cy + 52 * depth * ce - 74 * Math.sin(elRad),
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
    // 近似の逆写像でよい (最終的に 8方位×5段へスナップされるため)。
    const azimuthRaw = ((x - (PLANE.cx - 30)) / 70) * 90;
    const elevationRaw = ((PLANE.cy + 20 - y) / 74) * 90;
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

  // 光錐: 光源から見た輪郭 (角の見込み角の最小〜最大) だけで扇を作る。
  // 4隅を全部つなぐと自己交差した楔になる (2026-08-26 実害)。
  const corners = [
    { x: planeLeft, y: planeTop },
    { x: planeRight, y: planeTop },
    { x: planeRight, y: planeBottom },
    { x: planeLeft, y: planeBottom },
  ]
    .map((corner) => ({
      ...corner,
      angle: Math.atan2(corner.y - light.y, corner.x - light.x),
    }))
    .sort((a, b) => a.angle - b.angle);
  const beamPoints = [
    `${light.x},${light.y}`,
    ...corners.map((corner) => `${corner.x},${corner.y}`),
  ].join(" ");

  return (
    <div
      ref={hostRef}
      className="relative select-none overflow-hidden rounded-xl border border-white/10"
      style={{
        width: "100%",
        aspectRatio: `${W} / ${H}`,
        background: "radial-gradient(130% 110% at 50% 8%, #201b3a 0%, #161226 48%, #0e0b1c 100%)",
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
            "repeating-linear-gradient(0deg, rgba(150,140,235,0.20) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(150,140,235,0.20) 0 1px, transparent 1px 26px)",
          maskImage: "radial-gradient(closest-side, black 38%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(closest-side, black 38%, transparent 78%)",
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
          points={beamPoints}
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

      {/* 床への映り込み (立体感)。上下反転した画像をフェードで薄く敷く */}
      <div
        className="pointer-events-none absolute overflow-hidden"
        style={{
          left: planeLeft,
          top: planeBottom + 2,
          width: PLANE.width,
          height: 30,
          perspective: 260,
          opacity: 0.22,
          maskImage: "linear-gradient(180deg, black 0%, transparent 90%)",
          WebkitMaskImage: "linear-gradient(180deg, black 0%, transparent 90%)",
        }}
      >
        <img
          src={src}
          alt=""
          className="h-[66px] w-full rounded-[2px] object-cover"
          style={{ transform: "rotateY(-26deg) scaleY(-1)" }}
          draggable={false}
        />
      </div>

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
