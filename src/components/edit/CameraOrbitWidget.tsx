import { convertFileSrc } from "@tauri-apps/api/core";
import { useRef, useState, type PointerEvent } from "react";

import { clampCameraVertical, normalizeCameraRotate } from "./editToolLogic";

/**
 * カメラ変更の 3D プレビュー (Magnific 本家準拠 / 2026-08-26 STΛCK指示で再調整)。
 *
 * - 真っ黒に近い背景 + ごく薄いグリッド。発光 (グロー) は使わない
 * - 水平の青リングと、それに直交する縦の紫アーク (子午線) のジャイロ構造
 * - 青い玉 = 回転、紫の玉 = 高さ。背景ドラッグで両方まとめてオービット
 * - 右上ミニプレビューは回転・高さ・寄り (ズーム) を全部反映する
 */

type Props = {
  imagePath: string;
  rotate: number;
  vertical: number;
  /** 寄り 0-10。ミニプレビューの拡大率に反映する。 */
  closeup?: number;
  disabled?: boolean;
  onChange: (value: { rotate: number; vertical: number }) => void;
};

const W = 260;
const H = 196;
const CX = 130;
const CY = 108;
/** 水平リング (床と平行な楕円)。 */
const RING_RX = 108;
const RING_RY = 38;
/** 縦アーク (子午線)。リングと同じ半径の縦楕円を少し傾けて見せる。 */
const MER_RX = 30;
const MER_RY = 92;
const MER_TILT = (-14 * Math.PI) / 180;

function ringPoint(rotate: number) {
  const rad = (normalizeCameraRotate(rotate) * Math.PI) / 180;
  return { x: CX + RING_RX * Math.sin(rad), y: CY + RING_RY * Math.cos(rad) };
}

/** 子午線上の点。φ=0 が手前下、φ=180° が真後ろ上。Magnific と同じく左へ膨らむ。 */
function meridianPoint(phi: number) {
  const x0 = -MER_RX * Math.sin(phi);
  const y0 = MER_RY * Math.cos(phi);
  return {
    x: CX + x0 * Math.cos(MER_TILT) - y0 * Math.sin(MER_TILT) * 0.22,
    y: CY + x0 * Math.sin(MER_TILT) + y0 * Math.cos(MER_TILT),
  };
}

/** 垂直 -30..90° → 子午線パラメータ。手前下 (10°) から真上 (180°) へ。 */
function verticalToPhi(vertical: number) {
  const t = (clampCameraVertical(vertical) + 30) / 120;
  return (0.12 + t * 0.88) * Math.PI;
}

function meridianPath() {
  const steps = 48;
  const points: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const phi = (0.06 + (index / steps) * 0.99) * Math.PI;
    const point = meridianPoint(phi);
    points.push(`${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
  }
  return points.join(" ");
}

const MERIDIAN_D = meridianPath();

type DragKind = "ring" | "arc" | "orbit";

export function CameraOrbitWidget({
  imagePath,
  rotate,
  vertical,
  closeup = 5,
  disabled = false,
  onChange,
}: Props) {
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const dragStart = useRef<{ x: number; y: number; rotate: number; vertical: number } | null>(
    null,
  );

  const ring = ringPoint(rotate);
  const arc = meridianPoint(verticalToPhi(vertical));

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
        (Math.atan2((local.x - CX) / RING_RX, (local.y - CY) / RING_RY) * 180) / Math.PI;
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
  const ballInFront = Math.cos((normalizeCameraRotate(rotate) * Math.PI) / 180) >= 0;
  const previewScale = 0.72 + (Math.max(0, Math.min(10, closeup)) / 10) * 0.75;

  return (
    <div
      className="relative select-none overflow-hidden rounded-xl border border-white/10"
      style={{
        width: "100%",
        aspectRatio: `${W} / ${H}`,
        background: "radial-gradient(130% 110% at 50% 8%, #201b3a 0%, #161226 48%, #0e0b1c 100%)",
        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={begin("orbit")}
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

      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        {/* リング奥半分 (暗め・プレーンの後ろ) */}
        <path
          d={`M ${CX - RING_RX} ${CY} A ${RING_RX} ${RING_RY} 0 0 1 ${CX + RING_RX} ${CY}`}
          fill="none"
          stroke="#3b46c9"
          strokeWidth="9"
          strokeLinecap="round"
        />
      </svg>

      {/* 床の接地影 */}
      <div
        className="pointer-events-none absolute left-1/2 top-[68%] h-[14px] w-[92px] -translate-x-1/2 rounded-[50%] bg-black/70 blur-[6px]"
      />

      {/* 立っている画像プレーン + 床への映り込み */}
      <div
        className="pointer-events-none absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2"
        style={{ perspective: 300 }}
      >
        <img
          src={src}
          alt=""
          className="block h-[62px] w-auto max-w-[92px] rounded-[2px] object-cover"
          style={{
            transform: "rotateY(-22deg) rotateX(2deg)",
            boxShadow: "0 8px 16px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.12)",
          }}
          draggable={false}
        />
        <div
          className="overflow-hidden"
          style={{
            height: 26,
            marginTop: 2,
            opacity: 0.2,
            maskImage: "linear-gradient(180deg, black 0%, transparent 90%)",
            WebkitMaskImage: "linear-gradient(180deg, black 0%, transparent 90%)",
          }}
        >
          <img
            src={src}
            alt=""
            className="block h-[62px] w-auto max-w-[92px] rounded-[2px] object-cover"
            style={{ transform: "rotateY(-22deg) scaleY(-1)" }}
            draggable={false}
          />
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" aria-hidden>
        {/* リング手前半分 (明るめ・プレーンの前) */}
        <path
          d={`M ${CX - RING_RX} ${CY} A ${RING_RX} ${RING_RY} 0 0 0 ${CX + RING_RX} ${CY}`}
          fill="none"
          stroke="#5563f2"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* 縦アーク (子午線・紫)。リングに直交する軸 */}
        <path
          d={MERIDIAN_D}
          fill="none"
          stroke="#8a5cf6"
          strokeWidth="8"
          strokeLinecap="round"
        />

        {/* 高さの玉 (紫) */}
        <circle
          cx={arc.x}
          cy={arc.y}
          r="13"
          fill="#9a70ff"
          stroke="#12101f"
          strokeWidth="3"
          style={{ cursor: disabled ? "default" : "grab", pointerEvents: "auto" }}
          onPointerDown={begin("arc")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        {/* 回転の玉 (青) */}
        <circle
          cx={ring.x}
          cy={ring.y}
          r="14"
          fill="#4b5df0"
          stroke="#12101f"
          strokeWidth="3"
          opacity={ballInFront ? 1 : 0.6}
          style={{ cursor: disabled ? "default" : "grab", pointerEvents: "auto" }}
          onPointerDown={begin("ring")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      </svg>

      {/* 右上: 回転・高さ・寄りを反映した擬似プレビュー */}
      <div
        className="pointer-events-none absolute right-2 top-2 flex h-[48px] w-[66px] items-center justify-center overflow-hidden rounded-md border border-white/20 bg-black"
        style={{ perspective: 240 }}
      >
        <img
          src={src}
          alt=""
          className="h-[40px] w-auto max-w-[58px] rounded-[2px] object-cover"
          style={{
            transform: `scale(${previewScale}) rotateY(${-normalizeCameraRotate(rotate)}deg) rotateX(${clampCameraVertical(vertical) * 0.45}deg)`,
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}

export default CameraOrbitWidget;
