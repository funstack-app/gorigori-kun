/**
 * scene3d ビューポート (React Three Fiber)
 *
 * - エンティティは床面(y=0)上をポインタドラッグで移動(スナップ0.1m)
 * - カメラ軌道は evaluateCamera のサンプリングで可視化(評価器と表示のずれをなくす)
 * - 再生中/カメラビュー中は evaluateCamera がビューカメラを駆動する
 *   (プレビューと書き出しが同じ評価器を通る = 決定性の担保)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Line, OrbitControls } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { AnimationMixer, PerspectiveCamera, Vector2, Vector3 } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type {
  AnimationAction,
  Group,
  PerspectiveCamera as ThreePerspectiveCamera,
  Ray,
} from "three";

import { scene3d as scene3dIpc } from "../../../lib/ipc";
import { getImportedMotion } from "../../../lib/scene3d/motionLibrary";
import {
  evaluateCamera,
  evaluateEntityPose,
  evaluateShotCamera,
  getShotMove,
  surfaceHeightAt,
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

/**
 * 押下中キーの追跡(X/Y/Zキーの軸拘束ドラッグ用)。
 * 参照されるのはエンティティのドラッグ中だけなので、入力欄のタイプとは干渉しない
 */
const heldKeys = new Set<string>();
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    // 文字入力中のx/y/zは拾わない(ラベル編集中のドラッグ複合操作での誤発動防止)
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    heldKeys.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => heldKeys.clear());
}

/**
 * ポインタのレイと「点p0を通りカメラに正対する縦平面」の交点(Yキーの高さ調整用)。
 * 真上/真下からの視点では高さ操作できないため null
 */
function rayToVerticalPlane(ray: Ray, p0: Vec3): Vec3 | null {
  let nx = -ray.direction.x;
  let nz = -ray.direction.z;
  const len = Math.hypot(nx, nz);
  if (len < 1e-6) return null;
  nx /= len;
  nz /= len;
  const denom = ray.direction.x * nx + ray.direction.z * nz;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((p0[0] - ray.origin.x) * nx + (p0[2] - ray.origin.z) * nz) / denom;
  if (t < 0) return null;
  return [
    ray.origin.x + ray.direction.x * t,
    ray.origin.y + ray.direction.y * t,
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

/* ------------------------- 家具・屋外(リファレンス用の軽量ブロック) ------------------------- */

function Table({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.72, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.4, 0.05, 0.8]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      {[[-0.62, -0.32], [0.62, -0.32], [-0.62, 0.32], [0.62, 0.32]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.35, z]} castShadow>
          <boxGeometry args={[0.06, 0.7, 0.06]} />
          <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Chair({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.44, 0]} castShadow>
        <boxGeometry args={[0.45, 0.05, 0.45]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.75, -0.2]} castShadow>
        <boxGeometry args={[0.45, 0.6, 0.05]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      {[[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.21, z]} castShadow>
          <boxGeometry args={[0.05, 0.42, 0.05]} />
          <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Sofa({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.28, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.8, 0.45, 0.85]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.62, -0.32]} castShadow>
        <boxGeometry args={[1.8, 0.5, 0.22]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.82, 0.52, 0.05]} castShadow>
          <boxGeometry args={[0.18, 0.3, 0.75]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Bed({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.1, 0.4, 2.0]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.5, -0.75]} scale={[1, 0.4, 1]} castShadow>
        <sphereGeometry args={[0.22, 12, 10]} />
        <meshStandardMaterial color="#d8dade" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.62, -0.98]} castShadow>
        <boxGeometry args={[1.1, 0.55, 0.06]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
    </group>
  );
}

function Shelf({ color }: { color: string }) {
  return (
    <group>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.44, 0.9, 0]} castShadow>
          <boxGeometry args={[0.04, 1.8, 0.35]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
      {[0.3, 0.85, 1.4, 1.78].map((y, i) => (
        <mesh key={i} position={[0, y, 0]} castShadow>
          <boxGeometry args={[0.9, 0.035, 0.35]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** 台座(商品を置く円柱) */
function Pedestal({ color }: { color: string }) {
  return (
    <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[0.32, 0.36, 1.0, 24]} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}

/** 車(ブロックアウト。+Zが前) */
function Car({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.8, 0.5, 4.2]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.98, -0.3]} castShadow>
        <boxGeometry args={[1.6, 0.45, 2.0]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      {[[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.32, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.32, 0.32, 0.2, 18]} />
          <meshStandardMaterial color="#2a2c30" roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

function Tree({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.9, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.16, 1.8, 10]} />
        <meshStandardMaterial color="#6b5a48" roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.2, 0]} castShadow>
        <sphereGeometry args={[0.85, 14, 12]} />
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
      <mesh position={[0.4, 1.7, 0.2]} castShadow>
        <sphereGeometry args={[0.5, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
      <mesh position={[-0.42, 1.85, -0.15]} castShadow>
        <sphereGeometry args={[0.55, 12, 10]} />
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
    </group>
  );
}

function Streetlight({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 2.2, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.07, 4.4, 10]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 4.4, 0.4]} rotation={[Math.PI / 2.4, 0, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.9, 8]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 4.55, 0.78]} castShadow>
        <boxGeometry args={[0.22, 0.1, 0.45]} />
        <meshStandardMaterial color="#f4f0d8" emissive="#f4f0d8" emissiveIntensity={0.5} />
      </mesh>
    </group>
  );
}

