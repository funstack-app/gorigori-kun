import { convertFileSrc } from "@tauri-apps/api/core";
import { useRef, useState, type PointerEvent } from "react";

import { clampCameraVertical, normalizeCameraRotate } from "./editToolLogic";

/**
 * カメラ変更の 3D プレビュー (Magnific 本家と同じ見た目 / 2026-08-26 STΛCK指示)。
 *
 * - 遠近グリッドの床 + 中央に立つ画像プレーン
 * - 青いオービットリング上の玉 = 水平回転、紫のアーク上の玉 = 垂直方向
 * - 玉を掴んで個別に、背景を掴めば両方まとめて (オービット操作) 動かせる
 * - 右上のミニプレビューが「その角度から見た画像」を擬似再現する
 *
 * 実体は同じ直接MCP引数 (rotate/vertical) を作るだけ。3Dはあくまで操作盤。
 */

type Props = {
  imagePath: string;
  rotate: number;
  vertical: number;
  disabled?: boolean;
  onChange: (value: { rotate: number; vertical: number }) => void;
};

const W = 260;
const H = 196;
const CX = 130;
const CY = 118;
const RX = 100;
const RY = 34;

/** リング上の玉 (水平回転)。0°=手前、時計回り。 */
function ringPoint(rotate: number) {
  const rad = (normalizeCameraRotate(rotate) * Math.PI) / 180;
  return { x: CX + RX * Math.sin(rad), y: CY + RY * Math.cos(rad) };
}

/** アーク上の玉 (垂直 -30..90)。二次ベジェで手前下→左上→真上をなぞる。 */
const ARC_P0 = { x: CX - 8, y: CY + RY - 2 };
const ARC_P1 = { x: CX - 102, y: CY - 66 };
const ARC_P2 = { x: CX + 6, y: CY - RY - 44 };

function arcPoint(vertical: number) {
  const t = (clampCameraVertical(vertical) + 30) / 120;
  const u = 1 - t;
  return {
    x: u * u * ARC_P0.x + 2 * u * t * ARC_P1.x + t * t * ARC_P2.x,
    y: u * u * ARC_P0.y + 2 * u * t * ARC_P1.y + t * t * ARC_P2.y,
  };
}

type DragKind = "ring" | "arc" | "orbit";

