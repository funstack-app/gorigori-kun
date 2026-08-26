import { convertFileSrc } from "@tauri-apps/api/core";
import { ContactShadows, Grid } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SRGBColorSpace, TextureLoader, Vector3, type Texture } from "three";

export const WIDGET_BOARD_CENTER = [0, 1.02, 0] as const;
export const WIDGET_BOARD_SIZE = [1.72, 1.16, 0.04] as const;

type WidgetSceneProps = {
  imagePath: string;
  /** 0=引き、10=寄り。固定方向のままシーンカメラだけを前後する。 */
  closeup?: number;
  /** 値が変わった時だけ demand フレームを再描画するための署名。 */
  invalidateKey: string;
  variant: "camera" | "light";
  children?: ReactNode;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function CameraDolly({ closeup }: { closeup: number }) {
  const { camera, invalidate } = useThree();

  useEffect(() => {
    const target = new Vector3(...WIDGET_BOARD_CENTER);
    const direction = new Vector3(4.6, 3.35, 5.4).sub(target).normalize();
    const distance = 7.4 - (clamp(closeup, 0, 10) / 10) * 2.7;
    camera.position.copy(target.clone().addScaledVector(direction, distance));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, closeup, invalidate]);

  return null;
}

function InvalidateOnChange({ signature }: { signature: string }) {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    invalidate();
  }, [invalidate, signature]);

  return null;
}

function ImageBoard({ imagePath }: { imagePath: string }) {
  const invalidate = useThree((state) => state.invalidate);
  const [texture, setTexture] = useState<Texture | null>(null);
  const source = useMemo(() => {
    if (!imagePath) return "";
    try {
      return convertFileSrc(imagePath);
    } catch {
      return imagePath;
    }
  }, [imagePath]);

  useEffect(() => {
    let active = true;
    let loadedTexture: Texture | null = null;
    setTexture(null);
    invalidate();

    if (!source) return undefined;

    new TextureLoader().load(
      source,
      (nextTexture) => {
        loadedTexture = nextTexture;
        if (!active) {
          nextTexture.dispose();
          return;
        }
        nextTexture.colorSpace = SRGBColorSpace;
        nextTexture.needsUpdate = true;
        setTexture(nextTexture);
        invalidate();
      },
      undefined,
      () => {
        if (!active) return;
        setTexture(null);
        invalidate();
      },
    );

    return () => {
      active = false;
      loadedTexture?.dispose();
    };
  }, [invalidate, source]);

  return (
    <mesh position={WIDGET_BOARD_CENTER} castShadow receiveShadow>
      <boxGeometry args={WIDGET_BOARD_SIZE} />
      <meshStandardMaterial attach="material-0" color="#51515c" roughness={0.72} />
      <meshStandardMaterial attach="material-1" color="#51515c" roughness={0.72} />
      <meshStandardMaterial attach="material-2" color="#666673" roughness={0.68} />
      <meshStandardMaterial attach="material-3" color="#414149" roughness={0.78} />
      <meshStandardMaterial
        attach="material-4"
        color={texture ? "#ffffff" : "#747480"}
        map={texture}
        roughness={0.62}
        metalness={0.02}
      />
      <meshStandardMaterial attach="material-5" color="#34343c" roughness={0.8} />
    </mesh>
  );
}

/** カメラ・ライト両ウィジェットで共有する、小型のソリッド3D舞台。 */
export function WidgetScene({
  imagePath,
  closeup = 5,
  invalidateKey,
  variant,
  children,
}: WidgetSceneProps) {
  const isCamera = variant === "camera";

  return (
    <Canvas
      shadows
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: [4.6, 3.35, 5.4], fov: 42, near: 0.1, far: 40 }}
      gl={{ antialias: true, alpha: false }}
      style={{ width: "100%", height: "100%" }}
    >
      <color attach="background" args={["#0d0d12"]} />
      <CameraDolly closeup={closeup} />
      <InvalidateOnChange signature={invalidateKey} />

      <ambientLight intensity={isCamera ? 0.34 : 0.12} />
      <hemisphereLight
        args={[0xb8c2ff, 0x171720, isCamera ? 0.62 : 0.28]}
        position={[0, 5, 0]}
      />
      {isCamera && (
        <>
          <directionalLight
            position={[3.6, 5.2, 4.2]}
            color="#f2efff"
            intensity={2.3}
            castShadow
            shadow-mapSize-width={512}
            shadow-mapSize-height={512}
            shadow-bias={-0.0004}
          />
          <directionalLight position={[-3, 2.8, 2]} color="#7183ff" intensity={0.85} />
        </>
      )}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.006, 0]} receiveShadow>
        <planeGeometry args={[18, 18]} />
        <meshStandardMaterial color="#111119" roughness={1} metalness={0} />
      </mesh>
      <Grid
        args={[12, 12]}
        position={[0, 0.004, 0]}
        cellSize={0.32}
        cellThickness={0.55}
        cellColor="#2a2a3a"
        sectionSize={1.6}
        sectionThickness={0.8}
        sectionColor="#35354a"
        fadeDistance={7.5}
        fadeStrength={1.25}
        infiniteGrid
      />

      <ImageBoard imagePath={imagePath} />
      <ContactShadows
        position={[0, 0.006, 0]}
        scale={7}
        opacity={0.58}
        blur={1.55}
        far={4.5}
        frames={1}
        color="#000000"
      />
      {children}
    </Canvas>
  );
}

export default WidgetScene;
