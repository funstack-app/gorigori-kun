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
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { totalDurationFrames } from "../../../lib/scene3d/evaluateScene";
import {
  CAMERA_PRESET_LABELS,
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
  getSelectedShot,
  redoScene3d,
  undoScene3d,
  useScene3d,
} from "../../../lib/store/scene3d";
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

/** タイムラインの縮尺(1秒 = 28px) */
const PX_PER_SEC = 28;
const pxPerFrame = PX_PER_SEC / SCENE_FPS;

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
  const current = getSelectedShot({ project, selectedShotId }).camera.preset;

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
  const entities = useScene3d((s) => s.project.entities);
  const selectedId = useScene3d((s) => s.selectedEntityId);
  const selectEntity = useScene3d((s) => s.selectEntity);
  const removeEntity = useScene3d((s) => s.removeEntity);
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
      </div>

      {pickerOpen && <ObjectPickerPopup onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}

/* ---------------------------------- 右パネル(監督) ---------------------------------- */

/** 選択中オブジェクトの調整(選択時のみ表示。全部を見せない原則) */
function SelectedObjectSection() {
  const project = useScene3d((s) => s.project);
  const selectedEntityId = useScene3d((s) => s.selectedEntityId);
  const rotateEntity = useScene3d((s) => s.rotateEntity);
  const scaleEntity = useScene3d((s) => s.scaleEntity);
  const setEntityFloors = useScene3d((s) => s.setEntityFloors);

  const entity = project.entities.find((e) => e.id === selectedEntityId);
  if (!entity) return null;

  const degrees = Math.round(((entity.rotationY * 180) / Math.PI) % 360);

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-wide text-amber-400/90">
        <EntityKindIcon kind={entity.kind} />
        {entity.label}
      </p>
      <label className="mb-2 flex flex-col gap-1 text-xs text-neutral-400">
        向き: {((degrees % 360) + 360) % 360}°
        <input
          type="range"
          min={0}
          max={360}
          step={15}
          value={((degrees % 360) + 360) % 360}
          onChange={(e) => rotateEntity(entity.id, (Number(e.target.value) * Math.PI) / 180)}
        />
      </label>
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
      {entity.kind === "building" && (
        <label className="mt-2 flex flex-col gap-1 text-xs text-neutral-400">
          階数: {entity.params?.floors ?? 3}階
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={entity.params?.floors ?? 3}
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
  const [presetOpen, setPresetOpen] = useState(false);

  const shot = getSelectedShot({ project, selectedShotId });
  const camera = shot.camera;

  return (
    <aside className="flex w-full flex-col gap-5 overflow-y-auto border-l border-[#242424] bg-[#141414] px-4 py-4">
      <SelectedObjectSection />
      <div>
        <p className="mb-2 text-[11px] font-bold tracking-wide text-neutral-500">{shot.label} のカメラ</p>
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

/** タイムライン上の1クリップ。幅=秒数、右端ドラッグで尺変更、本体ドラッグで並び替え */
function ShotClip({ shot, index }: { shot: SceneShot; index: number }) {
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const selectShot = useScene3d((s) => s.selectShot);
  const removeShot = useScene3d((s) => s.removeShot);
  const setShotDurationFrames = useScene3d((s) => s.setShotDurationFrames);
  const shotCount = useScene3d((s) => s.project.shots.length);

  const selected = selectedShotId === shot.id;
  const widthPx = Math.max(56, shot.durationFrames * pxPerFrame);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: shot.id });

  const resizeState = useRef<{ startX: number; startFrames: number } | null>(null);

  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeState.current = { startX: e.clientX, startFrames: shot.durationFrames };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeState.current) return;
    const dx = e.clientX - resizeState.current.startX;
    setShotDurationFrames(shot.id, resizeState.current.startFrames + dx / pxPerFrame);
  };
  const onResizeUp = (e: React.PointerEvent) => {
    resizeState.current = null;
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        width: widthPx,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      className={`group relative flex h-14 shrink-0 cursor-grab select-none flex-col justify-center rounded-md border px-2 ${
        selected
          ? "border-pink-400 bg-pink-500/10"
          : "border-[#2a2a2a] bg-[#161616] hover:border-pink-400/50"
      }`}
      onClick={() => selectShot(shot.id)}
      {...attributes}
      {...listeners}
    >
      <p className={`truncate text-xs font-medium ${selected ? "text-pink-200" : "text-neutral-200"}`}>
        {index + 1}. {shot.label}
      </p>
      <p className="truncate text-[10px] text-neutral-400">
        {CAMERA_PRESET_LABELS[shot.camera.preset]} · {(shot.durationFrames / SCENE_FPS).toFixed(1)}s
      </p>
      {shotCount > 1 && (
        <button
          className="absolute right-1 top-0.5 hidden text-[10px] text-neutral-500 hover:text-red-400 group-hover:block"
          onClick={(e) => {
            e.stopPropagation();
            removeShot(shot.id);
          }}
          title="このカットを削除"
        >
          ✕
        </button>
      )}
      {/* 右端の尺変更ハンドル */}
      <div
        className="absolute -right-0.5 top-0 h-full w-2 cursor-ew-resize rounded-r-md bg-pink-400/0 hover:bg-pink-400/60"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
    </div>
  );
}

