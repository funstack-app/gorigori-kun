import { convertFileSrc } from "@tauri-apps/api/core";
import type { ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MathUtils } from "three";

import { clampCameraVertical, normalizeCameraRotate } from "./editToolLogic";
import { WIDGET_BOARD_CENTER, WidgetScene } from "./widget3d/WidgetScene";

type CameraChange = {
  rotate: number;
  vertical: number;
  /** リセット時だけ渡す。既存の受け側は無視しても互換性を保てる。 */
  closeup?: number;
};

type Props = {
  imagePath: string;
  rotate: number;
  vertical: number;
  closeup?: number;
  disabled?: boolean;
  onChange: (value: CameraChange) => void;
};

type DragKind = "ring" | "meridian" | "orbit";
type DragStart = {
  kind: DragKind;
  x: number;
  y: number;
  rotate: number;
  vertical: number;
};

const RING_RADIUS = 1.66;
const RING_HEIGHT = 0.09;
const MERIDIAN_RADIUS = 1.48;

function CameraGizmo({
  rotate,
  vertical,
  disabled,
  onHandlePointerDown,
}: {
  rotate: number;
  vertical: number;
  disabled: boolean;
  onHandlePointerDown: (kind: "ring" | "meridian", event: PointerEvent) => void;
}) {
  const rotateRad = MathUtils.degToRad(normalizeCameraRotate(rotate));
  const verticalRad = MathUtils.degToRad(clampCameraVertical(vertical));
  const ringBall: [number, number, number] = [
    Math.sin(rotateRad) * RING_RADIUS,
    RING_HEIGHT + 0.035,
    Math.cos(rotateRad) * RING_RADIUS,
  ];
  const meridianBall: [number, number, number] = [
    0,
    WIDGET_BOARD_CENTER[1] + Math.sin(verticalRad) * MERIDIAN_RADIUS,
    -Math.cos(verticalRad) * MERIDIAN_RADIUS,
  ];

  const begin = (kind: "ring" | "meridian") => (event: ThreeEvent<PointerEvent>) => {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    onHandlePointerDown(kind, event.nativeEvent);
  };

  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, RING_HEIGHT, 0]}>
        <torusGeometry args={[RING_RADIUS, 0.055, 16, 96]} />
        <meshStandardMaterial
          color="#4b5df0"
          roughness={0.34}
          metalness={0.16}
          emissive="#10194e"
          emissiveIntensity={0.45}
        />
      </mesh>

      <group position={[0, WIDGET_BOARD_CENTER[1], 0]} rotation={[0, Math.PI / 2, 0]}>
        <mesh rotation={[0, 0, -Math.PI / 4]}>
          <torusGeometry args={[MERIDIAN_RADIUS, 0.052, 16, 80, Math.PI]} />
          <meshStandardMaterial
            color="#8a5cf6"
            roughness={0.36}
            metalness={0.13}
            emissive="#2d145d"
            emissiveIntensity={0.42}
          />
        </mesh>
      </group>

      <mesh position={ringBall} onPointerDown={begin("ring")} castShadow>
        <sphereGeometry args={[0.16, 28, 20]} />
        <meshStandardMaterial
          color="#5265ff"
          roughness={0.24}
          metalness={0.1}
          emissive="#15257a"
          emissiveIntensity={0.4}
        />
      </mesh>
      <mesh position={meridianBall} onPointerDown={begin("meridian")} castShadow>
        <sphereGeometry args={[0.15, 28, 20]} />
        <meshStandardMaterial
          color="#9a70ff"
          roughness={0.24}
          metalness={0.1}
          emissive="#391474"
          emissiveIntensity={0.42}
        />
      </mesh>
    </group>
  );
}

/** 固定視点のソリッド3D上で、カメラの回転・高さ・寄りを操作する。 */
export function CameraOrbitWidget({
  imagePath,
  rotate,
  vertical,
  closeup = 5,
  disabled = false,
  onChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<DragStart | null>(null);
  const [dragging, setDragging] = useState<DragKind | null>(null);
  const src = useMemo(() => {
    try {
      return convertFileSrc(imagePath);
    } catch {
      return imagePath;
    }
  }, [imagePath]);

  const startDrag = (kind: DragKind, event: PointerEvent | ReactPointerEvent) => {
    if (disabled || event.button !== 0) return;
    hostRef.current?.setPointerCapture(event.pointerId);
    dragStart.current = {
      kind,
      x: event.clientX,
      y: event.clientY,
      rotate,
      vertical,
    };
    setDragging(kind);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    event.preventDefault();
    const dx = event.clientX - start.x;
    const dy = start.y - event.clientY;

    if (start.kind === "ring") {
      onChange({
        rotate: normalizeCameraRotate(start.rotate + dx * 1.2),
        vertical,
      });
      return;
    }
    if (start.kind === "meridian") {
      onChange({
        rotate,
        vertical: clampCameraVertical(start.vertical + dy * 0.75),
      });
      return;
    }
    onChange({
      rotate: normalizeCameraRotate(start.rotate + dx * 1.2),
      vertical: clampCameraVertical(start.vertical + dy * 0.75),
    });
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    if (hostRef.current?.hasPointerCapture(event.pointerId)) {
      hostRef.current.releasePointerCapture(event.pointerId);
    }
    dragStart.current = null;
    setDragging(null);
  };

  const previewScale = 0.72 + (Math.max(0, Math.min(10, closeup)) / 10) * 0.75;

  return (
    <div
      ref={hostRef}
      className="relative select-none overflow-hidden rounded-xl border border-white/10"
      style={{
        width: "100%",
        aspectRatio: "4 / 3",
        background: "#0d0d12",
        cursor: disabled ? "default" : dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDownCapture={(event) => {
        if ((event.target as Element).closest("button")) return;
        startDrag("orbit", event);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="presentation"
    >
      <div className="absolute inset-0">
        <WidgetScene
          imagePath={imagePath}
          closeup={closeup}
          invalidateKey={`${rotate}:${vertical}:${closeup}`}
          variant="camera"
        >
          <CameraGizmo
            rotate={rotate}
            vertical={vertical}
            disabled={disabled}
            onHandlePointerDown={(kind, event) => startDrag(kind, event)}
          />
        </WidgetScene>
      </div>

      <div
        className="pointer-events-none absolute right-2 top-2 z-10 flex h-[48px] w-[66px] items-center justify-center overflow-hidden rounded-md border border-white/20 bg-black"
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

      <button
        type="button"
        className="absolute bottom-2 right-2 z-20 grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-black/65 text-base font-bold text-white shadow-lg transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="カメラ位置をリセット"
        title="回転・高さ・寄りをリセット"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onChange({ rotate: 45, vertical: 0, closeup: 5 });
        }}
      >
        ↺
      </button>
    </div>
  );
}

export default CameraOrbitWidget;
