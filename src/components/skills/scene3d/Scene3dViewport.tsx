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
import { AnimationMixer, PerspectiveCamera, Vector2, Vector3 } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Group, PerspectiveCamera as ThreePerspectiveCamera, Ray } from "three";

import { scene3d as scene3dIpc } from "../../../lib/ipc";
import { getImportedMotion } from "../../../lib/scene3d/motionLibrary";
import {
  evaluateCamera,
  evaluateEntityPose,
  evaluateShotCamera,
  getShotMove,
  resolveLookAt,
  totalDurationFrames,
} from "../../../lib/scene3d/evaluateScene";
import { SCENE_FPS } from "../../../lib/scene3d/types";
import { cameraColor } from "../../../lib/scene3d/types";
import type { SceneAspectRatio, SceneCamera, SceneEntity, Vec3 } from "../../../lib/scene3d/types";
import { getSelectedShot, useScene3d } from "../../../lib/store/scene3d";

/**
 * フレーム適用レジストリ: アニメーションする要素が「このフレームの姿勢にせよ」
 * という関数を登録する。プレビュー(useFrame)と書き出し(ExportDriver)の両方が
 * 同じ適用関数を呼ぶため、見たままが書き出される(決定性)
 */
const frameAppliers = new Set<(frame: number) => void>();
function applySceneFrame(frame: number): void {
  frameAppliers.forEach((fn) => fn(frame));
}

/** ポインタのレイと水平面(y=height)の交点。交差しない場合は null */
function rayToPlaneY(ray: Ray, y: number): Vec3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  return [
    ray.origin.x + ray.direction.x * t,
    y,
    ray.origin.z + ray.direction.z * t,
  ];
}

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
 * デッサン人形風マネキン(身長約1.7m、プリミティブ構成のリグ)。
 * 腕脚・胴のグループ参照を親(EntityMesh)へ渡し、歩行アニメーションで振る。
 * 前提: +Z が正面
 */
export type MannequinRig = {
  body: Group | null;
  arms: (Group | null)[];
  legs: (Group | null)[];
};