/** CapCut風タイムライン: 再生ヘッド + ルーラースクラブ + クリップ列 + カット追加 */
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
  const reorderShots = useScene3d((s) => s.reorderShots);

  const totalFrames = totalDurationFrames(project);
  const totalSec = totalFrames / SCENE_FPS;
  const playheadX = Math.min(currentFrame, totalFrames - 1) * pxPerFrame;
  const scrubbing = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderShots(String(active.id), String(over.id));
    }
  };

  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
    setPlaying(false);
    setCurrentFrame(Math.max(0, Math.min(totalFrames - 1, x / pxPerFrame)));
  };

  return (
    <div className="flex flex-col border-t border-[#242424] bg-[#141414]">
      <div className="flex min-w-0 items-center gap-3 overflow-hidden px-4 pt-2">
        <button
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
            playing ? "bg-red-500/20 text-red-300" : "bg-sky-500/20 text-pink-300"
          }`}
          onClick={togglePlay}
          title="スペースキーでも再生/停止(停止で再生開始位置に戻る)"
        >
          {playing ? <StopIcon /> : <PlayIcon />}
          {playing ? "停止" : "再生"}
        </button>
        <button
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-sm ${
            cameraView
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-[#2a2a2a] text-neutral-400"
          }`}
          onClick={() => setCameraView(!cameraView)}
          title="撮影カメラの画で確認"
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
          分割
        </button>
        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-600">
          Space: 再生/停止 · ←→: コマ送り(Shiftで1秒) · Home: 先頭 · ⌘Z: 取り消し
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-neutral-400">
          {(currentFrame / SCENE_FPS).toFixed(1)}s / 合計 {totalSec.toFixed(1)}s
          {totalSec > SEEDANCE_MAX_SECONDS && (
            <span className="ml-1 text-amber-400">(上限{SEEDANCE_MAX_SECONDS}s超)</span>
          )}
        </span>
      </div>

      <div className="overflow-x-auto px-4 pb-3 pt-1">
        <div className="relative w-max min-w-full">
          {/* ルーラー(クリック/ドラッグでスクラブ) */}
          <div
            className="relative mb-1 h-4 cursor-col-resize"
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
            {Array.from({ length: Math.ceil(totalSec) + 1 }, (_, i) => (
              <span
                key={i}
                className="absolute top-0 border-l border-[#3a3a3a] pl-0.5 text-[9px] text-neutral-500"
                style={{ left: i * PX_PER_SEC }}
              >
                {i}s
              </span>
            ))}
          </div>

          {/* クリップ列 */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={project.shots.map((s) => s.id)}
              strategy={horizontalListSortingStrategy}
            >
              <div className="flex items-center gap-1">
                {project.shots.map((shot, i) => (
                  <ShotClip key={shot.id} shot={shot} index={i} />
                ))}
                <button
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-[#3a3a3a] text-lg text-neutral-500 hover:border-pink-400/60 hover:text-pink-300"
                  onClick={addShot}
                  title="カットを追加(選択中カットの複製から)"
                >
                  +
                </button>
              </div>
            </SortableContext>
          </DndContext>

          {/* 再生ヘッド */}
          <div
            className="pointer-events-none absolute top-0 h-full w-px bg-rose-400"
            style={{ left: playheadX }}
          >
            <div className="absolute -left-1 -top-0.5 h-2 w-2 rotate-45 bg-rose-400" />
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
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      const st = useScene3d.getState();
      const total = totalDurationFrames(st.project);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoScene3d();
        else undoScene3d();
      } else if (e.code === "Space") {
        e.preventDefault();
        st.togglePlay();
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
function EditorPane({ showOverlays }: { showOverlays: boolean }) {
  return (
    <div className="relative h-full min-w-0 flex-1 overflow-hidden">
      <Scene3dViewport />
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
          左ドラッグ: 回る · ホイール: 寄る · 右ドラッグ: ずらす · ダブルクリック: そこを注視
        </p>
      )}
    </div>
  );
}

