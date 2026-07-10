/**
 * 3Dシーン演出 Workspace (Phase 0 スパイク)
 *
 * 「置く・動かす・撮る・繋ぐ・生成する」だけを見せる。
 * キーフレーム・XYZ数値・ボーンは出さない(初心者がBlenderで挫折する要素を排除)。
 *
 * UI原則(STΛCK指示 2026-07-10):
 *   - 絵文字を使わない(他スキルと同じフラットラインSVG)
 *   - 全部を見せない。選択肢はポップアップで視覚的に出す
 *   - スペースキー再生(停止で再生開始位置へ戻る) / 矢印キーでコマ送り
 *   - カメラの画では指定アスペクト比のフレーム内外をレターボックスで明示
 */

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { getShotMove, totalDurationFrames } from "../../../lib/scene3d/evaluateScene";
import {
  CAMERA_PRESET_LABELS,
  cameraColor,
  LENS_PRESETS_MM,
  SCENE_FPS,
  SEEDANCE_MAX_SECONDS,
} from "../../../lib/scene3d/types";
import type {
  CameraPresetId,
  SceneAspectRatio,
  SceneEntityKind,
  SceneShot,
} from "../../../lib/scene3d/types";
import {
  firstLeafId,
  getSelectedShot,
  redoScene3d,
  undoScene3d,
  useScene3d,
} from "../../../lib/store/scene3d";
import type { PaneNode } from "../../../lib/store/scene3d";
import { requestViewPreset, Scene3dViewport } from "./Scene3dViewport";

const PRESET_ORDER: CameraPresetId[] = [
  "fixed",
  "pushIn",
  "pullOut",
  "track",
  "pan",
  "orbit",
  "crane",
  "handheld",
];

const ASPECT_VALUES: Record<SceneAspectRatio, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};

/* ---------------------------------- 小さなSVGアイコン ---------------------------------- */

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
      aria-hidden
    >
      {children}
    </svg>
  );
}

const PlayIcon = () => (
  <Icon>
    <path d="M8 5l11 7-11 7V5z" />
  </Icon>
);
const StopIcon = () => (
  <Icon>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Icon>
);
const CameraViewIcon = () => (
  <Icon>
    <rect x="3" y="7" width="12" height="10" rx="2" />
    <path d="M15 10l6-3v10l-6-3" />
  </Icon>
);
const PersonIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="6" r="3" />
    <path d="M6 21v-2a6 6 0 0 1 12 0v2" />
  </Icon>
);
const SphereIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12c2.5 2 13.5 2 16 0" />
  </Icon>
);
const BoxIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
    <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" />
  </Icon>
);
const WallIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect x="3" y="8" width="18" height="10" />
    <path d="M3 13h18M9 8v5M15 13v5" />
  </Icon>
);
const ColumnIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M8 4h8M8 20h8M10 4v16M14 4v16" />
  </Icon>
);
const StairsIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 20h4v-4h4v-4h4V8h4" />
  </Icon>
);
const BuildingIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect x="7" y="4" width="10" height="17" />
    <path d="M10 8h1M13 8h1M10 12h1M13 12h1M10 16h1M13 16h1" />
  </Icon>
);

function EntityKindIcon({ kind, className }: { kind: SceneEntityKind; className?: string }) {
  switch (kind) {
    case "mannequin":
      return <PersonIcon className={className} />;
    case "sphere":
      return <SphereIcon className={className} />;
    case "box":
      return <BoxIcon className={className} />;
    case "wall":
      return <WallIcon className={className} />;
    case "column":
      return <ColumnIcon className={className} />;
    case "stairs":
      return <StairsIcon className={className} />;
    case "building":
      return <BuildingIcon className={className} />;
  }
}

/** カメラプリセットの動きを表すミニ図(被写体=点、矢印=カメラの動き) */
function PresetGlyph({ preset }: { preset: CameraPresetId }) {
  const cls = "h-8 w-12";
  switch (preset) {
    case "fixed":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="10" r="2" />
          <rect x="9" y="16" width="6" height="4" rx="1" />
        </Icon>
      );
    case "pushIn":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="7" r="2" />
          <path d="M12 20v-8M9.5 14.5L12 12l2.5 2.5" />
        </Icon>
      );
    case "pullOut":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="7" r="2" />
          <path d="M12 12v8M9.5 17.5L12 20l2.5-2.5" />
        </Icon>
      );
    case "track":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="8" r="2" />
          <path d="M4 17h16M17 14.5L19.5 17 17 19.5" />
        </Icon>
      );
    case "pan":
      return (
        <Icon className={cls}>
          <rect x="9" y="14" width="6" height="5" rx="1" />
          <path d="M7 9a9 5 0 0 1 10 0M14.5 8L17 9l-1 2.5" />
        </Icon>
      );
    case "orbit":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="12" r="2" />
          <path d="M4.5 14a8 5 0 1 1 6 3.5M8 19.5L10.5 17.5 12.5 20" />
        </Icon>
      );
    case "crane":
      return (
        <Icon className={cls}>
          <circle cx="9" cy="17" r="2" />
          <path d="M6 20L18 7M15.5 7.5L18 7l-.5 2.5" />
        </Icon>
      );
    case "handheld":
      return (
        <Icon className={cls}>
          <path d="M4 14c2-2 4 2 6 0s4 2 6 0 4 2 4 0" />
          <rect x="9" y="6" width="6" height="4" rx="1" />
        </Icon>
      );
  }
}

/* ---------------------------------- 汎用ポップアップ ---------------------------------- */