function Mannequin({
  color,
  selected,
  rig,
}: {
  color: string;
  selected: boolean;
  rig: React.MutableRefObject<MannequinRig>;
}) {
  const accent = selected ? "#e8b34a" : "#c6c8cc";
  const mat = <meshStandardMaterial color={color} roughness={0.6} />;
  const accentMat = <meshStandardMaterial color={accent} roughness={0.6} />;

  return (
    <group ref={(el) => (rig.current.body = el)}>
      {/* 頭(やや縦長) + 首 */}
      <mesh position={[0, 1.58, 0]} scale={[0.92, 1.08, 0.98]} castShadow>
        <sphereGeometry args={[0.105, 24, 18]} />
        {mat}
      </mesh>
      <mesh position={[0, 1.575, 0.095]} castShadow>
        {/* 鼻(正面の手がかり) */}
        <coneGeometry args={[0.02, 0.05, 10]} />
        {accentMat}
      </mesh>
      <mesh position={[0, 1.465, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.05, 0.09, 12]} />
        {mat}
      </mesh>

      {/* 胸郭: 肩幅があり前後は薄い */}
      <mesh position={[0, 1.27, 0]} scale={[1.25, 1, 0.62]} castShadow>
        <capsuleGeometry args={[0.16, 0.2, 8, 16]} />
        {mat}
      </mesh>
      {/* ウエスト(絞り) */}
      <mesh position={[0, 1.06, 0]} scale={[1, 1, 0.7]} castShadow>
        <cylinderGeometry args={[0.115, 0.13, 0.14, 16]} />
        {mat}
      </mesh>
      {/* 骨盤 */}
      <mesh position={[0, 0.93, 0]} scale={[1.15, 0.85, 0.75]} castShadow>
        <sphereGeometry args={[0.15, 20, 14]} />
        {mat}
      </mesh>

      {/* 腕(左右対称): 肩を支点に振る。上腕→前腕は先細り */}
      {[-1, 1].map((side, i) => (
        <group
          key={side}
          position={[side * 0.21, 1.4, 0]}
          rotation={[0, 0, side * -0.08]}
          ref={(el) => (rig.current.arms[i] = el)}
        >
          {/* 肩(体色に馴染ませる) */}
          <mesh castShadow>
            <sphereGeometry args={[0.055, 16, 12]} />
            {mat}
          </mesh>
          {/* 上腕(先細り) */}
          <mesh position={[0, -0.15, 0]} castShadow>
            <cylinderGeometry args={[0.038, 0.048, 0.28, 12]} />
            {mat}
          </mesh>
          {/* 前腕(肘からさらに先細り、わずかに前へ) */}
          <group position={[0, -0.3, 0]} rotation={[-0.12, 0, 0]}>
            <mesh castShadow>
              <sphereGeometry args={[0.038, 12, 10]} />
              {mat}
            </mesh>
            <mesh position={[0, -0.13, 0]} castShadow>
              <cylinderGeometry args={[0.028, 0.037, 0.24, 12]} />
              {mat}
            </mesh>
            {/* 手(平たい楕円) */}
            <mesh position={[0, -0.28, 0.01]} scale={[0.7, 1.15, 1]} castShadow>
              <sphereGeometry args={[0.045, 12, 10]} />
              {mat}
            </mesh>
          </group>
        </group>
      ))}

      {/* 脚(左右対称): 股関節を支点に振る。腿→すねは先細り */}
      {[-1, 1].map((side, i) => (
        <group
          key={side}
          position={[side * 0.095, 0.86, 0]}
          ref={(el) => (rig.current.legs[i] = el)}
        >
          {/* 腿 */}
          <mesh position={[0, -0.19, 0]} castShadow>
            <cylinderGeometry args={[0.055, 0.075, 0.38, 14]} />
            {mat}
          </mesh>
          {/* 膝 */}
          <mesh position={[0, -0.4, 0]} castShadow>
            <sphereGeometry args={[0.052, 14, 10]} />
            {mat}
          </mesh>
          {/* すね(足首へ絞る) */}
          <mesh position={[0, -0.6, 0]} castShadow>
            <cylinderGeometry args={[0.032, 0.05, 0.38, 14]} />
            {mat}
          </mesh>
          {/* 足(かかと〜つま先。つま先が+Z=正面) */}
          <mesh position={[0, -0.815, 0.04]} castShadow>
            <boxGeometry args={[0.085, 0.05, 0.23]} />
            {mat}
          </mesh>
          <mesh position={[0, -0.825, 0.15]} scale={[1, 0.55, 1]} castShadow>
            <sphereGeometry args={[0.042, 10, 8]} />
            {mat}
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ------------------------- プロシージャル建築(軽量パラメトリック形状) ------------------------- */

/** 壁: 既定3m幅 x 2.6m高。横幅/高さは params で可変 */
function Wall({ color, width = 3, height = 2.6 }: { color: string; width?: number; height?: number }) {
  return (
    <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={[width, height, 0.15]} />
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
  const rootRef = useRef<Group>(null);
  const rig = useRef<MannequinRig>({ body: null, arms: [null, null], legs: [null, null] });
  const selectEntity = useScene3d((s) => s.selectEntity);

  // インポートしたクリップモーション: スキン付きキャラを複製してミキサーで駆動
  const clipId = entity.motion?.type === "clip" ? entity.motion.clipId : null;
  const clipRig = useMemo(() => {
    if (!clipId) return null;
    const m = getImportedMotion(clipId);
    if (!m) return null;
    const obj = cloneSkeleton(m.template) as Group;
    obj.scale.setScalar(m.scale);
    obj.traverse((child) => {
      child.castShadow = true;
    });
    const mixer = new AnimationMixer(obj);
    mixer.clipAction(m.clip).play();
    return { obj, mixer, duration: m.clip.duration };
  }, [clipId]);
  const moveEntity = useScene3d((s) => s.moveEntity);
  const setDragging = useScene3d((s) => s.setDragging);
  const selected = useScene3d((s) => s.selectedEntityId === entity.id);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === entity.id);

  const color = selected ? "#f59e0b" : "#d4d4d8";

  const dragStart = useRef<Vec3 | null>(null);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    selectEntity(entity.id);
    setDragging(entity.id);
    dragStart.current = [...entity.position] as Vec3;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    const p = rayToFloor(e.ray);
    if (!p) return;
    // Shift: ドラッグ開始位置からの支配軸(X/Z)に沿って平行移動
    if (e.nativeEvent.shiftKey && dragStart.current) {
      const [sx, , sz] = dragStart.current;
      const dx = Math.abs(p[0] - sx);
      const dz = Math.abs(p[2] - sz);
      if (dx >= dz) {
        moveEntity(entity.id, [p[0], 0, sz]);
      } else {
        moveEntity(entity.id, [sx, 0, p[2]]);
      }
      return;
    }
    moveEntity(entity.id, p);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  // 歩行アニメーション: フレーム適用関数を登録(プレビューと書き出しの共通経路)
  useEffect(() => {
    const apply = (frame: number) => {
      const root = rootRef.current;
      if (!root) return;
      const st = useScene3d.getState();
      const ent = st.project.entities.find((e2) => e2.id === entity.id);
      if (!ent) return;
      const pose = evaluateEntityPose(st.project, ent, frame);
      root.position.set(pose.position[0], pose.position[1], pose.position[2]);
      root.rotation.y = pose.rotationY;

      // インポートクリップ: フレーム時刻で決定論的に駆動(ループ)
      if (clipRig) {
        const t = (frame / st.project.fps) % Math.max(0.001, clipRig.duration);
        clipRig.mixer.setTime(t);
        return;
      }

      const r = rig.current;
      if (!r.body) return;
      const { moving, phase, run } = pose.gait;
      const sw = moving ? Math.sin(phase * Math.PI * 2) : 0;
      const legAmp = run ? 0.95 : 0.55;
      const armAmp = run ? 0.85 : 0.45;
      if (r.legs[0]) r.legs[0].rotation.x = sw * legAmp;
      if (r.legs[1]) r.legs[1].rotation.x = -sw * legAmp;
      if (r.arms[0]) r.arms[0].rotation.x = -sw * armAmp;
      if (r.arms[1]) r.arms[1].rotation.x = sw * armAmp;
      // 弾み(接地ごと)と前傾
      r.body.position.y = moving ? Math.abs(Math.sin(phase * Math.PI * 2)) * (run ? 0.06 : 0.03) : 0;
      r.body.rotation.x = run ? 0.18 : moving ? 0.06 : 0;
    };
    frameAppliers.add(apply);
    apply(useScene3d.getState().currentFrame);
    return () => {
      frameAppliers.delete(apply);
    };
  }, [entity.id, clipRig]);

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
      ref={rootRef}
      position={entity.position}
      rotation={[0, entity.rotationY, 0]}
      scale={entity.scale}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      {entity.kind === "mannequin" &&
        (clipRig ? (
          <primitive object={clipRig.obj} />
        ) : (
          <Mannequin color={color} selected={selected} rig={rig} />
        ))}
      {entity.kind === "sphere" && (
        <mesh position={[0, 0.5, 0]} castShadow>
          <sphereGeometry args={[0.5, 32, 24]} />
          <meshStandardMaterial color={color} />
        </mesh>
      )}
      {entity.kind === "box" && (
        <mesh position={[0, (entity.params?.height ?? 0.8) / 2, 0]} castShadow>
          <boxGeometry
            args={[
              entity.params?.width ?? 0.8,
              entity.params?.height ?? 0.8,
              entity.params?.depth ?? 0.8,
            ]}
          />
          <meshStandardMaterial color={color} />
        </mesh>
      )}
      {entity.kind === "wall" && (
        <Wall color={color} width={entity.params?.width} height={entity.params?.height} />
      )}
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
          applySceneFrame(f); // 人物モーションをこのフレームの姿勢に
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

  return (
    <>
      <Line points={points} color="#ec4899" lineWidth={2} dashed={false} />
      {/* 終了点は CameraEndMarker(ドラッグ可能)が担う */}
      {/* 注視点マーカー */}
      <mesh position={lookAt}>
        <sphereGeometry args={[0.04, 12, 8]} />
        <meshBasicMaterial color="#ec4899" />
      </mesh>
    </>
  );
}

/**
 * カメラ本体の可視化(編集ビュー専用)。シーンの全カメラを常時立たせる(マルチカム)。
 * 選択カット使用中のカメラは黄色 + 視野の四角錐。クリックでそのカメラを使うカットを選択
 */
function CameraIndicator({ camera, selected }: { camera: SceneCamera; selected: boolean }) {
  const project = useScene3d((s) => s.project);
  const moveCameraEndpoint = useScene3d((s) => s.moveCameraEndpoint);
  const selectCameraOfShot = useScene3d((s) => s.selectCameraOfShot);
  const assignShotCamera = useScene3d((s) => s.assignShotCamera);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const cameraSelected = useScene3d((s) => s.cameraSelected);
  const setDragging = useScene3d((s) => s.setDragging);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === "__camera-start");
  const groupRef = useRef<Group>(null);
  const lastClientY = useRef(0);

  // このカメラの初期姿勢(動きの先頭)をプレビュー用ショットで評価
  const pose = evaluateShotCamera(
    project,
    { id: "__preview", label: "", durationFrames: 2, cameraId: camera.id },
    0,
  );
  const ar = project.aspectRatio === "9:16" ? 9 / 16 : project.aspectRatio === "1:1" ? 1 : 16 / 9;
  const highlight = selected && cameraSelected;
  const bodyColor = highlight ? "#f59e0b" : selected ? "#4a4c52" : "#33353a";
  const tally = cameraColor(project, camera.id);

  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(pose.position[0], pose.position[1], pose.position[2]);
    g.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  });

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    // このカメラを使う最初のカットを選択。どのカットも使っていなければ現在カットに割当
    const usingShot = project.shots.find((sh) => sh.cameraId === camera.id);
    if (usingShot) {
      selectCameraOfShot(usingShot.id);
    } else {
      assignShotCamera(selectedShotId, camera.id);
    }
    setDragging("__camera-start");
    lastClientY.current = e.nativeEvent.clientY;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf || !selected) return;
    const start = camera.move.startPos;
    if (e.nativeEvent.shiftKey) {
      // Shift+上下ドラッグ = 高さ調整
      const dy = e.nativeEvent.clientY - lastClientY.current;
      lastClientY.current = e.nativeEvent.clientY;
      const nextY = Math.max(0.1, Math.min(20, start[1] - dy * 0.02));
      moveCameraEndpoint("start", [start[0], nextY, start[2]]);
      return;
    }
    lastClientY.current = e.nativeEvent.clientY;
    const p = rayToPlaneY(e.ray, start[1]);
    if (p) moveCameraEndpoint("start", [Math.round(p[0] * 10) / 10, start[1], Math.round(p[2] * 10) / 10]);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  // 視野の四角錐(選択中のみ。距離0.7mに画角どおりの枠)
  const d = 0.7;
  const h = 2 * Math.tan(((pose.fovDeg / 2) * Math.PI) / 180) * d;
  const w = h * ar;
  const c1: Vec3 = [-w / 2, h / 2, d];
  const c2: Vec3 = [w / 2, h / 2, d];
  const c3: Vec3 = [w / 2, -h / 2, d];
  const c4: Vec3 = [-w / 2, -h / 2, d];
  const zero: Vec3 = [0, 0, 0];

  return (
    <group
      ref={groupRef}
      scale={0.55}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* つかみやすい不可視の当たり判定 */}
      <mesh visible={false}>
        <sphereGeometry args={[0.45, 8, 6]} />
        <meshBasicMaterial />
      </mesh>
      {/* カメラボディ + レンズ */}
      <mesh position={[0, 0, -0.12]}>
        <boxGeometry args={[0.24, 0.18, 0.24]} />
        <meshStandardMaterial color={bodyColor} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, 0.04]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.07, 0.09, 0.12, 16]} />
        <meshStandardMaterial color={highlight ? "#b45309" : "#1c1e22"} roughness={0.35} />
      </mesh>
      {/* タリーランプ(カメラ識別色。タイムラインのクリップと同じ色) */}
      <mesh position={[0, 0.13, -0.12]}>
        <sphereGeometry args={[0.035, 10, 8]} />
        <meshBasicMaterial color={tally} />
      </mesh>
      {highlight && (
        <>
          <Line points={[zero, c1]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
          <Line points={[zero, c2]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
          <Line points={[zero, c3]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
          <Line points={[zero, c4]} color="#f9a8d4" lineWidth={1} transparent opacity={0.7} />
          <Line points={[c1, c2, c3, c4, c1]} color="#f9a8d4" lineWidth={1.5} />
        </>
      )}
    </group>
  );
}

/** 全カットのカメラを購読して描画(マルチカム表示) *//** 全カットのカメラを購読して描画(マルチカム表示) */
function AllCameraIndicators() {
  const cameras = useScene3d((s) => s.project.cameras);
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const selectedCameraId = getSelectedShot({ project, selectedShotId }).cameraId;
  return (
    <>
      {cameras.map((cam) => (
        <CameraIndicator key={cam.id} camera={cam} selected={cam.id === selectedCameraId} />
      ))}
    </>
  );
}

/**
 * 終点マーカー(赤)。ドラッグでカメラの止まる位置を動かす。
 * オービット中は赤点を回すと回り込み角度(15°刻み)が変わる
 */
function CameraEndMarker() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const moveCameraEndpoint = useScene3d((s) => s.moveCameraEndpoint);
  const setOrbitDegrees = useScene3d((s) => s.setOrbitDegrees);
  const setDragging = useScene3d((s) => s.setDragging);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === "__camera-end");
  const lastClientY = useRef(0);

  const shot = getSelectedShot({ project, selectedShotId });
  const move = getShotMove(project, shot);
  if (move.preset === "fixed") return null; // 固定は終点なし

  const end = evaluateShotCamera(project, shot, Math.max(0, shot.durationFrames - 1)).position;
  const isOrbit = move.preset === "orbit";

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setDragging("__camera-end");
    lastClientY.current = e.nativeEvent.clientY;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    if (isOrbit) {
      // 注視点まわりの角度に変換(15°刻み)
      const c = resolveLookAt(project, shot);
      const p = rayToPlaneY(e.ray, c[1]) ?? rayToFloor(e.ray);
      if (!p) return;
      const st = move.startPos;
      const a0 = Math.atan2(st[2] - c[2], st[0] - c[0]);
      const a1 = Math.atan2(p[2] - c[2], p[0] - c[0]);
      let deg = ((a1 - a0) * 180) / Math.PI;
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      setOrbitDegrees(Math.round(deg / 15) * 15);
      return;
    }
    const endPos = move.endPos;
    if (e.nativeEvent.shiftKey) {
      const dy = e.nativeEvent.clientY - lastClientY.current;
      lastClientY.current = e.nativeEvent.clientY;
      const nextY = Math.max(0.1, Math.min(20, endPos[1] - dy * 0.02));
      moveCameraEndpoint("end", [endPos[0], nextY, endPos[2]]);
      return;
    }
    lastClientY.current = e.nativeEvent.clientY;
    const p = rayToPlaneY(e.ray, endPos[1]);
    if (p) moveCameraEndpoint("end", [Math.round(p[0] * 10) / 10, endPos[1], Math.round(p[2] * 10) / 10]);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <group
      position={end}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <mesh visible={false}>
        <sphereGeometry args={[0.3, 8, 6]} />
        <meshBasicMaterial />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.11, 16, 12]} />
        <meshBasicMaterial color="#f87171" />
      </mesh>
    </group>
  );
}