function ViewportWithFrame() {
  const cameraView = useScene3d((s) => s.cameraView);
  const playing = useScene3d((s) => s.playing);
  const splitView = useScene3d((s) => s.splitView);
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    const saved = Number(localStorage.getItem("scene3d.split.ratio"));
    return Number.isFinite(saved) && saved >= 25 && saved <= 75 ? saved : 50;
  });

  const updateRatio = (dxPx: number) => {
    const w = containerRef.current?.clientWidth ?? 0;
    if (w <= 0) return;
    const next = Math.max(25, Math.min(75, ratio + (dxPx / w) * 100));
    setRatio(next);
    localStorage.setItem("scene3d.split.ratio", String(Math.round(next)));
  };

  if (!splitView) {
    const showFrame = cameraView || playing;
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorPane showOverlays={!showFrame} />
        {showFrame && <FrameOverlay />}
      </div>
    );
  }

  // 分割表示: 左=編集ビュー(自由視点) / 右=撮影カメラの画(書き出しと同じ)
  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div style={{ width: `${ratio}%` }} className="relative flex min-w-0">
        <EditorPane showOverlays />
      </div>
      <PanelResizer onDelta={updateRatio} />
      <div className="relative min-w-0 flex-1 overflow-hidden border-l border-[#242424]">
        <Scene3dViewport mode="camera" />
        <FrameOverlay />
        <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/70">
          カメラの画(書き出しと同じ)
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------- パネル幅の調整 ---------------------------------- */

function usePanelWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial;
  });
  const update = (w: number) => {
    const clamped = Math.max(min, Math.min(max, Math.round(w)));
    setWidth(clamped);
    localStorage.setItem(key, String(clamped));
  };
  return [width, update] as const;
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
      className="relative z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize bg-transparent transition hover:bg-pink-400/40"
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
    />
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
  const [leftW, setLeftW] = usePanelWidth("scene3d.panel.left", 224, 160, 420);
  const [rightW, setRightW] = usePanelWidth("scene3d.panel.right", 288, 220, 480);
  const [leftOpen, toggleLeft] = usePanelOpen("scene3d.panel.left.open");
  const [rightOpen, toggleRight] = usePanelOpen("scene3d.panel.right.open");

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
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
            <PanelResizer onDelta={(dx) => setLeftW(leftW + dx)} />
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
            <PanelResizer onDelta={(dx) => setRightW(rightW - dx)} />
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