function EntityMesh({ entity }: { entity: SceneEntity }) {
  const controls = useThree((state) => state.controls);
  const rootRef = useRef<Group>(null);
  const rig = useRef<MannequinRig>({ body: null, arms: [null, null], legs: [null, null] });
  const selectEntity = useScene3d((s) => s.selectEntity);

  // インポートしたクリップモーション: スキン付きキャラを複製してミキサーで駆動
  const clipMotion = entity.motion?.type === "clip" ? entity.motion : null;
  const clipId = clipMotion?.clipId ?? null;
  const clipMoves = (clipMotion?.speed ?? 0) > 0;
  // 到着後アクション(未指定は待機)。骨格を共有する標準ライブラリ/AI生成のみ
  const arrivalClipId =
    clipMoves && (clipId?.startsWith("builtin-") || clipId?.startsWith("gen-"))
      ? (clipMotion?.arrivalClipId ?? "builtin-Idle_Loop")
      : null;
  // ライブラリの読み込み完了で組み直す(再起動直後は実体が未登録のため)
  const motionCount = useScene3d((s) => s.importedMotions.length);
  // 連結列(到着後アクションの列)。未指定は従来の単発(またはIdle)にフォールバック
  const arrivalSeqKey = JSON.stringify(
    clipMotion?.arrivalSequence?.map((s) => `${s.clipId}:${s.seconds ?? ""}`) ?? null,
  );
  const clipRig = useMemo(() => {
    void motionCount;
    void arrivalSeqKey;
    if (!clipId) return null;
    const m = getImportedMotion(clipId);
    if (!m) return null;
    const obj = cloneSkeleton(m.template) as Group;
    obj.scale.setScalar(m.scale);
    obj.traverse((child) => {
      child.castShadow = true;
    });
    const mixer = new AnimationMixer(obj);
    const main = mixer.clipAction(m.clip);
    main.play();
    // 到着後アクションの列: 同じテンプレート(=同じ骨格)のクリップだけ適用できる。
    // 同じクリップを複数ステップで使えるよう、クリップは複製して独立アクションにする
    const stepSpecs =
      clipMotion?.arrivalSequence && clipMotion.arrivalSequence.length > 0
        ? clipMotion.arrivalSequence
        : arrivalClipId && arrivalClipId !== clipId
          ? [{ clipId: arrivalClipId }]
          : [];
    const steps: { action: AnimationAction; duration: number; loops: boolean; seconds?: number }[] =
      [];
    for (const spec of stepSpecs) {
      const am = getImportedMotion(spec.clipId);
      if (!am || am.template !== m.template) continue;
      const action = mixer.clipAction(am.clip.clone());
      action.play();
      action.weight = 0;
      // 名前が _Loop で終わらないクリップ(座る(動作)・着地等)は一回きり→最終姿勢で静止
      steps.push({
        action,
        duration: am.clip.duration,
        loops: am.clip.name.endsWith("_Loop"),
        seconds: spec.seconds,
      });
    }
    return { obj, mixer, main, mainDuration: m.clip.duration, steps };
  }, [clipId, arrivalClipId, arrivalSeqKey, motionCount, clipMotion?.arrivalSequence]);
  const moveEntity = useScene3d((s) => s.moveEntity);
  const rotateEntityFree = useScene3d((s) => s.rotateEntityFree);
  const scaleEntityBy = useScene3d((s) => s.scaleEntityBy);
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
    const start = dragStart.current ?? entity.position;
    const snap = (v: number) => Math.round(v * 10) / 10;

    // Rキー: グリグリ回転(BlenderのR相当)。横ドラッグ=向き / 縦ドラッグ=傾き
    if (heldKeys.has("r")) {
      const SENS = 0.012;
      rotateEntityFree(
        entity.id,
        e.nativeEvent.movementX * SENS,
        e.nativeEvent.movementY * SENS,
      );
      return;
    }
    // Sキー: 大きさ(BlenderのS相当)。上ドラッグ=大きく / 下=小さく
    if (heldKeys.has("s")) {
      scaleEntityBy(entity.id, -e.nativeEvent.movementY * 0.01);
      return;
    }

    // Zキー: 高さだけ動かす(Blender流: 縦=Z。カメラに正対する縦平面との交点で上下)
    if (heldKeys.has("z")) {
      const v = rayToVerticalPlane(e.ray, start);
      if (!v) return;
      moveEntity(entity.id, [
        entity.position[0],
        Math.max(0, snap(v[1])),
        entity.position[2],
      ]);
      return;
    }

    // 水平移動: 現在の高さの平面上でドラッグ。
    // 人物は地形に吸着する(建物・箱・机の上に運ぶと天面に乗る=磁石)
    const p = rayToPlaneY(e.ray, entity.position[1]) ?? rayToFloor(e.ray);
    if (!p) return;
    const nx = snap(p[0]);
    const nz = snap(p[2]);
    const y =
      entity.kind === "mannequin"
        ? surfaceHeightAt(useScene3d.getState().project, nx, nz, entity.id)
        : entity.position[1];

    // X/Zキー: その軸だけ動かす
    if (heldKeys.has("x")) {
      moveEntity(entity.id, [nx, y, start[2]]);
      return;
    }
    if (heldKeys.has("y")) {
      // Yキー: 奥行きだけ動かす(Blender流の呼び方。内部軸はthree.jsのz)
      moveEntity(entity.id, [start[0], y, nz]);
      return;
    }
    // Shift: ドラッグ開始位置からの支配軸(X/Z)に沿って平行移動
    if (e.nativeEvent.shiftKey && dragStart.current) {
      const [sx, , sz] = dragStart.current;
      const dx = Math.abs(nx - sx);
      const dz = Math.abs(nz - sz);
      if (dx >= dz) {
        moveEntity(entity.id, [nx, y, sz]);
      } else {
        moveEntity(entity.id, [sx, y, nz]);
      }
      return;
    }
    moveEntity(entity.id, [nx, y, nz]);
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
      // YXZ(向き→傾き): 倒れモーションが「向いている方向へ前傾」になる。
      // 静的な傾き(rotationX/Z)もここで毎フレーム適用する(詳細調整の3軸回転)
      root.rotation.set(
        (ent.rotationX ?? 0) + (pose.fallAngle ?? 0),
        pose.rotationY,
        ent.rotationZ ?? 0,
        "YXZ",
      );

      // インポートクリップ: フレーム時刻から各アクションの時間・重みを直接決める
      // (mixer任せのループにせず手動で time を与える = スクラブしても同一フレーム→同一姿勢)
      if (clipRig) {
        const t = frame / st.project.fps;
        const arrivalAt = pose.travelSeconds;
        const steps = clipRig.steps;
        // つなぎ目のクロスフェード幅(秒)。ハード切替のカクつきをここで消す
        const BLEND = 0.35;
        const smooth = (w: number) => w * w * (3 - 2 * w);
        const setTime = (
          s: { action: AnimationAction; duration: number; loops: boolean },
          local: number,
        ) => {
          s.action.time = s.loops
            ? local % Math.max(0.001, s.duration)
            : Math.min(local, Math.max(0.001, s.duration - 0.0001));
        };

        if (steps.length > 0 && arrivalAt != null) {
          // タイムライン: 移動[0, arrivalAt] → step0, step1, ...
          // 各stepは自分の開始BLEND秒前からフェードインし始める(着地は到着と同時に完了)
          const eff = (i: number) =>
            steps[i].seconds ?? (i === steps.length - 1 ? Infinity : Math.max(steps[i].duration, 0.5));
          const startOf: number[] = [];
          let acc = arrivalAt;
          for (let i = 0; i < steps.length; i++) {
            startOf.push(acc);
            acc += eff(i);
          }
          // 現在アクティブなstep k (フェードイン開始 = startOf[k] - BLEND)
          let k = -1; // -1 = まだ移動クリップのみ
          for (let i = 0; i < steps.length; i++) {
            if (t >= startOf[i] - BLEND) k = i;
          }
          // 全アクションを一旦ゼロに
          clipRig.main.weight = 0;
          for (const s of steps) s.action.weight = 0;

          if (k === -1) {
            clipRig.main.weight = 1;
            clipRig.main.time = t % Math.max(0.001, clipRig.mainDuration);
          } else {
            const fadeStart = startOf[k] - BLEND;
            const w = smooth(Math.min(1, (t - fadeStart) / BLEND));
            steps[k].action.weight = w;
            setTime(steps[k], t - fadeStart);
            // 混ざる相手: 前のstep、無ければ移動クリップ
            if (w < 1) {
              if (k === 0) {
                clipRig.main.weight = 1 - w;
                clipRig.main.time = t % Math.max(0.001, clipRig.mainDuration);
              } else {
                steps[k - 1].action.weight = 1 - w;
                setTime(steps[k - 1], t - (startOf[k - 1] - BLEND));
              }
            }
          }
        } else {
          clipRig.main.weight = 1;
          clipRig.main.time = t % Math.max(0.001, clipRig.mainDuration);
          for (const s of steps) s.action.weight = 0;
        }
        clipRig.mixer.update(0);
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
    // モーションで移動した後の「いま見えている位置」を注視する
    const st = useScene3d.getState();
    const pose = evaluateEntityPose(st.project, entity, st.currentFrame);
    c.target.set(pose.position[0], pose.position[1] + h * entity.scale, pose.position[2]);
    c.update();
  };

  return (
    <group
      ref={rootRef}
      position={entity.position}
      rotation={[entity.rotationX ?? 0, entity.rotationY, entity.rotationZ ?? 0, "YXZ"]}
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
      {entity.kind === "table" && <Table color={color} />}
      {entity.kind === "chair" && <Chair color={color} />}
      {entity.kind === "sofa" && <Sofa color={color} />}
      {entity.kind === "bed" && <Bed color={color} />}
      {entity.kind === "shelf" && <Shelf color={color} />}
      {entity.kind === "pedestal" && <Pedestal color={color} />}
      {entity.kind === "car" && <Car color={color} />}
      {entity.kind === "tree" && <Tree color={selected ? color : "#7a8d6a"} />}
      {entity.kind === "streetlight" && <Streetlight color={color} />}
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
    const samples = 48;
    for (let i = 0; i <= samples; i++) {
      const frame = Math.round(((shot.durationFrames - 1) * i) / samples);
      pts.push(evaluateShotCamera(project, shot, frame).position);
    }
    return pts;
  }, [project, shot]);

  // 速度の点々: 時間の等間隔でサンプルするため「詰まっている=ゆっくり / まばら=速い」が見える
  const speedDots = useMemo(() => {
    const dots: Vec3[] = [];
    const stepFrames = 3;
    for (let f = stepFrames; f < shot.durationFrames - 1; f += stepFrames) {
      dots.push(evaluateShotCamera(project, shot, f).position);
    }
    return dots;
  }, [project, shot]);

  const lookAt = useMemo(() => resolveLookAt(project, shot), [project, shot]);

  return (
    <>
      <Line points={points} color="#ec4899" lineWidth={2} dashed={false} transparent opacity={0.55} />
      {speedDots.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.028, 8, 6]} />
          <meshBasicMaterial color="#f9a8d4" />
        </mesh>
      ))}
      {/* 終了点は CameraEndMarker(ドラッグ可能)が担う */}
      {/* 注視点マーカー */}
      <mesh position={lookAt}>
        <sphereGeometry args={[0.04, 12, 8]} />
        <meshBasicMaterial color="#ec4899" />
      </mesh>
    </>
  );
}