/**
 * 軌道の中間ハンドル(黄)。ドラッグで通り道を自由に曲げる(2次ベジェ)。
 * 対象: 開始→終了の補間系プリセット(プッシュイン/プルアウト/トラック/パン/クレーン)
 */
function CameraMidMarker() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const moveCameraMid = useScene3d((s) => s.moveCameraMid);
  const setDragging = useScene3d((s) => s.setDragging);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === "__camera-mid");
  const lastClientY = useRef(0);

  const shot = getSelectedShot({ project, selectedShotId });
  const move = getShotMove(project, shot);
  const preset = move.preset;
  if (preset === "fixed" || preset === "orbit" || preset === "handheld") return null;

  // 中間点: 未設定なら軌道の中点(=直線の真ん中)
  const mid: Vec3 =
    move.midPos ??
    ([
      (move.startPos[0] + move.endPos[0]) / 2,
      (move.startPos[1] + move.endPos[1]) / 2,
      (move.startPos[2] + move.endPos[2]) / 2,
    ] as Vec3);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setDragging("__camera-mid");
    lastClientY.current = e.nativeEvent.clientY;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    if (e.nativeEvent.shiftKey) {
      const dy = e.nativeEvent.clientY - lastClientY.current;
      lastClientY.current = e.nativeEvent.clientY;
      moveCameraMid([mid[0], Math.max(0.1, Math.min(20, mid[1] - dy * 0.02)), mid[2]]);
      return;
    }
    lastClientY.current = e.nativeEvent.clientY;
    const p = rayToPlaneY(e.ray, mid[1]);
    if (p) moveCameraMid([Math.round(p[0] * 10) / 10, mid[1], Math.round(p[2] * 10) / 10]);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <group
      position={mid}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        moveCameraMid(null); // ダブルクリックで直線に戻す
      }}
    >
      <mesh visible={false}>
        <sphereGeometry args={[0.28, 8, 6]} />
        <meshBasicMaterial />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.09, 16, 12]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
    </group>
  );
}

