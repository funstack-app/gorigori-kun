import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AdditiveBlending,
  DoubleSide,
  MathUtils,
  Object3D,
  Quaternion,
  SpotLight as ThreeSpotLight,
  Vector3,
} from "three";

import {
  snapLightAzimuth,
  snapLightElevation,
  type LightAzimuth,
  type LightElevation,
} from "./editToolLogic";
import { WIDGET_BOARD_CENTER, WidgetScene } from "./widget3d/WidgetScene";

type LightChange = {
  azimuth: LightAzimuth;
  elevation: LightElevation;
  /** リセット時だけ渡す。既存の受け側は無視しても互換性を保てる。 */
  intensity?: number;
  color?: string;
};

type Props = {
  imagePath: string;
  azimuth: LightAzimuth;
  elevation: LightElevation;
  intensity?: number;
  color?: string;
  disabled?: boolean;
  onChange: (value: LightChange) => void;
};

type DragStart = {
  x: number;
  y: number;
  azimuth: LightAzimuth;
  elevation: LightElevation;
};

const TARGET = new Vector3(...WIDGET_BOARD_CENTER);

function lightPosition(azimuth: number, elevation: number): Vector3 {
  const azimuthRad = MathUtils.degToRad(azimuth);
  // APIの5段を、床下へ潜らず見比べられる5段の球面位置へ写す。
  const visualPitch = elevation < 0 ? elevation * (24 / 90) : elevation * (75 / 90);
  const pitch = MathUtils.degToRad(visualPitch);
  const radius = 2.25;
  const horizontal = Math.cos(pitch) * radius;
  return new Vector3(
    Math.sin(azimuthRad) * horizontal,
    TARGET.y + Math.sin(pitch) * radius,
    Math.cos(azimuthRad) * horizontal,
  );
}

function LightRig({
  azimuth,
  elevation,
  intensity,
  color,
}: {
  azimuth: LightAzimuth;
  elevation: LightElevation;
  intensity: number;
  color: string;
}) {
  const { invalidate } = useThree();
  const spotRef = useRef<ThreeSpotLight>(null);
  const targetRef = useRef<Object3D>(null);
  const position = useMemo(() => lightPosition(azimuth, elevation), [azimuth, elevation]);
  const { distance, orientation, midpoint } = useMemo(() => {
    const direction = TARGET.clone().sub(position).normalize();
    return {
      distance: position.distanceTo(TARGET),
      orientation: new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), direction),
      midpoint: position.clone().add(TARGET).multiplyScalar(0.5),
    };
  }, [position]);
  const clampedIntensity = Math.max(1, Math.min(10, intensity));
  const beamOpacity = 0.045 + (clampedIntensity / 10) * 0.16;

  useEffect(() => {
    const spot = spotRef.current;
    const target = targetRef.current;
    if (!spot || !target) return;
    spot.target = target;
    target.updateMatrixWorld();
    spot.shadow.camera.near = 0.1;
    spot.shadow.camera.far = 8;
    spot.shadow.camera.updateProjectionMatrix();
    invalidate();
  }, [azimuth, color, elevation, clampedIntensity, invalidate]);

  return (
    <group>
      <object3D ref={targetRef} position={WIDGET_BOARD_CENTER} />
      <spotLight
        ref={spotRef}
        position={position}
        color={color}
        intensity={12 + clampedIntensity * 7.5}
        angle={0.49}
        penumbra={0.56}
        decay={1.25}
        distance={8}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-bias={-0.0005}
      />

      <group position={position} quaternion={orientation}>
        <mesh castShadow>
          <cylinderGeometry args={[0.13, 0.18, 0.34, 24]} />
          <meshStandardMaterial color="#55555f" roughness={0.48} metalness={0.5} />
        </mesh>
        <mesh position={[0, 0.25, 0]} rotation={[Math.PI, 0, 0]} castShadow>
          <coneGeometry args={[0.2, 0.24, 24]} />
          <meshStandardMaterial color="#3b3b43" roughness={0.55} metalness={0.42} />
        </mesh>
        <mesh position={[0, -0.18, 0]}>
          <cylinderGeometry args={[0.115, 0.115, 0.035, 24]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.75 + clampedIntensity * 0.08}
            roughness={0.25}
          />
        </mesh>
      </group>

      <mesh
        position={midpoint}
        quaternion={orientation}
        raycast={() => null}
        renderOrder={1}
      >
        <coneGeometry args={[0.72, distance, 40, 1, true]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={beamOpacity}
          blending={AdditiveBlending}
          depthWrite={false}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>

      <mesh position={position} raycast={() => null}>
        <sphereGeometry args={[0.23, 24, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.08} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** 固定視点のソリッド3D上で、8方位×5段のライト位置を操作する。 */
export function LightOrbitWidget({
  imagePath,
  azimuth,
  elevation,
  intensity = 5,
  color = "#ffffff",
  disabled = false,
  onChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<DragStart | null>(null);
  const [dragging, setDragging] = useState(false);

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || (event.target as Element).closest("button")) return;
    event.preventDefault();
    hostRef.current?.setPointerCapture(event.pointerId);
    dragStart.current = {
      x: event.clientX,
      y: event.clientY,
      azimuth,
      elevation,
    };
    setDragging(true);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    event.preventDefault();
    const dx = event.clientX - start.x;
    const dy = start.y - event.clientY;
    // dy は「上ドラッグで正」。上ドラッグ=ライトが上がる (2026-08-26 実機FB: 逆だった)
    onChange({
      azimuth: snapLightAzimuth(start.azimuth + dx * 1.15),
      elevation: snapLightElevation(start.elevation + dy * 1.05),
    });
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    if (hostRef.current?.hasPointerCapture(event.pointerId)) {
      hostRef.current.releasePointerCapture(event.pointerId);
    }
    dragStart.current = null;
    setDragging(false);
  };

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
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      role="presentation"
    >
      <div className="absolute inset-0">
        <WidgetScene
          imagePath={imagePath}
          invalidateKey={`${azimuth}:${elevation}:${intensity}:${color}`}
          variant="light"
        >
          <LightRig
            azimuth={azimuth}
            elevation={elevation}
            intensity={intensity}
            color={color}
          />
        </WidgetScene>
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-2 z-10 text-center text-[10px] font-bold text-neutral-400">
        ドラッグしてライトの位置を調整
      </p>
      <button
        type="button"
        className="absolute bottom-2 right-2 z-20 grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-black/65 text-base font-bold text-white shadow-lg transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="ライトをリセット"
        title="位置・強さ・色をリセット"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onChange({ azimuth: 0, elevation: 0, intensity: 5, color: "#ffffff" });
        }}
      >
        ↺
      </button>
    </div>
  );
}

export default LightOrbitWidget;