export function CameraOrbitWidget({
  imagePath,
  rotate,
  vertical,
  disabled = false,
  onChange,
}: Props) {
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const dragStart = useRef<{ x: number; y: number; rotate: number; vertical: number } | null>(
    null,
  );

  const ring = ringPoint(rotate);
  const arc = arcPoint(vertical);

  const toLocal = (event: PointerEvent) => {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * W,
      y: ((event.clientY - rect.top) / rect.height) * H,
    };
  };

  const begin = (kind: DragKind) => (event: PointerEvent) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    dragStart.current = { x: event.clientX, y: event.clientY, rotate, vertical };
    setDragging(kind);
  };

  const move = (event: PointerEvent) => {
    const start = dragStart.current;
    if (!dragging || !start) return;
    event.preventDefault();
    if (dragging === "ring") {
      const local = toLocal(event);
      const angle =
        (Math.atan2((local.x - CX) / RX, (local.y - CY) / RY) * 180) / Math.PI;
      onChange({ rotate: normalizeCameraRotate(angle), vertical });
      return;
    }
    if (dragging === "arc") {
      const dy = start.y - event.clientY;
      onChange({ rotate, vertical: clampCameraVertical(start.vertical + dy * 0.75) });
      return;
    }
    const dx = event.clientX - start.x;
    const dy = start.y - event.clientY;
    onChange({
      rotate: normalizeCameraRotate(start.rotate + dx * 1.2),
      vertical: clampCameraVertical(start.vertical + dy * 0.75),
    });
  };

  const end = (event: PointerEvent) => {
    if (!dragging) return;
    if ((event.currentTarget as Element).hasPointerCapture(event.pointerId)) {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    }
    dragStart.current = null;
    setDragging(null);
  };

  const src = convertFileSrc(imagePath);
  // 玉が手前 (リング下半分) にいる時だけプレーンより上に描く。
  const ballInFront = Math.cos((normalizeCameraRotate(rotate) * Math.PI) / 180) >= 0;

  return (
    <div
      className="relative select-none overflow-hidden rounded-xl border border-white/10"
      style={{
        width: "100%",
        aspectRatio: `${W} / ${H}`,
        background: "radial-gradient(120% 100% at 50% 0%, #1b1633 0%, #120e24 45%, #0a0817 100%)",
        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={begin("orbit")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="presentation"
    >
      {/* 遠近グリッドの床 */}
      <div
        className="pointer-events-none absolute left-1/2 top-[60%]"
        style={{
          width: 420,
          height: 420,
          transform: "translate(-50%, -50%) perspective(420px) rotateX(72deg)",
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(122,110,255,0.16) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(122,110,255,0.16) 0 1px, transparent 1px 26px)",
          maskImage: "radial-gradient(closest-side, black 35%, transparent 72%)",
          WebkitMaskImage: "radial-gradient(closest-side, black 35%, transparent 72%)",
        }}
      />

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <defs>
          <filter id="cam-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* リング奥半分 (プレーンの後ろ) */}
        <path
          d={`M ${CX - RX} ${CY} A ${RX} ${RY} 0 0 1 ${CX + RX} ${CY}`}
          fill="none"
          stroke="#4353e6"
          strokeWidth="6"
          strokeLinecap="round"
          opacity="0.85"
          filter="url(#cam-glow)"
        />
      </svg>

      {/* 立っている画像プレーン */}
      <div
        className="pointer-events-none absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2"
        style={{ perspective: 320 }}
      >
        <img
          src={src}
          alt=""
          className="block h-[64px] w-auto max-w-[96px] rounded-[3px] object-cover"
          style={{
            transform: "rotateY(-24deg)",
            boxShadow: "0 10px 18px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.14)",
          }}
          draggable={false}
        />
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        {/* リング手前半分 (プレーンの前) */}
        <path
          d={`M ${CX - RX} ${CY} A ${RX} ${RY} 0 0 0 ${CX + RX} ${CY}`}
          fill="none"
          stroke="#5b6cff"
          strokeWidth="7"
          strokeLinecap="round"
          filter="url(#cam-glow)"
        />
        {/* 垂直アーク (紫) */}
        <path
          d={`M ${ARC_P0.x} ${ARC_P0.y} Q ${ARC_P1.x} ${ARC_P1.y} ${ARC_P2.x} ${ARC_P2.y}`}
          fill="none"
          stroke="#8a5cf6"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.95"
          filter="url(#cam-glow)"
        />

        {/* 垂直の玉 (紫) */}
        <circle
          cx={arc.x}
          cy={arc.y}
          r="10"
          fill="#8a5cf6"
          stroke="#c4b1ff"
          strokeWidth="2"
          filter="url(#cam-glow)"
          style={{ cursor: disabled ? "default" : "grab", pointerEvents: "auto" }}
          onPointerDown={begin("arc")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        {/* 回転の玉 (青)。奥にいる時は少し沈める */}
        <circle
          cx={ring.x}
          cy={ring.y}
          r="11"
          fill="#4b5df0"
          stroke="#aab4ff"
          strokeWidth="2"
          opacity={ballInFront ? 1 : 0.55}
          filter="url(#cam-glow)"
          style={{ cursor: disabled ? "default" : "grab", pointerEvents: "auto" }}
          onPointerDown={begin("ring")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      </svg>

      {/* 右上: その角度から見た擬似プレビュー */}
      <div
        className="pointer-events-none absolute right-2 top-2 flex h-[46px] w-[64px] items-center justify-center overflow-hidden rounded-md border border-white/20 bg-black/70"
        style={{ perspective: 240 }}
      >
        <img
          src={src}
          alt=""
          className="h-[38px] w-auto max-w-[54px] rounded-[2px] object-cover"
          style={{
            transform: `rotateY(${-normalizeCameraRotate(rotate)}deg) rotateX(${clampCameraVertical(vertical) * 0.45}deg)`,
            boxShadow: "0 0 0 1px rgba(255,255,255,0.18)",
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}

export default CameraOrbitWidget;