/**
 * 選択中の人物のモーション経路(点線)と行き先マーカー(旗)。
 * 旗を床ドラッグすると行き先が変わる
 */
function MotionOverlay() {
  const project = useScene3d((s) => s.project);
  const selectedEntityId = useScene3d((s) => s.selectedEntityId);
  const moveMotionTarget = useScene3d((s) => s.moveMotionTarget);
  const setDragging = useScene3d((s) => s.setDragging);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === "__motion-target");

  const entity = project.entities.find((e) => e.id === selectedEntityId);
  if (
    !entity ||
    entity.kind !== "mannequin" ||
    !entity.motion ||
    entity.motion.type === "clip" ||
    entity.motion.path.length === 0
  ) {
    return null;
  }
  const dest = entity.motion.path[entity.motion.path.length - 1];
  const pathPoints: Vec3[] = [
    [entity.position[0], 0.03, entity.position[2]],
    ...entity.motion.path.map((p): Vec3 => [p[0], 0.03, p[2]]),
  ];
  const color = entity.motion.type === "run" ? "#fb923c" : "#a3e635";

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setDragging("__motion-target");
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    const p = rayToFloor(e.ray);
    if (p) moveMotionTarget(entity.id, p);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <>
      <Line points={pathPoints} color={color} lineWidth={2} dashed dashSize={0.18} gapSize={0.12} />
      {/* 行き先の旗(ドラッグで移動) */}
      <group
        position={[dest[0], 0, dest[2]]}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <mesh visible={false} position={[0, 0.4, 0]}>
          <sphereGeometry args={[0.4, 8, 6]} />
          <meshBasicMaterial />
        </mesh>
        <mesh position={[0, 0.45, 0]}>
          <cylinderGeometry args={[0.015, 0.015, 0.9, 8]} />
          <meshBasicMaterial color={color} />
        </mesh>
        <mesh position={[0.11, 0.78, 0]}>
          <boxGeometry args={[0.22, 0.14, 0.01]} />
          <meshBasicMaterial color={color} />
        </mesh>
        <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, 0.18, 24]} />
          <meshBasicMaterial color={color} transparent opacity={0.8} />
        </mesh>
      </group>
    </>
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
    // 人物モーション等をこのフレームの姿勢に(primaryのみ。二重適用防止)
    if (primary) applySceneFrame(st.currentFrame);
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