function Popup({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[440px] overflow-y-auto rounded-xl border border-[#2a2a2a] bg-[#141414] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-neutral-200">{title}</p>
          <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------- 置く(ポップアップ) ---------------------------------- */

function ObjectPickerPopup({ onClose }: { onClose: () => void }) {
  const addEntity = useScene3d((s) => s.addEntity);
  const pick = (kind: SceneEntityKind) => {
    addEntity(kind);
    onClose();
  };
  const card =
    "flex flex-col items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#161616] p-4 text-neutral-300 hover:border-amber-500/60 hover:text-amber-300";
  const items: { kind: SceneEntityKind; label: string }[] = [
    { kind: "mannequin", label: "人物" },
    { kind: "sphere", label: "球" },
    { kind: "box", label: "箱" },
  ];
  const arch: { kind: SceneEntityKind; label: string }[] = [
    { kind: "wall", label: "壁" },
    { kind: "column", label: "柱" },
    { kind: "stairs", label: "階段" },
    { kind: "building", label: "ビル" },
  ];
  return (
    <Popup title="シーンに置く" onClose={onClose}>
      <p className="mb-2 text-[11px] font-bold tracking-wide text-neutral-500">基本</p>
      <div className="grid grid-cols-3 gap-2">
        {items.map((it) => (
          <button key={it.kind} className={card} onClick={() => pick(it.kind)}>
            <EntityKindIcon kind={it.kind} className="h-10 w-10" />
            <span className="text-xs">{it.label}</span>
          </button>
        ))}
      </div>
      <p className="mb-2 mt-4 text-[11px] font-bold tracking-wide text-neutral-500">建築</p>
      <div className="grid grid-cols-4 gap-2">
        {arch.map((it) => (
          <button key={it.kind} className={card} onClick={() => pick(it.kind)}>
            <EntityKindIcon kind={it.kind} className="h-10 w-10" />
            <span className="text-xs">{it.label}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-4 text-neutral-500">
        置いたあとはビューポート上でドラッグして好きな場所へ動かせます。ビルは選択すると階数を変えられます
      </p>
    </Popup>
  );
}

/* ---------------------------------- カメラの動き(ポップアップ) ---------------------------------- */

function PresetPickerPopup({ onClose }: { onClose: () => void }) {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const setCameraPreset = useScene3d((s) => s.setCameraPreset);
  const current = getShotMove(project, getSelectedShot({ project, selectedShotId })).preset;

  const pick = (preset: CameraPresetId) => {
    setCameraPreset(preset);
    onClose();
  };

  const DESCRIPTIONS: Record<CameraPresetId, string> = {
    fixed: "動かさず据え置き",
    pushIn: "被写体へ近づく",
    pullOut: "被写体から離れる",
    track: "横に並走する",
    pan: "位置は固定で流す",
    orbit: "周囲を回り込む",
    crane: "上昇しながら見下ろす",
    handheld: "手持ち風の揺れ",
  };

  return (
    <Popup title="カメラの動きを選ぶ" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        {PRESET_ORDER.map((preset) => (
          <button
            key={preset}
            className={`flex items-center gap-3 rounded-md border p-3 text-left ${
              current === preset
                ? "border-pink-400 bg-pink-500/10"
                : "border-[#2a2a2a] bg-[#161616] hover:border-pink-400/60"
            }`}
            onClick={() => pick(preset)}
          >
            <span className={current === preset ? "text-pink-300" : "text-neutral-400"}>
              <PresetGlyph preset={preset} />
            </span>
            <span>
              <span
                className={`block text-xs font-medium ${
                  current === preset ? "text-pink-200" : "text-neutral-200"
                }`}
              >
                {CAMERA_PRESET_LABELS[preset]}
              </span>
              <span className="block text-[10px] text-neutral-500">
                {DESCRIPTIONS[preset]}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Popup>
  );
}

/* ---------------------------------- 左パネル ---------------------------------- */

function ShelfPanel() {
  const project = useScene3d((s) => s.project);
  const entities = useScene3d((s) => s.project.entities);
  const shots = useScene3d((s) => s.project.shots);
  const cameras = useScene3d((s) => s.project.cameras);
  const selectedId = useScene3d((s) => s.selectedEntityId);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const selectEntity = useScene3d((s) => s.selectEntity);
  const selectCameraOfShot = useScene3d((s) => s.selectCameraOfShot);
  const assignShotCamera = useScene3d((s) => s.assignShotCamera);
  const addCamera = useScene3d((s) => s.addCamera);
  const removeCamera = useScene3d((s) => s.removeCamera);
  const removeEntity = useScene3d((s) => s.removeEntity);
  const selectedCameraId = getSelectedShot({ project, selectedShotId }).cameraId;
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <aside className="flex w-full flex-col gap-4 border-r border-[#242424] bg-[#141414] px-4 py-4">
      <button
        className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-sm text-neutral-200 hover:border-amber-500/60"
        onClick={() => setPickerOpen(true)}
      >
        + シーンに置く
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 text-[11px] font-bold tracking-wide text-neutral-500">シーン内</p>
        <ul className="flex flex-col gap-1">
          {entities.map((e) => (
            <li
              key={e.id}
              className={`group flex items-center justify-between rounded px-2 py-1.5 text-sm ${
                selectedId === e.id
                  ? "bg-amber-500/15 text-amber-300"
                  : "text-neutral-300 hover:bg-[#101010]"
              }`}
            >
              <button
                className="flex flex-1 items-center gap-2 text-left"
                onClick={() => selectEntity(e.id)}
              >
                <EntityKindIcon kind={e.kind} />
                {e.label}
              </button>
              <button
                className="hidden text-neutral-500 hover:text-red-400 group-hover:block"
                onClick={() => removeEntity(e.id)}
                title="削除"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        <p className="mb-2 mt-4 text-[11px] font-bold tracking-wide text-neutral-500">カメラ</p>
        <ul className="flex flex-col gap-1">
          {cameras.map((cam) => {
            const usingShots = shots.filter((sh) => sh.cameraId === cam.id);
            const isActive = selectedCameraId === cam.id;
            return (
              <li key={cam.id} className="group/cam relative">
                <button
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                    isActive ? "bg-amber-500/15 text-amber-300" : "text-neutral-300 hover:bg-[#101010]"
                  }`}
                  onClick={() => {
                    const first = usingShots[0];
                    if (first) selectCameraOfShot(first.id);
                    else assignShotCamera(selectedShotId, cam.id);
                  }}
                  title={
                    usingShots.length > 0
                      ? "クリックでこのカメラを使うカットを選択"
                      : "クリックで選択中カットにこのカメラを割当"
                  }
                >
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: cameraColor(project, cam.id) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{cam.label}</span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {usingShots.length > 0 ? `${usingShots.length}カット` : "未使用"}
                  </span>
                </button>
                {usingShots.length === 0 && cameras.length > 1 && (
                  <button
                    className="absolute right-1 top-1.5 hidden text-[10px] text-neutral-500 hover:text-red-400 group-hover/cam:block"
                    onClick={() => removeCamera(cam.id)}
                    title="このカメラを削除"
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <button
          className="mt-1.5 w-full rounded-lg border border-dashed border-[#3a3a3a] px-2 py-1.5 text-xs text-neutral-500 hover:border-pink-400/60 hover:text-pink-300"
          onClick={addCamera}
          title="カメラを追加して、そのカメラを使う新しいカットを末尾に作る"
        >
          + カメラを追加(マルチカム)
        </button>
      </div>

      {pickerOpen && <ObjectPickerPopup onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}

/* ---------------------------------- 右パネル(監督) ---------------------------------- */

/** 数値入力(位置・寸法用の小さな共通部品) */
function NumField({
  label,
  value,
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-neutral-400">
      <span className="w-8 shrink-0">{label}</span>
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-full rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1 text-xs text-neutral-200 focus:border-pink-400/60 focus:outline-none"
      />
    </label>
  );
}

/** 軸スライダー(値表示つき) */
function AxisSlider({
  label,
  value,
  min,
  max,
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="w-6 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(1))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        className="w-14 shrink-0 rounded border border-[#2a2a2a] bg-[#0d0d0d] px-1 py-0.5 text-right text-xs tabular-nums text-neutral-300 focus:border-pink-400/60 focus:outline-none"
      />
    </label>
  );
}

/** 選択中オブジェクトのプロパティ(選択物の種類でフィールドが変わる) */
function SelectedObjectSection() {
  const project = useScene3d((s) => s.project);
  const selectedEntityId = useScene3d((s) => s.selectedEntityId);
  const moveEntity = useScene3d((s) => s.moveEntity);
  const rotateEntity = useScene3d((s) => s.rotateEntity);
  const scaleEntity = useScene3d((s) => s.scaleEntity);
  const setEntityFloors = useScene3d((s) => s.setEntityFloors);
  const setEntityParam = useScene3d((s) => s.setEntityParam);

  const entity = project.entities.find((e) => e.id === selectedEntityId);
  if (!entity) return null;

  const degrees = ((Math.round((entity.rotationY * 180) / Math.PI) % 360) + 360) % 360;
  const kind = entity.kind;
  const p = entity.params ?? {};

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <p className="flex items-center gap-2 text-[11px] font-bold tracking-wide text-amber-400/90">
        <EntityKindIcon kind={kind} />
        {entity.label}
      </p>

      {/* 位置(床面のX/Z)。スライダーで軸ごとの平行移動 */}
      <div className="flex flex-col gap-1.5">
        <AxisSlider
          label="横"
          value={entity.position[0]}
          min={-15}
          max={15}
          onChange={(v) => moveEntity(entity.id, [v, entity.position[1], entity.position[2]])}
        />
        <AxisSlider
          label="奥"
          value={entity.position[2]}
          min={-15}
          max={15}
          onChange={(v) => moveEntity(entity.id, [entity.position[0], entity.position[1], v])}
        />
      </div>

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        向き: {degrees}°
        <input
          type="range"
          min={0}
          max={360}
          step={15}
          value={degrees}
          onChange={(e) => rotateEntity(entity.id, (Number(e.target.value) * Math.PI) / 180)}
        />
      </label>

      {/* 種類別フィールド */}
      {(kind === "mannequin" || kind === "sphere" || kind === "column" || kind === "stairs") && (
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          大きさ: {entity.scale.toFixed(1)}x
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.1}
            value={entity.scale}
            onChange={(e) => scaleEntity(entity.id, Number(e.target.value))}
          />
        </label>
      )}

      {kind === "wall" && (
        <div className="grid grid-cols-2 gap-1.5">
          <NumField
            label="横幅"
            value={p.width ?? 3}
            onChange={(v) => setEntityParam(entity.id, "width", v)}
          />
          <NumField
            label="高さ"
            value={p.height ?? 2.6}
            onChange={(v) => setEntityParam(entity.id, "height", v)}
          />
        </div>
      )}

      {kind === "box" && (
        <div className="grid grid-cols-3 gap-1.5">
          <NumField
            label="横幅"
            value={p.width ?? 0.8}
            onChange={(v) => setEntityParam(entity.id, "width", v)}
          />
          <NumField
            label="高さ"
            value={p.height ?? 0.8}
            onChange={(v) => setEntityParam(entity.id, "height", v)}
          />
          <NumField
            label="奥行"
            value={p.depth ?? 0.8}
            onChange={(v) => setEntityParam(entity.id, "depth", v)}
          />
        </div>
      )}

      {kind === "building" && (
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          階数: {p.floors ?? 3}階
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={p.floors ?? 3}
            onChange={(e) => setEntityFloors(entity.id, Number(e.target.value))}
          />
        </label>
      )}
    </div>
  );
}

function DirectorPanel() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const setCameraTarget = useScene3d((s) => s.setCameraTarget);
  const setLens = useScene3d((s) => s.setLens);
  const setOrbitDegrees = useScene3d((s) => s.setOrbitDegrees);
  const setShotDurationFrames = useScene3d((s) => s.setShotDurationFrames);
  const setAspectRatio = useScene3d((s) => s.setAspectRatio);
  const moveCameraEndpoint = useScene3d((s) => s.moveCameraEndpoint);
  const [presetOpen, setPresetOpen] = useState(false);

  const assignShotCamera = useScene3d((s) => s.assignShotCamera);
  const shot = getSelectedShot({ project, selectedShotId });
  const camera = getShotMove(project, shot);
  const usingCamera = project.cameras.find((c) => c.id === shot.cameraId) ?? project.cameras[0];
  const usedCount = project.shots.filter((sh) => sh.cameraId === shot.cameraId).length;

  return (
    <aside className="flex w-full flex-col gap-5 overflow-y-auto border-l border-[#242424] bg-[#141414] px-4 py-4">
      <SelectedObjectSection />
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-neutral-500">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: cameraColor(project, shot.cameraId) }}
          />
          {shot.label} — {usingCamera.label}
          {usedCount > 1 && (
            <span className="font-normal text-neutral-600">({usedCount}カットで使用)</span>
          )}
        </p>
        <label className="mb-2 flex flex-col gap-1 text-xs text-neutral-400">
          このカットで使うカメラ
          <select
            className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-sm text-neutral-200"
            value={shot.cameraId}
            onChange={(e) => assignShotCamera(shot.id, e.target.value)}
          >
            {project.cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="flex w-full items-center gap-3 rounded-md border border-[#2a2a2a] bg-[#101010] p-2.5 text-left hover:border-pink-400/60"
          onClick={() => setPresetOpen(true)}
        >
          <span className="text-pink-300">
            <PresetGlyph preset={camera.preset} />
          </span>
          <span>
            <span className="block text-sm text-neutral-200">
              {CAMERA_PRESET_LABELS[camera.preset]}
            </span>
            <span className="block text-[10px] text-neutral-500">クリックで動きを変更</span>
          </span>
        </button>
        <p className="mt-2 text-[11px] leading-4 text-neutral-500">
          緑=開始 / 赤=終了 / 水色の線=カメラの通り道
        </p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        被写体
        <select
          className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-sm text-neutral-200"
          value={camera.targetEntityId ?? ""}
          onChange={(e) => setCameraTarget(e.target.value || null)}
        >
          <option value="">(なし — 中央を見る)</option>
          {project.entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1.5 rounded-lg border border-[#2a2a2a] bg-[#101010] p-2.5">
        <p className="text-[10px] font-bold tracking-wide text-neutral-500">
          カメラ開始位置(緑のカメラ)
        </p>
        <AxisSlider
          label="横"
          value={camera.startPos[0]}
          min={-15}
          max={15}
          onChange={(v) => moveCameraEndpoint("start", [v, camera.startPos[1], camera.startPos[2]])}
        />
        <AxisSlider
          label="高さ"
          value={camera.startPos[1]}
          min={0.1}
          max={12}
          onChange={(v) => moveCameraEndpoint("start", [camera.startPos[0], v, camera.startPos[2]])}
        />
        <AxisSlider
          label="奥"
          value={camera.startPos[2]}
          min={-15}
          max={15}
          onChange={(v) => moveCameraEndpoint("start", [camera.startPos[0], camera.startPos[1], v])}
        />
        {camera.preset !== "fixed" && camera.preset !== "orbit" && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">
              カメラ終了位置(赤点)
            </p>
            <AxisSlider
              label="横"
              value={camera.endPos[0]}
              min={-15}
              max={15}
              onChange={(v) => moveCameraEndpoint("end", [v, camera.endPos[1], camera.endPos[2]])}
            />
            <AxisSlider
              label="高さ"
              value={camera.endPos[1]}
              min={0.1}
              max={12}
              onChange={(v) => moveCameraEndpoint("end", [camera.endPos[0], v, camera.endPos[2]])}
            />
            <AxisSlider
              label="奥"
              value={camera.endPos[2]}
              min={-15}
              max={15}
              onChange={(v) => moveCameraEndpoint("end", [camera.endPos[0], camera.endPos[1], v])}
            />
          </>
        )}
      </div>

      <div className="flex flex-col gap-1 text-xs text-neutral-400">
        レンズ
        <div className="grid grid-cols-3 gap-1">
          {LENS_PRESETS_MM.map((mm) => (
            <button
              key={mm}
              className={`rounded-lg border px-1.5 py-1 text-xs ${
                camera.lensMm === mm
                  ? "border-pink-400 bg-pink-500/10 text-pink-300"
                  : "border-[#2a2a2a] bg-[#101010] text-neutral-300"
              }`}
              onClick={() => setLens(mm)}
            >
              {mm}mm
            </button>
          ))}
        </div>
      </div>

      {camera.preset === "orbit" && (
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          回り込み角度: {camera.orbitDegrees}°
          <input
            type="range"
            min={-360}
            max={360}
            step={15}
            value={camera.orbitDegrees}
            onChange={(e) => setOrbitDegrees(Number(e.target.value))}
          />
        </label>
      )}

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        このカットの秒数: {(shot.durationFrames / SCENE_FPS).toFixed(1)}秒
        <input
          type="range"
          min={1}
          max={15}
          step={0.5}
          value={shot.durationFrames / SCENE_FPS}
          onChange={(e) => setShotDurationFrames(shot.id, Number(e.target.value) * SCENE_FPS)}
        />
      </label>

      <div className="flex flex-col gap-1 text-xs text-neutral-400">
        フレーム(書き出しの画角)
        <div className="grid grid-cols-3 gap-1">
          {(Object.keys(ASPECT_VALUES) as SceneAspectRatio[]).map((ratio) => (
            <button
              key={ratio}
              className={`rounded-lg border px-1.5 py-1 text-xs ${
                project.aspectRatio === ratio
                  ? "border-pink-400 bg-pink-500/10 text-pink-300"
                  : "border-[#2a2a2a] bg-[#101010] text-neutral-300"
              }`}
              onClick={() => setAspectRatio(ratio)}
            >
              {ratio}
            </button>
          ))}
        </div>
      </div>

      <ExportSection />
      {presetOpen && <PresetPickerPopup onClose={() => setPresetOpen(false)} />}
    </aside>
  );
}

function ExportSection() {
  const status = useScene3d((s) => s.exportStatus);
  const requestExport = useScene3d((s) => s.requestExport);
  const project = useScene3d((s) => s.project);
  const busy = status.phase === "rendering" || status.phase === "encoding";

  const totalSec = totalDurationFrames(project) / SCENE_FPS;
  const overLimit = totalSec > SEEDANCE_MAX_SECONDS;

  const revealInFinder = async (path: string) => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  };

  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-[#242424] pt-3">
      <p className="text-[11px] font-bold tracking-wide text-neutral-500">生成する</p>
      {overLimit && (
        <p className="text-[11px] leading-4 text-amber-400">
          合計{totalSec.toFixed(1)}秒。Seedanceの1回上限は{SEEDANCE_MAX_SECONDS}秒のため、
          このままだと章分割(複数回生成)が必要です
        </p>
      )}
      <button
        className="rounded-xl bg-pink-500 px-3 py-2.5 text-[13px] font-bold text-white transition hover:bg-pink-400 disabled:opacity-50"
        disabled={busy}
        onClick={requestExport}
      >
        {busy ? "書き出し中…" : "モーションガイドを書き出す"}
      </button>

      {status.phase === "rendering" && (
        <p className="text-[11px] text-neutral-400">
          フレーム描画中 {status.done}/{status.total}
        </p>
      )}
      {status.phase === "encoding" && (
        <p className="text-[11px] text-neutral-400">MP4に変換中…</p>
      )}
      {status.phase === "done" && (
        <div className="flex flex-col gap-1 text-[11px] text-neutral-400">
          {status.mp4Path ? (
            <>
              <p className="text-emerald-400">motion-guide.mp4 完成(全カット連結)</p>
              <button
                className="rounded-lg border border-[#2a2a2a] px-2 py-1 text-left text-neutral-300 hover:border-neutral-500"
                onClick={() => void revealInFinder(status.mp4Path!)}
              >
                Finderで表示
              </button>
            </>
          ) : (
            <>
              <p className="text-amber-400">
                PNG連番まで書き出しました(ffmpeg未検出のためMP4変換はスキップ)
              </p>
              <button
                className="rounded-lg border border-[#2a2a2a] px-2 py-1 text-left text-neutral-300 hover:border-neutral-500"
                onClick={() => void revealInFinder(status.framesDir)}
              >
                フォルダを表示
              </button>
            </>
          )}
        </div>
      )}
      {status.phase === "error" && (
        <p className="text-[11px] text-red-400">書き出し失敗: {status.message}</p>
      )}
      <p className="text-[11px] leading-4 text-neutral-500">
        書き出した動画は動画生成AIの「参照動画」として、開始フレームPNGは「開始画像」として使います
      </p>
    </div>
  );
}

/* ---------------------------------- タイムライン ---------------------------------- */

/** レーンの高さ(px)。カメラ1台=1レーン */
const LANE_H = 50;

type ShotSegment = {
  shot: SceneShot;
  index: number;
  startFrame: number;
};

/**
 * レーン上の1クリップ(絶対配置: 左端=開始時刻、幅=尺)。
 * - クリック: 選択 / 右端ドラッグ: 尺変更
 * - 本体ドラッグ: 横=並び替え(時間順) / 縦=別カメラのレーンへ移動(カメラ切替)
 */
function LaneClip({
  seg,
  laneIndex,
  segs,
  ppf,
}: {
  seg: ShotSegment;
  laneIndex: number;
  segs: ShotSegment[];
  ppf: number;
}) {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const selectShot = useScene3d((s) => s.selectShot);
  const removeShot = useScene3d((s) => s.removeShot);
  const reorderShots = useScene3d((s) => s.reorderShots);
  const assignShotCamera = useScene3d((s) => s.assignShotCamera);
  const setShotDurationFrames = useScene3d((s) => s.setShotDurationFrames);

  const { shot, startFrame } = seg;
  const selected = selectedShotId === shot.id;
  const move = getShotMove(project, shot);
  const clipColor = cameraColor(project, shot.cameraId);
  const leftPx = startFrame * ppf;
  const widthPx = Math.max(6, shot.durationFrames * ppf); // 幅=時間を厳密一致(最小6pxは掴み代)

  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const resizeState = useRef<{ startX: number; startFrames: number } | null>(null);

  const onBodyDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    selectShot(shot.id);
    dragStart.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onBodyMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    setDrag({ dx: e.clientX - dragStart.current.x, dy: e.clientY - dragStart.current.y });
  };
  const onBodyUp = (e: React.PointerEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    if (!start || !drag) return;
    const { dx, dy } = drag;
    setDrag(null);
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return; // クリック扱い

    // 縦: レーン移動 = カメラ切替
    const laneDelta = Math.round(dy / LANE_H);
    const targetLane = Math.max(0, Math.min(project.cameras.length - 1, laneIndex + laneDelta));
    if (targetLane !== laneIndex) {
      assignShotCamera(shot.id, project.cameras[targetLane].id);
    }
    // 横: 並び替え(移動後の中心が入る位置のカットと入替)
    const center = leftPx + dx + widthPx / 2;
    const targetSeg = segs.find(
      (sg) => center >= sg.startFrame * ppf && center < (sg.startFrame + sg.shot.durationFrames) * ppf,
    );
    if (targetSeg && targetSeg.shot.id !== shot.id) {
      reorderShots(shot.id, targetSeg.shot.id);
    }
  };

  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeState.current = { startX: e.clientX, startFrames: shot.durationFrames };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeState.current) return;
    const dx = e.clientX - resizeState.current.startX;
    setShotDurationFrames(shot.id, resizeState.current.startFrames + dx / ppf);
  };
  const onResizeUp = (e: React.PointerEvent) => {
    resizeState.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      style={{
        left: leftPx,
        width: widthPx,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
        zIndex: drag ? 30 : selected ? 10 : 1,
        borderColor: selected ? clipColor : "#2a2a2a",
      }}
      className={`group absolute top-0.5 flex h-[46px] cursor-grab select-none flex-col overflow-hidden rounded-md border bg-[#161616] ${
        selected ? "ring-1" : "hover:brightness-125"
      }`}
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={onBodyUp}
    >
      {/* 色帯(カメラ識別色) */}
      <div className="h-1 w-full shrink-0" style={{ backgroundColor: clipColor }} />
      <div className="flex min-h-0 flex-1 flex-col justify-center px-1.5">
        <p className={`truncate text-[11px] font-medium ${selected ? "text-white" : "text-neutral-300"}`}>
          {(shot.durationFrames / SCENE_FPS).toFixed(1)}s
        </p>
        <p className="truncate text-[9px]" style={{ color: clipColor }}>
          {CAMERA_PRESET_LABELS[move.preset]}
        </p>
      </div>
      {segs.length > 1 && (
        <button
          className="absolute right-0.5 top-1 hidden text-[10px] text-neutral-500 hover:text-red-400 group-hover:block"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            removeShot(shot.id);
          }}
          title="リップル削除"
        >
          ✕
        </button>
      )}
      <div
        className="absolute -right-0.5 top-0 h-full w-2 cursor-ew-resize bg-pink-400/0 hover:bg-pink-400/60"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
    </div>
  );
}

/**
 * マルチカム・タイムライン: カメラごとのレーンが同じ時間軸に積み重なる。
 * クリップを上下ドラッグでカメラ切替、左右ドラッグで並び替え、右端で尺変更
 */
function ShotTimeline() {
  const project = useScene3d((s) => s.project);
  const playing = useScene3d((s) => s.playing);
  const cameraView = useScene3d((s) => s.cameraView);
  const currentFrame = useScene3d((s) => s.currentFrame);
  const togglePlay = useScene3d((s) => s.togglePlay);
  const setCameraView = useScene3d((s) => s.setCameraView);
  const splitView = useScene3d((s) => s.splitView);
  const toggleSplitView = useScene3d((s) => s.toggleSplitView);
  const setCurrentFrame = useScene3d((s) => s.setCurrentFrame);
  const setPlaying = useScene3d((s) => s.setPlaying);
  const addShot = useScene3d((s) => s.addShot);
  const addCamera = useScene3d((s) => s.addCamera);
  const removeShot = useScene3d((s) => s.removeShot);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const shotCount = useScene3d((s) => s.project.shots.length);
  const splitShotAtPlayhead = useScene3d((s) => s.splitShotAtPlayhead);
  const zoom = useScene3d((s) => s.timelineZoom);
  const setTimelineZoom = useScene3d((s) => s.setTimelineZoom);
  const selectCameraOfShot = useScene3d((s) => s.selectCameraOfShot);

  const ppf = zoom / SCENE_FPS;
  const totalFrames = totalDurationFrames(project);
  const totalSec = totalFrames / SCENE_FPS;
  const playheadX = Math.min(currentFrame, totalFrames - 1) * ppf;
  const scrubbing = useRef(false);

  const [bodyH, setBodyH] = useState(() => {
    const saved = Number(localStorage.getItem("scene3d.timeline.h"));
    return Number.isFinite(saved) && saved >= 64 && saved <= 360 ? saved : 150;
  });
  const heightState = useRef<{ startY: number; startH: number } | null>(null);
  const updateBodyH = (h: number) => {
    const clamped = Math.max(64, Math.min(360, Math.round(h)));
    setBodyH(clamped);
    localStorage.setItem("scene3d.timeline.h", String(clamped));
  };

  // 通し位置つきセグメント
  const segs: ShotSegment[] = [];
  {
    let acc = 0;
    project.shots.forEach((shot, index) => {
      segs.push({ shot, index, startFrame: acc });
      acc += shot.durationFrames;
    });
  }
  const contentW = Math.max(totalFrames * ppf + 120, 400);

  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setPlaying(false);
    setCurrentFrame(Math.max(0, Math.min(totalFrames - 1, x / ppf)));
  };

  return (
    <div className="flex flex-col border-t border-[#242424] bg-[#141414]">
      {/* 高さ調整ハンドル(上端) */}
      <div
        className="group flex h-1.5 w-full cursor-row-resize items-center justify-center hover:bg-pink-400/25"
        onPointerDown={(e) => {
          heightState.current = { startY: e.clientY, startH: bodyH };
          (e.target as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!heightState.current) return;
          updateBodyH(heightState.current.startH - (e.clientY - heightState.current.startY));
        }}
        onPointerUp={(e) => {
          heightState.current = null;
          (e.target as Element).releasePointerCapture(e.pointerId);
        }}
      >
        <div className="h-0.5 w-10 rounded bg-[#3a3a3a] group-hover:bg-pink-300" />
      </div>

      {/* トランスポート行 */}
      <div className="flex min-w-0 items-center gap-3 overflow-hidden px-4 pt-1">
        <button
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
            playing
              ? "border-red-400/50 bg-red-500/10 text-red-300"
              : "border-[#343434] bg-[#101010] text-neutral-200 hover:border-pink-400"
          }`}
          onClick={togglePlay}
          title="スペースキーでも再生/停止(停止で再生開始位置に戻る)"
        >
          {playing ? <StopIcon /> : <PlayIcon />}
          {playing ? "停止" : "再生"}
        </button>
        <button
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
            cameraView
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-[#2a2a2a] text-neutral-400"
          }`}
          onClick={() => setCameraView(!cameraView)}
          title="撮影カメラの画で確認(全画面)"
        >
          <CameraViewIcon />
          カメラの画
        </button>
        <button
          className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
            splitView
              ? "border-pink-400 bg-pink-500/10 text-pink-300"
              : "border-[#2a2a2a] text-neutral-400"
          }`}
          onClick={toggleSplitView}
          title="編集ビューとカメラの画を並べて表示"
        >
          2画面
        </button>
        <span className="mx-1 h-5 w-px shrink-0 bg-[#2a2a2a]" />
        <button
          className="flex items-center gap-1.5 rounded-lg border border-[#2a2a2a] px-3 py-1.5 text-[13px] font-semibold text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200"
          onClick={splitShotAtPlayhead}
          title="再生ヘッド位置でカットを2分割"
        >
          <Icon className="h-4 w-4">
            <circle cx="6" cy="7" r="2.5" />
            <circle cx="6" cy="17" r="2.5" />
            <path d="M8.2 8.5L20 19M8.2 15.5L20 5" />
          </Icon>
          カット
        </button>
        <button
          className="flex items-center gap-1.5 rounded-lg border border-[#2a2a2a] px-3 py-1.5 text-[13px] font-semibold text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200 disabled:opacity-40"
          disabled={shotCount <= 1}
          onClick={() => removeShot(selectedShotId)}
          title="選択カットをリップル削除"
        >
          <Icon className="h-4 w-4">
            <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M14 12l-4 5M10 12l4 5" />
          </Icon>
          リップル削除
        </button>
        <button
          className="flex items-center gap-1.5 rounded-lg border border-[#2a2a2a] px-3 py-1.5 text-[13px] font-semibold text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200"
          onClick={addShot}
          title="選択カットを複製して後ろに追加"
        >
          <Icon className="h-4 w-4">
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 4H6a2 2 0 0 0-2 2v10" />
          </Icon>
          複製
        </button>
        {/* ズームスライダー */}
        <label className="ml-2 flex shrink-0 items-center gap-1.5 text-[10px] text-neutral-500">
          ズーム
          <input
            type="range"
            min={8}
            max={120}
            step={2}
            value={zoom}
            onChange={(e) => setTimelineZoom(Number(e.target.value))}
            className="w-24"
          />
        </label>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-neutral-400">
          {(currentFrame / SCENE_FPS).toFixed(1)}s / 合計 {totalSec.toFixed(1)}s
          {totalSec > SEEDANCE_MAX_SECONDS && (
            <span className="ml-1 text-amber-400">(上限{SEEDANCE_MAX_SECONDS}s超)</span>
          )}
        </span>
      </div>

      {/* レーン領域: 左=カメラ名の欄 / 右=時間軸スクロール */}
      <div style={{ height: bodyH }} className="flex min-w-0 overflow-y-auto px-4 pb-2 pt-1">
        {/* レーン名の欄(スクロールしない) */}
        <div className="mr-1 flex w-20 shrink-0 flex-col">
          <div className="h-5 shrink-0" />
          {project.cameras.map((cam) => (
            <button
              key={cam.id}
              style={{ height: LANE_H }}
              className="flex items-center gap-1.5 truncate rounded-l px-1.5 text-left text-[10px] text-neutral-400 hover:bg-[#101010]"
              onClick={() => {
                const first = project.shots.find((sh) => sh.cameraId === cam.id);
                if (first) selectCameraOfShot(first.id);
              }}
              title={cam.label}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: cameraColor(project, cam.id) }}
              />
              <span className="truncate">{cam.label}</span>
            </button>
          ))}
          <button
            className="mt-1 rounded border border-dashed border-[#3a3a3a] px-1 py-1 text-[10px] text-neutral-500 hover:border-pink-400/60 hover:text-pink-300"
            onClick={addCamera}
            title="カメラを追加(レーンが増える)"
          >
            + カメラ
          </button>
        </div>

        {/* 時間軸スクロール領域 */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ width: contentW }}>
            {/* 1秒ごとの縦グリッド線 */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, #26262a 0 1px, transparent 1px ${zoom}px)`,
              }}
            />
            {/* ルーラー(クリック/ドラッグでスクラブ) */}
            <div
              className="relative h-5 cursor-col-resize"
              onPointerDown={(e) => {
                scrubbing.current = true;
                (e.target as Element).setPointerCapture(e.pointerId);
                scrubTo(e);
              }}
              onPointerMove={(e) => {
                if (scrubbing.current) scrubTo(e);
              }}
              onPointerUp={() => {
                scrubbing.current = false;
              }}
            >
              {Array.from({ length: Math.ceil(totalSec) + 2 }, (_, i) => (
                <span
                  key={i}
                  className="absolute top-0 border-l border-[#3a3a3a] pl-0.5 text-[9px] text-neutral-500"
                  style={{ left: i * zoom }}
                >
                  {i}s
                </span>
              ))}
            </div>

            {/* カメラレーン(同じ時間軸に積層) */}
            {project.cameras.map((cam, laneIndex) => (
              <div
                key={cam.id}
                style={{ height: LANE_H }}
                className="relative border-b border-[#1d1d1d]"
              >
                {/* レーンの帯(カメラ色のうっすら背景) */}
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{ backgroundColor: `${cameraColor(project, cam.id)}0d` }}
                />
                {segs
                  .filter((sg) => sg.shot.cameraId === cam.id)
                  .map((sg) => (
                    <LaneClip key={sg.shot.id} seg={sg} laneIndex={laneIndex} segs={segs} ppf={ppf} />
                  ))}
              </div>
            ))}

            {/* 再生ヘッド(全レーン貫通。クリップより手前に表示) */}
            <div
              className="pointer-events-none absolute top-0 z-40 h-full w-px bg-rose-400"
              style={{ left: playheadX }}
            >
              <div className="absolute -left-1 -top-0.5 h-2 w-2 rotate-45 bg-rose-400" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- キーボード操作 ---------------------------------- */

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const inputType = tag === "INPUT" ? (target as HTMLInputElement).type : "";
      // 文字入力中(テキスト/数値/選択)だけはキーを奪わない
      const isTextEntry =
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable ||
        (tag === "INPUT" && inputType !== "range");
      const st = useScene3d.getState();
      const total = totalDurationFrames(st.project);

      // Space はスライダー/ボタンに焦点があっても再生トグルとして効かせる
      if (e.code === "Space") {
        if (isTextEntry) return;
        e.preventDefault(); // ボタンのクリック誤発火・スクロールを防ぐ
        st.togglePlay();
        return;
      }
      // それ以外のキーは、フォーム部品に焦点がある間は既定動作(スライダーの矢印等)を優先
      if (isTextEntry || inputType === "range" || tag === "BUTTON") {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoScene3d();
        else undoScene3d();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? SCENE_FPS : 1) * (e.key === "ArrowLeft" ? -1 : 1);
        st.setPlaying(false);
        st.setCurrentFrame(
          Math.max(0, Math.min(total - 1, Math.round(st.currentFrame) + step)),
        );
      } else if (e.key === "Home") {
        e.preventDefault();
        st.setPlaying(false);
        st.setCurrentFrame(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/* ---------------------------------- フレーム枠(アスペクト比) ---------------------------------- */

/**
 * カメラの画/再生中に、書き出しアスペクト比のフレームをレターボックスで示す。
 * ビューポートを計測し、フレーム外を暗く落として内外を明確にする
 */
/** アスペクト比フレームのレターボックス(自身のコンテナを計測) */
function FrameOverlay() {
  const aspectRatio = useScene3d((s) => s.project.aspectRatio);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ar = ASPECT_VALUES[aspectRatio];
  // contain フィット(はみ出さない最大サイズ)
  let frameW = size.h * ar;
  let frameH = size.h;
  if (frameW > size.w) {
    frameW = size.w;
    frameH = size.w / ar;
  }

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
      {size.w > 0 && (
        <div
          className="relative border border-white/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.65)]"
          style={{ width: frameW, height: frameH }}
        >
          <span className="absolute left-1.5 top-1 text-[10px] font-medium text-white/70">
            {aspectRatio}
          </span>
        </div>
      )}
    </div>
  );
}

const VIEW_BTN =
  "rounded-md border border-[#2a2a2a] bg-[#141414]/85 px-2 py-1 text-[11px] text-neutral-300 hover:border-pink-400/60 hover:text-white";

/** 編集ビュー1枚 + オーバーレイ(視点ボタン/ヒント/必要時フレーム) */
function EditorPane({ showOverlays, primary = false }: { showOverlays: boolean; primary?: boolean }) {
  return (
    <div className="relative h-full min-w-0 flex-1 overflow-hidden">
      <Scene3dViewport primary={primary} />
      {showOverlays && (
        <div className="absolute left-3 top-3 flex gap-1">
          <button className={VIEW_BTN} onClick={() => requestViewPreset("iso")}>斜め</button>
          <button className={VIEW_BTN} onClick={() => requestViewPreset("front")}>正面</button>
          <button className={VIEW_BTN} onClick={() => requestViewPreset("side")}>横</button>
          <button className={VIEW_BTN} onClick={() => requestViewPreset("top")}>俯瞰</button>
          <button className={VIEW_BTN} onClick={() => requestViewPreset("fit")}>全体</button>
        </div>
      )}
      {showOverlays && (
        <p className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-white/45">
          左ドラッグ: 回る · ホイール: 寄る · 右ドラッグ: ずらす · ダブルクリック: 注視 · Shift+物ドラッグ: 軸に沿って移動
        </p>
      )}
    </div>
  );
}

/** ペインヘッダの小アイコン群(分割/切替/閉じる) — Blender風レイアウトの操作点 */
function PaneHeaderButtons({
  paneId,
  canClose,
}: {
  paneId: string;
  canClose: boolean;
}) {
  const applyPaneOp = useScene3d((s) => s.applyPaneOp);
  const btn =
    "flex h-6 w-6 items-center justify-center rounded text-neutral-300 hover:bg-white/10 hover:text-white";
  return (
    <div className="absolute right-2 top-2 z-10 flex gap-0.5 rounded-md bg-black/45 p-0.5 opacity-45 transition hover:opacity-100">
      <button
        className={btn}
        title="左右に分割"
        onClick={() => applyPaneOp({ type: "split", id: paneId, dir: "row" })}
      >
        <Icon className="h-3.5 w-3.5">
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <path d="M12 5v14" />
        </Icon>
      </button>
      <button
        className={btn}
        title="上下に分割"
        onClick={() => applyPaneOp({ type: "split", id: paneId, dir: "col" })}
      >
        <Icon className="h-3.5 w-3.5">
          <rect x="3" y="5" width="18" height="14" rx="1.5" />
          <path d="M3 12h18" />
        </Icon>
      </button>
      <button
        className={btn}
        title="編集ビュー ⇄ カメラの画"
        onClick={() => applyPaneOp({ type: "toggleView", id: paneId })}
      >
        <Icon className="h-3.5 w-3.5">
          <path d="M7 8h10M14 5l3 3-3 3M17 16H7M10 13l-3 3 3 3" />
        </Icon>
      </button>
      {canClose && (
        <button
          className={btn}
          title="このペインを閉じる"
          onClick={() => applyPaneOp({ type: "close", id: paneId })}
        >
          <Icon className="h-3.5 w-3.5">
            <path d="M6 6l12 12M18 6L6 18" />
          </Icon>
        </button>
      )}
    </div>
  );
}

/** 分割境界(方向対応)。ドラッグで比率変更 */
function PaneDivider({
  dir,
  onDelta,
}: {
  dir: "row" | "col";
  onDelta: (dpx: number) => void;
}) {
  const state = useRef<{ start: number } | null>(null);
  const isRow = dir === "row";
  return (
    <div
      className={`group z-10 flex shrink-0 items-center justify-center bg-[#181818] transition hover:bg-pink-400/30 ${
        isRow ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"
      }`}
      onPointerDown={(e) => {
        state.current = { start: isRow ? e.clientX : e.clientY };
        (e.target as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!state.current) return;
        const cur = isRow ? e.clientX : e.clientY;
        onDelta(cur - state.current.start);
        state.current = { start: cur };
      }}
      onPointerUp={(e) => {
        state.current = null;
        (e.target as Element).releasePointerCapture(e.pointerId);
      }}
    >
      <div
        className={`rounded bg-[#3a3a3a] group-hover:bg-pink-300 ${
          isRow ? "h-10 w-0.5" : "h-0.5 w-10"
        }`}
      />
    </div>
  );
}

/** ペインツリーの再帰レンダラ */
function PaneTreeView({
  node,
  primaryId,
  leafCount,
}: {
  node: PaneNode;
  primaryId: string;
  leafCount: number;
}) {
  const applyPaneOp = useScene3d((s) => s.applyPaneOp);
  const containerRef = useRef<HTMLDivElement>(null);

  if (node.kind === "leaf") {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {node.view === "editor" ? (
          <EditorPane showOverlays primary={node.id === primaryId} />
        ) : (
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden border border-[#242424]">
            <Scene3dViewport mode="camera" primary={node.id === primaryId} />
            <FrameOverlay />
            <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70">
              カメラの画
            </span>
          </div>
        )}
        <PaneHeaderButtons paneId={node.id} canClose={leafCount > 1} />
      </div>
    );
  }

  const isRow = node.dir === "row";
  const onDelta = (dpx: number) => {
    const el = containerRef.current;
    if (!el) return;
    const size = isRow ? el.clientWidth : el.clientHeight;
    if (size <= 0) return;
    applyPaneOp({ type: "ratio", id: node.id, delta: dpx / size });
  };

  return (
    <div
      ref={containerRef}
      className={`flex min-h-0 min-w-0 flex-1 ${isRow ? "flex-row" : "flex-col"}`}
    >
      <div
        style={{ flexBasis: `${node.ratio * 100}%` }}
        className="flex min-h-0 min-w-0 overflow-hidden"
      >
        <PaneTreeView node={node.a} primaryId={primaryId} leafCount={leafCount} />
      </div>
      <PaneDivider dir={node.dir} onDelta={onDelta} />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneTreeView node={node.b} primaryId={primaryId} leafCount={leafCount} />
      </div>
    </div>
  );
}

function ViewportWithFrame() {
  const cameraView = useScene3d((s) => s.cameraView);
  const playing = useScene3d((s) => s.playing);
  const paneLayout = useScene3d((s) => s.paneLayout);
  const splitView = useScene3d((s) => s.splitView);

  // 単一ペイン時: 従来どおり(カメラの画トグルで全画面レターボックス)
  if (!splitView && paneLayout.kind === "leaf") {
    const showFrame = cameraView || playing;
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorPane showOverlays={!showFrame} primary />
        {showFrame && <FrameOverlay />}
        <PaneHeaderButtons paneId={paneLayout.id} canClose={false} />
      </div>
    );
  }

  // 複数ペイン: Blender風ツリー
  const primaryId = firstLeafId(paneLayout);
  const leafCount = splitView ? 2 : 1; // canClose 判定用(正確な数は不要)
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <PaneTreeView node={paneLayout} primaryId={primaryId} leafCount={leafCount} />
    </div>
  );
}

/* ---------------------------------- パネル幅の調整 ---------------------------------- */

/**
 * パネル幅は「画面比率(%)」で持つ(配布先の画面サイズ差に自動追従)。
 * 左右合計は55%が上限で、片方を広げても他方が画面外に押し出されない
 */
function usePanelPct(key: string, initial: number, min: number, max: number) {
  const [pct, setPct] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const update = (deltaPct: number, otherPct: number) => {
    setPct((prev) => {
      const pairMax = 55 - otherPct; // 左右合計55%まで
      const clamped = Math.max(min, Math.min(Math.min(max, pairMax), prev + deltaPct));
      localStorage.setItem(key, String(Math.round(clamped * 10) / 10));
      return clamped;
    });
  };
  return [pct, update] as const;
}

/** ワークスペース行の実幅を計測(%→px変換の基準) */
function useRowWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** パネル境界のドラッグハンドル(左右の幅調整) */
function PanelResizer({
  onDelta,
}: {
  onDelta: (dx: number) => void;
}) {
  const state = useRef<{ startX: number } | null>(null);
  return (
    <div
      className="group relative z-10 flex w-2 shrink-0 cursor-col-resize items-center justify-center bg-[#181818] transition hover:bg-pink-400/30"
      onPointerDown={(e) => {
        state.current = { startX: e.clientX };
        (e.target as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!state.current) return;
        onDelta(e.clientX - state.current.startX);
        state.current = { startX: e.clientX };
      }}
      onPointerUp={(e) => {
        state.current = null;
        (e.target as Element).releasePointerCapture(e.pointerId);
      }}
    >
      <div className="h-10 w-0.5 rounded bg-[#3a3a3a] group-hover:bg-pink-300" />
    </div>
  );
}

/* ---------------------------------- ルート ---------------------------------- */

/** 畳んだパネルの細レール(クリックで再展開) */
function CollapsedRail({ side, onOpen }: { side: "left" | "right"; onOpen: () => void }) {
  return (
    <button
      className={`flex w-6 shrink-0 items-center justify-center bg-[#141414] text-neutral-500 hover:text-pink-300 ${
        side === "left" ? "border-r" : "border-l"
      } border-[#242424]`}
      onClick={onOpen}
      title={side === "left" ? "素材パネルを開く" : "監督パネルを開く"}
    >
      <span className="text-[10px]">{side === "left" ? "»" : "«"}</span>
    </button>
  );
}

function usePanelOpen(key: string) {
  const [open, setOpen] = useState(() => localStorage.getItem(key) !== "0");
  const toggle = () => {
    setOpen((v) => {
      localStorage.setItem(key, v ? "0" : "1");
      return !v;
    });
  };
  return [open, toggle] as const;
}

export function Scene3dWorkspace() {
  useKeyboardShortcuts();
  const [rowRef, rowW] = useRowWidth();
  const [leftPct, setLeftPct] = usePanelPct("scene3d.panel.leftPct", 16, 8, 30);
  const [rightPct, setRightPct] = usePanelPct("scene3d.panel.rightPct", 22, 12, 35);
  const [leftOpen, toggleLeft] = usePanelOpen("scene3d.panel.left.open");
  const [rightOpen, toggleRight] = usePanelOpen("scene3d.panel.right.open");

  // %→px(最低幅120pxは保証しつつ、画面が狭ければ%どおり縮む)
  const leftW = Math.max(120, Math.round((rowW * leftPct) / 100));
  const rightW = Math.max(150, Math.round((rowW * rightPct) / 100));

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div ref={rowRef} className="flex min-h-0 flex-1 overflow-hidden">
        {leftOpen ? (
          <>
            <div style={{ width: leftW, minWidth: 140 }} className="relative flex overflow-hidden">
              <ShelfPanel />
              <button
                className="absolute -right-0 top-2 z-10 rounded-l-md px-1 py-1 text-[10px] text-neutral-500 hover:text-pink-300"
                onClick={toggleLeft}
                title="パネルを畳む"
              >
                «
              </button>
            </div>
            <PanelResizer onDelta={(dx) => setLeftPct(rowW > 0 ? (dx / rowW) * 100 : 0, rightPct)} />
          </>
        ) : (
          <CollapsedRail side="left" onOpen={toggleLeft} />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ViewportWithFrame />
          <ShotTimeline />
        </div>
        {rightOpen ? (
          <>
            <PanelResizer onDelta={(dx) => setRightPct(rowW > 0 ? (-dx / rowW) * 100 : 0, leftPct)} />
            <div style={{ width: rightW, minWidth: 200 }} className="relative flex overflow-hidden">
              <button
                className="absolute left-0 top-2 z-10 rounded-r-md px-1 py-1 text-[10px] text-neutral-500 hover:text-pink-300"
                onClick={toggleRight}
                title="パネルを畳む"
              >
                »
              </button>
              <DirectorPanel />
            </div>
          </>
        ) : (
          <CollapsedRail side="right" onOpen={toggleRight} />
        )}
      </div>
    </section>
  );
}
