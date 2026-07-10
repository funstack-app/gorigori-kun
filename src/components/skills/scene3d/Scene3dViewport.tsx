/**
 * scene3d ビューポート (React Three Fiber)
 *
 * - エンティティは床面(y=0)上をポインタドラッグで移動(スナップ0.1m)
 * - カメラ軌道は evaluateCamera のサンプリングで可視化(評価器と表示のずれをなくす)
 * - 再生中/カメラビュー中は evaluateCamera がビューカメラを駆動する
 *   (プレビューと書き出しが同じ評価器を通る = 決定性の担保)
 */

import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Line, OrbitControls } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import type { PerspectiveCamera as ThreePerspectiveCamera, Ray } from "three";

import { evaluateCamera, resolveLookAt } from "../../../lib/scene3d/evaluateScene";
import { SCENE_FPS } from "../../../lib/scene3d/types";
import type { SceneEntity, Vec3 } from "../../../lib/scene3d/types";
import { useScene3d } from "../../../lib/store/scene3d";

/** ポインタのレイと床面(y=0)の交点。交差しない場合は null */
function rayToFloor(ray: Ray): Vec3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = -ray.origin.y / ray.direction.y;
  if (t < 0) return null;
  const x = ray.origin.x + ray.direction.x * t;
  const z = ray.origin.z + ray.direction.z * t;
  const snap = (v: number) => Math.round(v * 10) / 10;
  return [snap(x), 0, snap(z)];
}

function EntityMesh({ entity }: { entity: SceneEntity }) {
  const selectEntity = useScene3d((s) => s.selectEntity);
  const moveEntity = useScene3d((s) => s.moveEntity);
  const setDragging = useScene3d((s) => s.setDragging);
  const selected = useScene3d((s) => s.selectedEntityId === entity.id);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === entity.id);

  const color = selected ? "#f59e0b" : "#d4d4d8";

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    selectEntity(entity.id);
    setDragging(entity.id);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    const p = rayToFloor(e.ray);
    if (p) moveEntity(entity.id, p);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <group
      position={entity.position}
      rotation={[0, entity.rotationY, 0]}
      scale={entity.scale}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {entity.kind === "mannequin" && (
        <>
          {/* 胴体 + 頭の簡易マネキン(身長約1.65m)。Phase 1 でリグ付きGLBに差し替える */}
          <mesh position={[0, 0.8, 0]} castShadow>
            <capsuleGeometry args={[0.22, 0.85, 8, 16]} />
            <meshStandardMaterial color={color} />
          </mesh>
          <mesh position={[0, 1.5, 0]} castShadow>
            <sphereGeometry args={[0.14, 24, 16]} />
            <meshStandardMaterial color={color} />
          </mesh>
          {/* 向きが分かる鼻先マーカー */}
          <mesh position={[0, 1.5, 0.14]}>
            <coneGeometry args={[0.04, 0.1, 8]} />
            <meshStandardMaterial color={selected ? "#fbbf24" : "#a1a1aa"} />
          </mesh>
        </>
      )}
      {entity.kind === "sphere" && (
        <mesh position={[0, 0.5, 0]} castShadow>
          <sphereGeometry args={[0.5, 32, 24]} />
          <meshStandardMaterial color={color} />
        </mesh>
      )}
      {entity.kind === "box" && (
        <mesh position={[0, 0.4, 0]} castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          <meshStandardMaterial color={color} />
        </mesh>
      )}
    </group>
  );
}

/** カメラ軌道の可視化。evaluateCamera を12分割サンプリングして線にする */
function CameraPathLine() {
  const project = useScene3d((s) => s.project);

  const points = useMemo(() => {
    const pts: Vec3[] = [];
    const samples = 24;
    for (let i = 0; i <= samples; i++) {
      const frame = Math.round(((project.durationFrames - 1) * i) / samples);
      pts.push(evaluateCamera(project, frame).position);
    }
    return pts;
  }, [project]);

  const lookAt = useMemo(() => resolveLookAt(project), [project]);
  const start = points[0];
  const end = points[points.length - 1];

  return (
    <>
      <Line points={points} color="#38bdf8" lineWidth={2} dashed={false} />
      {/* 開始点(緑)・終了点(赤)のマーカー */}
      <mesh position={start}>
        <sphereGeometry args={[0.08, 16, 12]} />
        <meshBasicMaterial color="#4ade80" />
      </mesh>
      <mesh position={end}>
        <sphereGeometry args={[0.08, 16, 12]} />
        <meshBasicMaterial color="#f87171" />
      </mesh>
      {/* 注視点マーカー */}
      <mesh position={lookAt}>
        <sphereGeometry args={[0.04, 12, 8]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>
    </>
  );
}

/**
 * 再生・カメラビューの駆動。再生中はフレームを進め、
 * evaluateCamera の姿勢をビューカメラへ反映する
 */
function CameraRig() {
  const invalidateRef = useRef(0);
  const { camera } = useThree();

  useFrame((_, delta) => {
    const st = useScene3d.getState();
    if (st.playing) {
      const next = st.currentFrame + delta * SCENE_FPS;
      st.setCurrentFrame(next >= st.project.durationFrames ? 0 : next);
    }
    if (st.playing || st.cameraView) {
      const pose = evaluateCamera(st.project, Math.floor(st.currentFrame));
      camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
      const persp = camera as ThreePerspectiveCamera;
      if (Math.abs(persp.fov - pose.fovDeg) > 0.01) {
        persp.fov = pose.fovDeg;
        persp.updateProjectionMatrix();
      }
    }
    invalidateRef.current++;
  });
  return null;
}

function ViewportControls() {
  const dragging = useScene3d((s) => s.draggingEntityId != null);
  const playing = useScene3d((s) => s.playing);
  const cameraView = useScene3d((s) => s.cameraView);
  return <OrbitControls enabled={!dragging && !playing && !cameraView} makeDefault />;
}

export function Scene3dViewport() {
  const entities = useScene3d((s) => s.project.entities);
  const selectEntity = useScene3d((s) => s.selectEntity);

  return (
    <Canvas
      shadows
      camera={{ position: [4, 3, 6], fov: 50 }}
      style={{ background: "#0a0a0a" }}
      onPointerMissed={() => selectEntity(null)}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
      <Grid
        args={[30, 30]}
        cellColor="#1f2937"
        sectionColor="#334155"
        fadeDistance={25}
        position={[0, 0, 0]}
      />
      {/* 影受けの床 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <shadowMaterial opacity={0.3} />
      </mesh>
      {entities.map((e) => (
        <EntityMesh key={e.id} entity={e} />
      ))}
      <CameraPathLine />
      <CameraRig />
      <ViewportControls />
    </Canvas>
  );
}