/** 視点プリセット(正面/横/俯瞰/斜め/全体/リセット)。UIボタン(Workspace側)から呼ばれる */
export type ViewPresetType = "front" | "side" | "top" | "iso" | "fit" | "reset";
let viewPresetListener: ((t: ViewPresetType) => void) | null = null;
export function requestViewPreset(t: ViewPresetType): void {
  viewPresetListener?.(t);
}

function ViewPresetController() {
  const { camera, controls } = useThree();
  useEffect(() => {
    viewPresetListener = (t) => {
      const c = controls as unknown as { target: Vector3; update: () => void } | null;

      // リセット: 選択に関係なく原点の初期構図へ
      if (t === "reset") {
        camera.position.set(4, 3, 6);
        c?.target.set(0, 1, 0);
        camera.lookAt(0, 1, 0);
        c?.update();
        return;
      }

      // 基準点 = 選択中の被写体(物体 or カメラ)。未選択ならシーン中央
      const st = useScene3d.getState();
      const target = new Vector3(0, 1, 0);
      const selEntity = st.project.entities.find((e) => e.id === st.selectedEntityId);
      if (selEntity) {
        const h =
          selEntity.kind === "mannequin" ? 1.1 : selEntity.kind === "building" ? 3 : 0.6;
        target.set(
          selEntity.position[0],
          selEntity.position[1] + h * selEntity.scale,
          selEntity.position[2],
        );
      } else if (st.cameraSelected) {
        const shot = getSelectedShot(st);
        const move = getShotMove(st.project, shot);
        target.set(move.startPos[0], move.startPos[1], move.startPos[2]);
      }

      const dist = t === "fit" ? 9 : Math.max(3, camera.position.distanceTo(target));
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
      // 選択物を回転の中心にする(以降のオービットも選択物基準)
      c?.target.copy(target);
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
  const clearSelection = useScene3d((s) => s.clearSelection);
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
      onPointerMissed={() => clearSelection()}
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
      {/* グレーの床(編集時・書き出し時共通)。クリック判定からは除外(空クリック=選択解除) */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.001, 0]}
        receiveShadow
        raycast={() => null}
      >
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#818387" />
      </mesh>
      {entities.map((e) => (
        <EntityMesh key={e.id} entity={e} />
      ))}
      {!exporting && !isCameraPane && <CameraPathLine />}
      {!exporting && !isCameraPane && <AllCameraIndicators />}
      {!exporting && !isCameraPane && <CameraEndMarker />}
      {!exporting && !isCameraPane && <CameraMidMarker />}
      {!exporting && !isCameraPane && <MotionOverlay />}
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
