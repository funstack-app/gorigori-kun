/**
 * scene3d ビューポート (React Three Fiber)
 *
 * - エンティティは床面(y=0)上をポインタドラッグで移動(スナップ0.1m)
 * - カメラ軌道は evaluateCamera のサンプリングで可視化(評価器と表示のずれをなくす)
 * - 再生中/カメラビュー中は evaluateCamera がビューカメラを駆動する
 *   (プレビューと書き出しが同じ評価器を通る = 決定性の担保)
 */

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Line, OrbitControls } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera, Vector2, Vector3 } from "three";
import type { Group, PerspectiveCamera as ThreePerspectiveCamera, Ray } from "three";

import { scene3d as scene3dIpc } from "../../../lib/ipc";
import {
  evaluateCamera,
  evaluateShotCamera,
  resolveLookAt,
  totalDurationFrames,
} from "../../../lib/scene3d/evaluateScene";
import { SCENE_FPS } from "../../../lib/scene3d/types";
import type { SceneAspectRatio, SceneEntity, Vec3 } from "../../../lib/scene3d/types";
import { getSelectedShot, useScene3d } from "../../../lib/store/scene3d";

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

/**
 * デッサン人形風マネキン(身長約1.7m、プリミティブ構成)。
 * Phase 1 でリグ付きGLB(歩行等のモーション対応)に差し替える。
 * 前提: +Z が正面(足先・鼻の向きで分かるようにする)
 */
function Mannequin({ color, selected }: { color: string; selected: boolean }) {
  const jointColor = selected ? "#e8b34a" : "#b9bbbf";
  const mat = <meshStandardMaterial color={color} roughness={0.65} />;
  const jointMat = <meshStandardMaterial color={jointColor} roughness={0.65} />;

  return (
    <group>
      {/* 頭・首 */}
      <mesh position={[0, 1.585, 0]} castShadow>
        <sphereGeometry args={[0.115, 24, 18]} />
        {mat}
      </mesh>
      <mesh position={[0, 1.585, 0.1]} castShadow>
        {/* 鼻(正面マーカー兼) */}
        <coneGeometry args={[0.025, 0.06, 10]} />
        {jointMat}
      </mesh>
      <mesh position={[0, 1.46, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.05, 0.08, 12]} />
        {mat}
      </mesh>
      {/* 胸(肩に向かってやや広がる) */}
      <mesh position={[0, 1.25, 0]} castShadow>
        <capsuleGeometry args={[0.155, 0.22, 8, 16]} />
        {mat}
      </mesh>
      {/* 腹〜腰 */}
      <mesh position={[0, 1.02, 0]} castShadow>
        <sphereGeometry args={[0.13, 20, 14]} />
        {jointMat}
      </mesh>
      <mesh position={[0, 0.92, 0]} castShadow>
        <capsuleGeometry args={[0.135, 0.08, 8, 16]} />
        {mat}
      </mesh>
      {/* 腕(左右対称): 上腕→肘→前腕→手。自然に少し開いた立ち姿 */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.215, 1.36, 0]} rotation={[0, 0, side * -0.12]}>
          {/* 肩球 */}
          <mesh castShadow>
            <sphereGeometry args={[0.06, 16, 12]} />
            {jointMat}
          </mesh>
          {/* 上腕 */}
          <mesh position={[0, -0.16, 0]} castShadow>
            <capsuleGeometry args={[0.048, 0.2, 6, 12]} />
            {mat}
          </mesh>
          {/* 肘 */}
          <mesh position={[0, -0.31, 0]} castShadow>
            <sphereGeometry args={[0.045, 14, 10]} />
            {jointMat}
          </mesh>
          {/* 前腕(わずかに前へ) */}
          <group position={[0, -0.31, 0]} rotation={[-0.08, 0, 0]}>
            <mesh position={[0, -0.15, 0]} castShadow>
              <capsuleGeometry args={[0.04, 0.18, 6, 12]} />
              {mat}
            </mesh>
            {/* 手 */}
            <mesh position={[0, -0.29, 0.01]} castShadow>
              <sphereGeometry args={[0.05, 14, 10]} />
              {mat}
            </mesh>
          </group>
        </group>
      ))}
      {/* 脚(左右対称): 腿→膝→すね→足 */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.09, 0.84, 0]}>
          <mesh position={[0, -0.2, 0]} castShadow>
            <capsuleGeometry args={[0.068, 0.26, 6, 12]} />
            {mat}
          </mesh>
          {/* 膝 */}
          <mesh position={[0, -0.4, 0]} castShadow>
            <sphereGeometry args={[0.06, 14, 10]} />
            {jointMat}
          </mesh>
          <mesh position={[0, -0.6, 0]} castShadow>
            <capsuleGeometry args={[0.052, 0.24, 6, 12]} />
            {mat}
          </mesh>
          {/* 足(つま先が+Z=正面) */}
          <mesh position={[0, -0.795, 0.05]} castShadow>
            <boxGeometry args={[0.09, 0.06, 0.24]} />
            {mat}
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------- プロシージャル建築(軽量パラメトリック形状) ------------------------- */