/** 真珠の道をそのまま出せるプリセット(開始→終了の補間系) */
const PATH_PRESET_IDS = new Set(["pushIn", "pullOut", "track", "pan", "crane", "path"]);
/**
 * つかんだ瞬間に「自由な道」へ変換できる軌道系プリセット。
 * 揺れ・ズーム演出が本体のもの(handheld/shake/whipPan/snapZoom/dollyZoom)と
 * 被写体連動が本体の follow、道を持たない fixed は対象外
 */
const CONVERTIBLE_PRESET_IDS = new Set(["orbit", "spiralIn", "flyover", "riseReveal"]);

/**
 * 真珠の道: カメラの通り道を「つかんで曲げる」。
 * - 道の上をつかむとその場所に真珠(通過点)が増え、そのままドラッグで曲げられる
 * - 各真珠は「床の影 + 紐 + 風船」で表示: 影ドラッグ=平面移動 / 風船ドラッグ=高さだけ
 * - 風船ダブルクリックで真珠を削除(全部消すと直線に戻る)
 */
function PathPearls() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const insertCameraPathPoint = useScene3d((s) => s.insertCameraPathPoint);
  const moveCameraPathPoint = useScene3d((s) => s.moveCameraPathPoint);
  const removeCameraPathPoint = useScene3d((s) => s.removeCameraPathPoint);
  const convertCameraToFreePath = useScene3d((s) => s.convertCameraToFreePath);
  const setDragging = useScene3d((s) => s.setDragging);
  const draggingEntityId = useScene3d((s) => s.draggingEntityId);
  // ドラッグ中の真珠index。動かし方はキーで決まる(普通=平面を自由に / Z押しながら=高さ)
  const activeDrag = useRef<{ index: number } | null>(null);

  const shot = getSelectedShot({ project, selectedShotId });
  const move = getShotMove(project, shot);
  const pts = move.pathPoints ?? [];

  const editable = PATH_PRESET_IDS.has(move.preset);
  const convertible = CONVERTIBLE_PRESET_IDS.has(move.preset);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 道つかみハンドル。速度の点々(CameraPathLineの3フレームおきサンプル)と同じ位置に置き、
  // 「見えている点=掴める点」を一致させる(ズレると反応が悪く感じる)
  const grabbers = useMemo(() => {
    if (!editable && !convertible) return [];
    const out: Vec3[] = [];
    const stepFrames = 3;
    for (let f = stepFrames; f < shot.durationFrames - 1; f += stepFrames) {
      const p = evaluateShotCamera(project, shot, f).position;
      const nearPearl = pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.4);
      if (!nearPearl) out.push(p);
    }
    return out;
  }, [project, shot, editable, convertible, pts]);

  if (!editable && !convertible) return null;

  const beginDrag = (e: ThreeEvent<PointerEvent>, index: number) => {
    e.stopPropagation();
    activeDrag.current = { index };
    setDragging(`__path-${index}`);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ThreeEvent<PointerEvent>) => {
    const d = activeDrag.current;
    if (!d || draggingEntityId !== `__path-${d.index}`) return;
    const cur = (move.pathPoints ?? [])[d.index];
    if (!cur) return;
    if (heldKeys.has("z")) {
      // Z押しながら=高さだけ(Blender流: 縦=Z)
      const p = rayToVerticalPlane(e.ray, cur);
      if (p) {
        const y = Math.max(0.05, Math.min(20, Math.round(p[1] * 10) / 10));
        moveCameraPathPoint(d.index, [cur[0], y, cur[2]]);
      }
      return;
    }
    // 普通のドラッグ=今の高さの平面上を自由に移動
    const p = rayToPlaneY(e.ray, cur[1]) ?? rayToFloor(e.ray);
    if (p) {
      moveCameraPathPoint(d.index, [
        Math.round(p[0] * 10) / 10,
        cur[1],
        Math.round(p[2] * 10) / 10,
      ]);
    }
  };
  const onDragUp = (e: ThreeEvent<PointerEvent>) => {
    if (!activeDrag.current) return;
    activeDrag.current = null;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <>
      {/* 道つかみ: ピンクの点をつかむと真珠が生まれ、そのまま曲げられる */}
      {grabbers.map((p, i) => (
        <group key={`grab-${i}`} position={p}>
          {/* 当たり判定(見えない)。見えている点より一回り大きく */}
          <mesh
            visible={false}
            onPointerDown={(e) => {
              e.stopPropagation();
              document.body.style.cursor = "";
              // オービット等の軌道系は、つかんだ瞬間に今の形のまま「自由な道」へ変換する
              if (convertible) {
                const last = shot.durationFrames - 1;
                const sample = (f: number): Vec3 => {
                  const q = evaluateShotCamera(project, shot, Math.round(f)).position;
                  return [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, Math.round(q[2] * 10) / 10];
                };
                convertCameraToFreePath(
                  sample(0),
                  sample(last),
                  [sample(last * 0.25), sample(last * 0.5), sample(last * 0.75)],
                );
              }
              const idx = insertCameraPathPoint([
                Math.round(p[0] * 10) / 10,
                Math.round(p[1] * 10) / 10,
                Math.round(p[2] * 10) / 10,
              ]);
              beginDrag(e, idx);
            }}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            onPointerOver={() => {
              setHoverIdx(i);
              document.body.style.cursor = "grab";
            }}
            onPointerOut={() => {
              setHoverIdx((cur) => (cur === i ? null : cur));
              document.body.style.cursor = "";
            }}
          >
            <sphereGeometry args={[0.2, 8, 6]} />
            <meshBasicMaterial />
          </mesh>
          {/* ホバーで点が膨らむ(掴める合図) */}
          {hoverIdx === i && (
            <mesh>
              <sphereGeometry args={[0.075, 12, 8]} />
              <meshBasicMaterial color="#f472b6" />
            </mesh>
          )}
        </group>
      ))}
      {/* 真珠(通過点): 床の影 + 紐 + 風船 */}
      {pts.map((p, i) => (
        <group key={`pearl-${i}`}>
          {/* 紐 */}
          <Line
            points={[[p[0], 0, p[2]] as Vec3, p]}
            color="#ec4899"
            lineWidth={1}
            dashed
            dashSize={0.08}
            gapSize={0.06}
            transparent
            opacity={0.5}
          />
          {/* 床の影(ドラッグ=平面移動) */}
          <group
            position={[p[0], 0.015, p[2]]}
            onPointerDown={(e) => beginDrag(e, i)}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
          >
            <mesh visible={false}>
              <sphereGeometry args={[0.3, 8, 6]} />
              <meshBasicMaterial />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.1, 0.17, 24]} />
              <meshBasicMaterial color="#ec4899" transparent opacity={0.75} />
            </mesh>
          </group>
          {/* 風船(ドラッグ=高さだけ / ダブルクリック=削除) */}
          <group
            position={p}
            onPointerDown={(e) => beginDrag(e, i)}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removeCameraPathPoint(i);
            }}
          >
            <mesh visible={false}>
              <sphereGeometry args={[0.3, 8, 6]} />
              <meshBasicMaterial />
            </mesh>
            <mesh>
              <sphereGeometry args={[0.09, 16, 12]} />
              <meshBasicMaterial color="#ec4899" />
            </mesh>
          </group>
        </group>
      ))}
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
  const setCameraTarget = useScene3d((s) => s.setCameraTarget);
  const draggingSelf = useScene3d((s) => s.draggingEntityId === "__camera-start");
  const linkDragging = useScene3d((s) => s.draggingEntityId === "__follow-link");
  const groupRef = useRef<Group>(null);
  const lastClientY = useRef(0);
  // 追従リンクのドラッグ中カーソル(このカメラから引いている時だけ非null)
  const [linkCursor, setLinkCursor] = useState<{ point: Vec3; snapId: string | null } | null>(
    null,
  );

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
    if (heldKeys.has("z") || e.nativeEvent.shiftKey) {
      // Z(またはShift)+上下ドラッグ = 高さ調整
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

  // ---- 追従リンク(◎ハンドルを人物へドラッグ&ドロップで「被写体を追う」を接続) ----
  // レイに一番近い人物・物を探す(0.8m以内でスナップ)。外れたら床の上のカーソル位置
  const snapToEntity = (ray: Ray): { point: Vec3; snapId: string | null } => {
    let best: { id: string; d: number; c: Vec3 } | null = null;
    for (const en of project.entities) {
      const c: Vec3 = [en.position[0], en.position[1] + 0.9, en.position[2]];
      const ox = c[0] - ray.origin.x;
      const oy = c[1] - ray.origin.y;
      const oz = c[2] - ray.origin.z;
      const t = Math.max(0, ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z);
      const d = Math.hypot(
        c[0] - (ray.origin.x + ray.direction.x * t),
        c[1] - (ray.origin.y + ray.direction.y * t),
        c[2] - (ray.origin.z + ray.direction.z * t),
      );
      if (d < 0.8 && (best == null || d < best.d)) best = { id: en.id, d, c };
    }
    if (best) return { point: best.c, snapId: best.id };
    const p = rayToPlaneY(ray, 0.9) ?? rayToFloor(ray);
    return { point: p ?? pose.position, snapId: null };
  };
  const onLinkDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    // setCameraTarget は「選択中カメラ」に効くため、先にこのカメラを選択状態にする
    const usingShot = project.shots.find((sh) => sh.cameraId === camera.id);
    if (usingShot) {
      selectCameraOfShot(usingShot.id);
    } else {
      assignShotCamera(selectedShotId, camera.id);
    }
    setDragging("__follow-link");
    setLinkCursor(snapToEntity(e.ray));
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onLinkMove = (e: ThreeEvent<PointerEvent>) => {
    if (!linkDragging || linkCursor == null) return;
    setLinkCursor(snapToEntity(e.ray));
  };
  const onLinkUp = (e: ThreeEvent<PointerEvent>) => {
    if (!linkDragging || linkCursor == null) return;
    setDragging(null);
    (e.target as Element).releasePointerCapture(e.pointerId);
    const drop = snapToEntity(e.ray);
    if (drop.snapId) {
      setCameraTarget(drop.snapId); // 人物・物の上で離した=追従を接続
    } else if (camera.move.targetEntityId != null) {
      setCameraTarget(null); // 何もない場所で離した=追従を解除
    }
    setLinkCursor(null);
  };
  const linked = camera.move.targetEntityId != null;

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
    <>
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
      {/* 追従リンクの◎ハンドル(人物へドラッグで「被写体を追う」を接続) */}
      <group
        position={[0, 0.42, -0.12]}
        onPointerDown={onLinkDown}
        onPointerMove={onLinkMove}
        onPointerUp={onLinkUp}
      >
        <mesh visible={false}>
          <sphereGeometry args={[0.32, 8, 6]} />
          <meshBasicMaterial />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.1, 0.03, 10, 24]} />
          <meshBasicMaterial color={linked ? "#22d3ee" : "#475569"} />
        </mesh>
        {linked && (
          <mesh>
            <sphereGeometry args={[0.045, 10, 8]} />
            <meshBasicMaterial color="#22d3ee" />
          </mesh>
        )}
      </group>
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
    {/* ドラッグ中のゴムバンド線(ワールド座標)。人物にスナップしたら太い玉で知らせる */}
    {linkDragging && linkCursor != null && (
      <>
        <Line
          points={[pose.position, linkCursor.point]}
          color="#22d3ee"
          lineWidth={2}
          dashed
          dashSize={0.15}
          gapSize={0.1}
        />
        <mesh position={linkCursor.point}>
          <sphereGeometry args={[linkCursor.snapId ? 0.14 : 0.06, 12, 8]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.9} />
        </mesh>
      </>
    )}
    </>
  );
}

/**
 * 追従リンクの常時可視化: 「被写体を追う」が接続されたカメラから相手へ水色の点線。
 * どのカメラが誰を追っているかを一目で示す(接続はカメラの◎ハンドルをドラッグ)
 */
function CameraFollowLinks() {
  const project = useScene3d((s) => s.project);
  return (
    <>
      {project.cameras.map((cam) => {
        const tid = cam.move.targetEntityId;
        if (tid == null) return null;
        const en = project.entities.find((e) => e.id === tid);
        if (!en) return null;
        const pose = evaluateShotCamera(
          project,
          { id: "__link", label: "", durationFrames: 2, cameraId: cam.id },
          0,
        );
        const to: Vec3 = [en.position[0], en.position[1] + 0.9, en.position[2]];
        return (
          <Line
            key={cam.id}
            points={[pose.position, to]}
            color="#22d3ee"
            lineWidth={1}
            dashed
            dashSize={0.12}
            gapSize={0.14}
            transparent
            opacity={0.45}
          />
        );
      })}
    </>
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
    if (heldKeys.has("z") || e.nativeEvent.shiftKey) {
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
  // 真珠の道がある時は真珠側(PathPearls)が軌道編集を担う
  if ((move.pathPoints?.length ?? 0) > 0) return null;

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
    if (heldKeys.has("z") || e.nativeEvent.shiftKey) {
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
  const motion = entity?.motion;
  // 倒れる・その場再生クリップ(speed 0)は行き先を持たないため旗を出さない
  const path = !motion
    ? []
    : motion.type === "fall"
      ? []
      : motion.type === "clip"
        ? (motion.speed ?? 0) > 0
          ? (motion.path ?? [])
          : []
        : motion.path;
  if (!entity || !motion || path.length === 0) {
    return null;
  }
  const dest = path[path.length - 1];
  const pathPoints: Vec3[] = [
    [entity.position[0], (entity.position[1] ?? 0) + 0.03, entity.position[2]],
    ...path.map((p): Vec3 => [p[0], (p[1] ?? 0) + 0.03, p[2]]),
  ];
  const color =
    motion.type === "run" ? "#fb923c" : motion.type === "clip" ? "#38bdf8" : "#a3e635";

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setDragging("__motion-target");
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!draggingSelf) return;
    const p = rayToFloor(e.ray);
    if (!p) return;
    // 行き先の高さは地形が決める(建物の上に旗を挿すと放物線で飛び乗る)
    const y = surfaceHeightAt(useScene3d.getState().project, p[0], p[2], entity.id);
    moveMotionTarget(entity.id, [p[0], y, p[2]]);
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
        position={[dest[0], dest[1] ?? 0, dest[2]]}
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
/**
 * 視点プリセットの受け手。単一変数だと後から開いたペインが独占し、
 * そのペインが閉じたとき null になってボタンが無反応になる(実害あり)ため Set で持つ
 */
const viewPresetListeners = new Set<(t: ViewPresetType) => void>();
export function requestViewPreset(t: ViewPresetType): void {
  viewPresetListeners.forEach((fn) => fn(t));
}

function ViewPresetController() {
  const { camera, controls } = useThree();
  useEffect(() => {
    const listener = (t: ViewPresetType) => {
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
        // 開始位置ではなく「いま見えている位置」(モーションで移動した先)を基準にする
        const pose = evaluateEntityPose(st.project, selEntity, st.currentFrame);
        target.set(
          pose.position[0],
          pose.position[1] + h * selEntity.scale,
          pose.position[2],
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
    viewPresetListeners.add(listener);
    return () => {
      viewPresetListeners.delete(listener);
    };
  }, [camera, controls]);
  return null;
}

/**
 * 道を手で描く: ビューポートの一筆書きでカメラ軌跡を作る。
 * 始点・終点は変えず、描いたストロークを数個の真珠に要約して滑らかな道として補完する。
 * 高さは始点→終点の高さを描いた位置に応じてなだらかに割り当てる(横の形は自由、縦は自動)
 */
function resampleStrokeToPearls(stroke: Vec3[], start: Vec3, end: Vec3): Vec3[] {
  if (stroke.length < 2) return [];
  const lens: number[] = [0];
  let total = 0;
  for (let i = 1; i < stroke.length; i++) {
    total += Math.hypot(
      stroke[i][0] - stroke[i - 1][0],
      stroke[i][1] - stroke[i - 1][1],
      stroke[i][2] - stroke[i - 1][2],
    );
    lens.push(total);
  }
  if (total < 0.5) return [];
  // 真珠の数: 道の長さに応じて2〜5個
  const K = Math.max(2, Math.min(5, Math.round(total / 2)));
  const out: Vec3[] = [];
  for (let k = 1; k <= K; k++) {
    const target = (total * k) / (K + 1);
    let j = 0;
    while (j < lens.length - 2 && lens[j + 1] < target) j++;
    const segLen = lens[j + 1] - lens[j];
    const u = segLen === 0 ? 0 : (target - lens[j]) / segLen;
    const t = k / (K + 1);
    const y = start[1] + (end[1] - start[1]) * t;
    out.push([
      Math.round((stroke[j][0] + (stroke[j + 1][0] - stroke[j][0]) * u) * 10) / 10,
      Math.round(y * 10) / 10,
      Math.round((stroke[j][2] + (stroke[j + 1][2] - stroke[j][2]) * u) * 10) / 10,
    ]);
  }
  return out;
}

function PathDrawOverlay() {
  const pathDrawMode = useScene3d((s) => s.pathDrawMode);
  const setPathDrawMode = useScene3d((s) => s.setPathDrawMode);
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const convertCameraToFreePath = useScene3d((s) => s.convertCameraToFreePath);
  const setDragging = useScene3d((s) => s.setDragging);
  const [stroke, setStroke] = useState<Vec3[]>([]);
  const drawing = useRef(false);

  // Escで中止
  useEffect(() => {
    if (!pathDrawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        drawing.current = false;
        setStroke([]);
        setPathDrawMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathDrawMode, setPathDrawMode]);

  if (!pathDrawMode) return null;
  const shot = getSelectedShot({ project, selectedShotId });
  const move = getShotMove(project, shot);
  // 描く平面の高さ: 始点と終点の中間(見た目のカーソル追従が素直になる)
  const drawY = (move.startPos[1] + move.endPos[1]) / 2;

  const finish = () => {
    drawing.current = false;
    setDragging(null);
    const pearls = resampleStrokeToPearls(stroke, move.startPos, move.endPos);
    if (pearls.length > 0) {
      convertCameraToFreePath(move.startPos, move.endPos, pearls);
    }
    setStroke([]);
    setPathDrawMode(false);
  };

  return (
    <>
      {/* 描画の受け皿(巨大な水平面。見えないがレイは受ける) */}
      <mesh
        visible={false}
        position={[0, drawY, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={(e) => {
          e.stopPropagation();
          drawing.current = true;
          setDragging("__path-draw");
          (e.target as Element).setPointerCapture(e.pointerId);
          const p = rayToPlaneY(e.ray, drawY);
          if (p) setStroke([p]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = rayToPlaneY(e.ray, drawY);
          if (!p) return;
          setStroke((prev) => {
            const last = prev[prev.length - 1];
            if (last && Math.hypot(p[0] - last[0], p[2] - last[2]) < 0.15) return prev;
            return [...prev, p];
          });
        }}
        onPointerUp={(e) => {
          if (!drawing.current) return;
          (e.target as Element).releasePointerCapture(e.pointerId);
          finish();
        }}
      >
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial />
      </mesh>
      {/* 描いている線 */}
      {stroke.length >= 2 && (
        <Line points={stroke} color="#f472b6" lineWidth={3} dashed={false} transparent opacity={0.9} />
      )}
      {/* 始点・終点の目印(ここは動かない) */}
      <mesh position={move.startPos}>
        <sphereGeometry args={[0.12, 12, 8]} />
        <meshBasicMaterial color="#4ade80" />
      </mesh>
      <mesh position={move.endPos}>
        <sphereGeometry args={[0.12, 12, 8]} />
        <meshBasicMaterial color="#f87171" />
      </mesh>
    </>
  );
}

/**
 * カーソルへ寄るホイールズーム(自前実装)。
 * OrbitControls標準のズームは「注視点までの残り%で刻む」ため近づくほど歩幅が縮み、
 * 最後は壁になって寄れない。ここでは常にカーソルの先へ最低歩幅を保証して進む
 * (Blenderのように被写体へ寄り切れる・通り抜けられる)。注視点も一緒に運ぶので
 * 以降の回転もカーソルで寄った場所が中心になる
 */
function CursorZoom({ enabled }: { enabled: boolean }) {
  const { camera, gl, controls } = useThree();
  const pointerNdc = useRef(new Vector2(0, 0));
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const el = gl.domElement;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointerNdc.current.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };
    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      const c = controls as unknown as { target: Vector3; update: () => void } | null;
      if (!c) return;
      // カーソル下のワールド点: 床(y=0)との交点。外れたら注視点までの距離の先
      const dir3 = new Vector3(pointerNdc.current.x, pointerNdc.current.y, 0.5)
        .unproject(camera)
        .sub(camera.position)
        .normalize();
      let point: Vector3;
      if (Math.abs(dir3.y) > 1e-4) {
        const t = -camera.position.y / dir3.y;
        point =
          t > 0.1 && t < 300
            ? camera.position.clone().addScaledVector(dir3, t)
            : camera.position.clone().addScaledVector(dir3, camera.position.distanceTo(c.target));
      } else {
        point = camera.position.clone().addScaledVector(dir3, camera.position.distanceTo(c.target));
      }
      const toPoint = point.clone().sub(camera.position);
      const dist = toPoint.length();
      if (dist < 1e-3) return;
      toPoint.normalize();
      const zoomIn = e.deltaY < 0;
      // 歩幅: 残り距離の12%。ただし最低0.12mを保証(=壁にならない)
      const step = Math.max(0.12, dist * 0.12) * (zoomIn ? 1 : -1);
      // ズームアウトの上限(迷子防止)
      if (!zoomIn && camera.position.distanceTo(c.target) > 80) return;
      camera.position.addScaledVector(toPoint, step);
      c.target.addScaledVector(toPoint, step);
      c.update();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("wheel", onWheel);
    };
  }, [camera, gl, controls]);
  return null;
}

function ViewportControls() {
  const dragging = useScene3d((s) => s.draggingEntityId != null);
  const playing = useScene3d((s) => s.playing);
  const cameraView = useScene3d((s) => s.cameraView);
  const splitView = useScene3d((s) => s.splitView);
  const pathDrawMode = useScene3d((s) => s.pathDrawMode);
  const enabled = !dragging && !pathDrawMode && (splitView || (!playing && !cameraView));
  return (
    <>
      <OrbitControls
        enabled={enabled}
        makeDefault
        // ズームは CursorZoom(カーソルへ寄る自前実装)が担う
        enableZoom={false}
      />
      <CursorZoom enabled={enabled} />
    </>
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
  const cameraSelected = useScene3d((s) => s.cameraSelected);
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
      {/* 軌道線・終点/中間ハンドルは「カメラを選んでいる間だけ」出す(触った物だけが語る) */}
      {!exporting && !isCameraPane && cameraSelected && <CameraPathLine />}
      {!exporting && !isCameraPane && <AllCameraIndicators />}
      {!exporting && !isCameraPane && <CameraFollowLinks />}
      {!exporting && !isCameraPane && <PathDrawOverlay />}
      {!exporting && !isCameraPane && cameraSelected && <CameraEndMarker />}
      {!exporting && !isCameraPane && cameraSelected && <CameraMidMarker />}
      {!exporting && !isCameraPane && cameraSelected && <PathPearls />}
      {!exporting && !isCameraPane && <MotionOverlay />}
      <CameraRig mode={mode} primary={primary} />
      {!isCameraPane && <ViewportControls />}
      {!isCameraPane && <ViewPresetController />}
      {primary && <ExportDriver />}
      {!exporting && !isCameraPane && (
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport
            // Blender流の呼び方に合わせ、縦軸(three.jsのY)を「Z」表示にする(内部座標は不変)
            labels={["X", "Z", "Y"]}
            axisColors={["#e88b8b", "#8ba7e8", "#8bc78b"]}
            labelColor="#ffffff"
          />
        </GizmoHelper>
      )}
    </Canvas>
  );
}