/** 壁: 3m幅 x 2.6m高。scale と rotationY で長さ・向きを作る */
function Wall({ color }: { color: string }) {
  return (
    <mesh position={[0, 1.3, 0]} castShadow receiveShadow>
      <boxGeometry args={[3, 2.6, 0.15]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
}

function Column({ color }: { color: string }) {
  return (
    <mesh position={[0, 1.5, 0]} castShadow>
      <cylinderGeometry args={[0.22, 0.26, 3, 16]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
}

/** 階段: 8段(1段 0.18m高 x 0.28m奥行 x 1.2m幅)。+Z に向かって上る */
function Stairs({ color }: { color: string }) {
  const steps = 8;
  return (
    <group>
      {Array.from({ length: steps }, (_, i) => (
        <mesh key={i} position={[0, i * 0.18 + 0.09, i * 0.28]} castShadow receiveShadow>
          <boxGeometry args={[1.2, 0.18, 0.28]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** ビル: 階数パラメータから躯体+窓を生成(1階=3m)。窓は前後面に列挙 */
function Building({ color, floors }: { color: string; floors: number }) {
  const w = 5;
  const d = 4;
  const floorH = 3;
  const h = floors * floorH;
  const winCols = 4;
  const windows: { x: number; y: number; z: number }[] = [];
  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < winCols; c++) {
      const x = (c - (winCols - 1) / 2) * (w / winCols);
      const y = f * floorH + floorH * 0.55;
      windows.push({ x, y, z: d / 2 + 0.02 });
      windows.push({ x, y, z: -d / 2 - 0.02 });
    }
  }
  return (
    <group>
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {/* 屋上の立ち上がり(シルエットの手がかり) */}
      <mesh position={[0, h + 0.15, 0]} castShadow>
        <boxGeometry args={[w * 0.98, 0.3, d * 0.98]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {windows.map((win, i) => (
        <mesh key={i} position={[win.x, win.y, win.z]}>
          <boxGeometry args={[0.7, 1.1, 0.02]} />
          <meshStandardMaterial color="#3a3c40" roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

function EntityMesh({ entity }: { entity: SceneEntity }) {
  const controls = useThree((state) => state.controls);
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

  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // 注視: オービットの中心を対象へ移す(Blenderの視点迷子を構造的に消す)
    const c = controls as unknown as { target: Vector3; update: () => void } | null;
    if (!c) return;
    const h = entity.kind === "mannequin" ? 1.1 : entity.kind === "building" ? 3 : 0.6;
    c.target.set(entity.position[0], entity.position[1] + h * entity.scale, entity.position[2]);
    c.update();
  };

  return (
    <group
      position={entity.position}
      rotation={[0, entity.rotationY, 0]}
      scale={entity.scale}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {entity.kind === "mannequin" && <Mannequin color={color} selected={selected} />}
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
      {entity.kind === "wall" && <Wall color={color} />}
      {entity.kind === "column" && <Column color={color} />}
      {entity.kind === "stairs" && <Stairs color={color} />}
      {entity.kind === "building" && (
        <Building color={color} floors={entity.params?.floors ?? 3} />
      )}
    </group>
  );
}

const EXPORT_RESOLUTION: Record<SceneAspectRatio, [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [960, 960],
};

/**
 * モーションガイド書き出し。exportRequest が増えたら、
 * evaluateCamera で1フレームずつ描画 → PNG → Rust(ffmpeg) へ渡す。
 * 補助表示(軌道線・グリッド)は exporting 中に非表示化してから開始する。
 */
function ExportDriver() {
  const { gl, scene } = useThree();
  const exportRequest = useScene3d((s) => s.exportRequest);

  useEffect(() => {
    if (exportRequest === 0) return;
    let cancelled = false;

    (async () => {
      const st = useScene3d.getState();
      const project = st.project;
      const total = totalDurationFrames(project);
      st.setExportStatus({ phase: "rendering", done: 0, total });

      // React が補助表示の非表示を反映するのを待つ(2フレーム)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const [w, h] = EXPORT_RESOLUTION[project.aspectRatio];
      const prevSize = new Vector2();
      gl.getSize(prevSize);
      const prevRatio = gl.getPixelRatio();

      const cam = new PerspectiveCamera(50, w / h, 0.1, 200);

      try {
        const exportDir = await scene3dIpc.exportBegin();
        gl.setPixelRatio(1);
        gl.setSize(w, h, false);

        for (let f = 0; f < total; f++) {
          if (cancelled) return;
          const pose = evaluateCamera(project, f);
          cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
          cam.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
          cam.fov = pose.fovDeg;
          cam.updateProjectionMatrix();
          gl.render(scene, cam);

          const blob = await new Promise<Blob | null>((resolve) =>
            gl.domElement.toBlob(resolve, "image/png"),
          );
          if (!blob) throw new Error("フレームのPNG変換に失敗しました");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await scene3dIpc.writeFrame(exportDir, f, bytes);
          useScene3d.getState().setExportStatus({ phase: "rendering", done: f + 1, total });
        }

        useScene3d.getState().setExportStatus({ phase: "encoding" });
        try {
          const [mp4Path, firstFramePath] = await scene3dIpc.encode(exportDir, project.fps);
          useScene3d.getState().setExportStatus({
            phase: "done",
            mp4Path,
            firstFramePath,
            framesDir: exportDir,
          });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("ffmpeg-not-found")) {
            // PNG連番までは成功。ffmpeg 未導入だけを伝える
            useScene3d.getState().setExportStatus({
              phase: "done",
              mp4Path: null,
              firstFramePath: null,
              framesDir: exportDir,
            });
          } else {
            throw e;
          }
        }
      } catch (e) {
        useScene3d.getState().setExportStatus({ phase: "error", message: String(e) });
      } finally {
        gl.setPixelRatio(prevRatio);
        gl.setSize(prevSize.x, prevSize.y, false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [exportRequest, gl, scene]);

  return null;
}

/** 選択中カットのカメラ軌道の可視化。evaluateShotCamera のサンプリングで線にする */
function CameraPathLine() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);

  const shot = useMemo(
    () => getSelectedShot({ project, selectedShotId }),
    [project, selectedShotId],
  );

  const points = useMemo(() => {
    const pts: Vec3[] = [];
    const samples = 24;
    for (let i = 0; i <= samples; i++) {
      const frame = Math.round(((shot.durationFrames - 1) * i) / samples);
      pts.push(evaluateShotCamera(project, shot, frame).position);
    }
    return pts;
  }, [project, shot]);

  const lookAt = useMemo(() => resolveLookAt(project, shot), [project, shot]);
  const end = points[points.length - 1];

  return (
    <>
      <Line points={points} color="#ec4899" lineWidth={2} dashed={false} />
      {/* 終了点(赤)=カメラが止まる場所。始点はカメラマークが示す */}
      <mesh position={end}>
        <sphereGeometry args={[0.08, 16, 12]} />
        <meshBasicMaterial color="#f87171" />
      </mesh>
      {/* 注視点マーカー */}
      <mesh position={lookAt}>
        <sphereGeometry args={[0.04, 12, 8]} />
        <meshBasicMaterial color="#ec4899" />
      </mesh>
    </>
  );
}

/**
 * カメラ本体の可視化(編集ビュー専用)。
 * 選択カットの「始点」にカメラの形 + 視野の四角錐を置く。
 * 始点=カメラマーク / 赤点=カメラが止まる場所、という約束(STΛCK指示)
 */
function CameraIndicator() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const groupRef = useRef<Group>(null);

  // 始点=カメラマーク(このカットの撮影開始位置)。終点は赤点(カメラが止まる場所)
  const shot = getSelectedShot({ project, selectedShotId });
  const pose = evaluateShotCamera(project, shot, 0);
  const ar = project.aspectRatio === "9:16" ? 9 / 16 : project.aspectRatio === "1:1" ? 1 : 16 / 9;

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(pose.position[0], pose.position[1], pose.position[2]);
    g.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  });

  // 視野の四角錐(距離1.1mの位置に画角どおりの枠)
  const d = 1.1;
  const h = 2 * Math.tan(((pose.fovDeg / 2) * Math.PI) / 180) * d;
  const w = h * ar;
  const c1: Vec3 = [-w / 2, h / 2, d];
  const c2: Vec3 = [w / 2, h / 2, d];
  const c3: Vec3 = [w / 2, -h / 2, d];
  const c4: Vec3 = [-w / 2, -h / 2, d];
  const zero: Vec3 = [0, 0, 0];

  return (
    <group ref={groupRef}>
      {/* カメラボディ + レンズ */}
      <mesh position={[0, 0, -0.12]}>
        <boxGeometry args={[0.24, 0.18, 0.24]} />
        <meshStandardMaterial color="#2c2e33" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.04]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.07, 0.09, 0.12, 16]} />
        <meshStandardMaterial color="#1c1e22" roughness={0.35} />
      </mesh>
      {/* 視野の四角錐 */}
      <Line points={[zero, c1]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
      <Line points={[zero, c2]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
      <Line points={[zero, c3]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
      <Line points={[zero, c4]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
      <Line points={[c1, c2, c3, c4, c1]} color="#f9a8d4" lineWidth={1.5} />
    </group>
  );
}

/**
 * 再生・カメラビューの駆動。再生中はフレームを進め、
 * evaluateCamera の姿勢をビューカメラへ反映する
 */
function CameraRig({ mode, primary }: { mode: "editor" | "camera"; primary: boolean }) {
  const invalidateRef = useRef(0);
  const { camera } = useThree();

  useFrame((_, delta) => {
    const st = useScene3d.getState();
    // フレームを進めるのは primary ペインだけ(複数ペインでの二重進行を防ぐ)
    if (primary && st.playing) {
      const total = totalDurationFrames(st.project);
      const next = st.currentFrame + delta * SCENE_FPS;
      st.setCurrentFrame(next >= total ? 0 : next);
    }
    // camera ペインは常に撮影カメラ。editor ペインは分割中は自由視点のまま
    const drivePose =
      mode === "camera" || ((st.playing || st.cameraView) && !st.splitView);
    if (drivePose) {
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

/** 視点プリセット(正面/横/俯瞰/斜め/全体)。UIボタン(Workspace側)から呼ばれる */
export type ViewPresetType = "front" | "side" | "top" | "iso" | "fit";
let viewPresetListener: ((t: ViewPresetType) => void) | null = null;
export function requestViewPreset(t: ViewPresetType): void {
  viewPresetListener?.(t);
}

function ViewPresetController() {
  const { camera, controls } = useThree();
  useEffect(() => {
    viewPresetListener = (t) => {
      const c = controls as unknown as { target: Vector3; update: () => void } | null;
      const target = c?.target ?? new Vector3(0, 1, 0);
      const dist = t === "fit" ? 9 : Math.max(3, camera.position.distanceTo(target));
      if (t === "fit") target.set(0, 1, 0);
      switch (t) {
        case "front":
          camera.position.set(target.x, target.y + dist * 0.12, target.z + dist);
          break;
        case "side":
          camera.position.set(target.x + dist, target.y + dist * 0.12, target.z);
          break;
        case "top":
          camera.position.set(target.x, target.y + dist, target.z + 0.01);
          break;
        case "iso":
        case "fit":
          camera.position.set(target.x + dist * 0.6, target.y + dist * 0.45, target.z + dist * 0.66);
          break;
      }
      camera.lookAt(target);
      c?.update();
    };
    return () => {
      viewPresetListener = null;
    };
  }, [camera, controls]);
  return null;
}

function ViewportControls() {
  const dragging = useScene3d((s) => s.draggingEntityId != null);
  const playing = useScene3d((s) => s.playing);
  const cameraView = useScene3d((s) => s.cameraView);
  const splitView = useScene3d((s) => s.splitView);
  return (
    <OrbitControls
      enabled={!dragging && (splitView || (!playing && !cameraView))}
      makeDefault
      minDistance={0.8}
      maxDistance={45}
    />
  );
}

export function Scene3dViewport({
  mode = "editor",
  primary = false,
}: {
  mode?: "editor" | "camera";
  primary?: boolean;
}) {
  const entities = useScene3d((s) => s.project.entities);
  const selectEntity = useScene3d((s) => s.selectEntity);
  const exporting = useScene3d(
    (s) => s.exportStatus.phase === "rendering" || s.exportStatus.phase === "encoding",
  );
  const isCameraPane = mode === "camera";

  return (
    <Canvas
      shadows
      camera={{ position: [4, 3, 6], fov: 50 }}
      // toBlob でフレームを回収するため描画バッファを保持する
      gl={{ preserveDrawingBuffer: true }}
      style={isCameraPane ? { pointerEvents: "none" } : undefined}
      onPointerMissed={() => selectEntity(null)}
    >
      {/* グレースタジオ(クレイ模型風)。霧は視認性を殺すため使わない */}
      <color attach="background" args={["#75777b"]} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[5, 8, 5]} intensity={1.1} castShadow />
      {/* 書き出し中とカメラペインでは補助表示を消す(書き出される画と一致させる) */}
      {!exporting && !isCameraPane && (
        <Grid
          args={[40, 40]}
          cellSize={0.5}
          sectionSize={2.5}
          cellThickness={0.7}
          sectionThickness={1.5}
          cellColor="#5b5d61"
          sectionColor="#3c3e42"
          fadeDistance={120}
          fadeStrength={0.6}
          position={[0, 0.001, 0]}
        />
      )}
      {/* グレーの床(編集時・書き出し時共通。Seedanceの空間手がかりにもなる) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#818387" />
      </mesh>
      {entities.map((e) => (
        <EntityMesh key={e.id} entity={e} />
      ))}
      {!exporting && !isCameraPane && <CameraPathLine />}
      {!exporting && !isCameraPane && <CameraIndicator />}
      <CameraRig mode={mode} primary={primary} />
      {!isCameraPane && <ViewportControls />}
      {!isCameraPane && <ViewPresetController />}
      {primary && <ExportDriver />}
      {!exporting && !isCameraPane && (
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport
            axisColors={["#e88b8b", "#8bc78b", "#8ba7e8"]}
            labelColor="#ffffff"
          />
        </GizmoHelper>
      )}
    </Canvas>
  );
}
