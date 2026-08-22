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
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { useSkillVisible } from "../../SkillWorkspaceRouter";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { PageHelp } from "../../PageHelp";
import { getShotMove, totalDurationFrames } from "../../../lib/scene3d/evaluateScene";
import {
  getBuiltinTemplate,
  importMotionFiles,
  loadBuiltinMotions,
  loadCaptureRig,
  registerGeneratedClip,
  unregisterMotion,
} from "../../../lib/scene3d/motionLibrary";
import {
  buildGeneratedClip,
  buildMotionPrompt,
  validateGeneratedSpec,
} from "../../../lib/scene3d/motionGen";
// 仕様の保存・読み出しは motionStore (motions.json 正本) 側 (2026-08-03 gj7)。
import {
  initializeGeneratedMotions,
  loadGeneratedSpecs,
  removeGeneratedSpec,
  saveGeneratedSpec,
} from "../../../lib/scene3d/motionStore";
import { codexTextQuery } from "../../../lib/agents/codexQuery";
import {
  applyDirectorPlan,
  buildDirectorPrompt,
  reviseGeneratedMotion,
  validateDirectorPlan,
} from "../../../lib/scene3d/directorGen";
import { captureVideoToSpec } from "../../../lib/scene3d/videoCapture/videoToClip";
import { registerClipSpeed, resolveClipSpeed } from "../../../lib/scene3d/clipSpeed";
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
  SceneEntity,
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
import type { PaneNode, StoryboardCutImport } from "../../../lib/store/scene3d";
import { useStoryboardRun } from "../../../lib/store/storyboardRun";
import { useToasts } from "../../../lib/store/toasts";
import { useScene3dRun } from "../../../lib/store/scene3dRun";
import type { StoryboardSketchCut } from "../../../lib/storyboard/types";
import { sendCutToVideoTab } from "../../../lib/storyboard/sendCutToVideo";
import { requestViewPreset, Scene3dViewport } from "./Scene3dViewport";
import { GenerationGauge } from "../../GenerationGauge";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { SceneFromImageDialog } from "./SceneFromImageDialog";

const PRESET_ORDER: CameraPresetId[] = [
  "fixed",
  "path",
  "pushIn",
  "pullOut",
  "track",
  "pan",
  "orbit",
  "crane",
  "handheld",
  "spiralIn",
  "dollyZoom",
  "flyover",
  "riseReveal",
  "follow",
  "whipPan",
  "shake",
  "snapZoom",
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
/**
 * 汎用の小アイコン群 (2026-07-25)。冒頭の UI原則「絵文字を使わない」に反して
 * バツ / 鉛筆 / 三角 / チェック / カチンコ / フォルダ / リンク の絵文字が混ざっていたので、
 * すべてこのラインSVGへ置換した(placeholder 文字列だけは SVG を入れられないため文言のみ)。
 */
const CloseIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Icon>
);
const PencilIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3 w-3"}>
    <path d="M4 20h4L20 8l-4-4L4 16v4z" />
  </Icon>
);
const CheckIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);
const ChevronDownIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
const ChevronRightIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
/** カチンコ(動画・モーション関連の見出し) */
const ClapperIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9z" />
    <path d="M3.5 10L5 5l16 2-.6 3" />
  </Icon>
);
/** フォルダ(ファイルを選ぶ) */
const FolderIcon = ({ className }: { className?: string }) => (
  <Icon className={className ?? "h-3.5 w-3.5"}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
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

const TableIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M3 9h18M5 9v9M19 9v9" />
  </Icon>
);
const ChairIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M7 4v9h10M7 13l-1 7M17 13v7M17 13V9" />
  </Icon>
);
const SofaIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 12V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
    <rect x="2" y="12" width="20" height="6" rx="2" />
    <path d="M5 18v2M19 18v2" />
  </Icon>
);
const BedIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M3 7v13M3 15h18v5M3 12h18v-2a2 2 0 0 0-2-2H9" />
    <circle cx="6.5" cy="9" r="1.5" />
  </Icon>
);
const ShelfIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <rect x="5" y="3" width="14" height="18" />
    <path d="M5 9h14M5 15h14" />
  </Icon>
);
const PedestalIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M8 4h8M9 4l1 16h4l1-16M7 20h10" />
  </Icon>
);
const CarIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 15l1.5-5A2 2 0 0 1 7.4 8.5h9.2a2 2 0 0 1 1.9 1.5L20 15" />
    <rect x="3" y="14" width="18" height="4" rx="1.5" />
    <circle cx="7.5" cy="18.5" r="1.6" />
    <circle cx="16.5" cy="18.5" r="1.6" />
  </Icon>
);
const TreeIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="9" r="5" />
    <path d="M12 14v7M9 21h6" />
  </Icon>
);
const StreetlightIcon = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M9 21h6M12 21V5M12 5h5l-1.5 3h-3" />
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
    case "table":
      return <TableIcon className={className} />;
    case "chair":
      return <ChairIcon className={className} />;
    case "sofa":
      return <SofaIcon className={className} />;
    case "bed":
      return <BedIcon className={className} />;
    case "shelf":
      return <ShelfIcon className={className} />;
    case "pedestal":
      return <PedestalIcon className={className} />;
    case "car":
      return <CarIcon className={className} />;
    case "tree":
      return <TreeIcon className={className} />;
    case "streetlight":
      return <StreetlightIcon className={className} />;
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
    case "spiralIn":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="12" r="1.5" />
          <path d="M12 5a7 7 0 1 1-7 7 5 5 0 1 1 5 5 3 3 0 1 1 2-5" />
        </Icon>
      );
    case "dollyZoom":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="12" r="2.5" />
          <path d="M4 5l4 4M20 5l-4 4M4 19l4-4M20 19l-4-4" />
        </Icon>
      );
    case "flyover":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="16" r="2" />
          <path d="M4 16c2-8 14-8 16 0M17.5 13.5L20 16l-3 .8" />
        </Icon>
      );
    case "riseReveal":
      return (
        <Icon className={cls}>
          <path d="M4 20h16M12 17V6M9 9l3-3 3 3" />
        </Icon>
      );
    case "follow":
      return (
        <Icon className={cls}>
          <circle cx="8" cy="10" r="2" />
          <rect x="14" y="8" width="6" height="4" rx="1" />
          <path d="M6 17h12M15 14.5L18 17l-3 2.5" />
        </Icon>
      );
    case "whipPan":
      return (
        <Icon className={cls}>
          <path d="M3 12h13M12 8l5 4-5 4M19 7v10" />
        </Icon>
      );
    case "shake":
      return (
        <Icon className={cls}>
          <path d="M4 12l3-5 3 9 3-8 3 6 2-4" />
        </Icon>
      );
    case "snapZoom":
      return (
        <Icon className={cls}>
          <circle cx="12" cy="12" r="3" />
          <path d="M4 4l4 4M20 4l-4 4M4 20l4-4M20 20l-4-4M12 10.5v3M10.5 12h3" />
        </Icon>
      );
    case "path":
      return (
        <Icon className={cls}>
          <path d="M4 18c4-8 6 6 10-2 2-4 4-5 6-5" />
          <circle cx="9" cy="13" r="1.6" />
          <circle cx="15" cy="12" r="1.6" />
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
        {/* ポップアップの題は最上位の見出し。区切り線で本文と層を分ける */}
        <div className="mb-3 flex items-center justify-between border-b border-[#2a2a2a] pb-2.5">
          <p className="text-[15px] font-black text-neutral-100">{title}</p>
          <button
            className="text-neutral-500 hover:text-neutral-200"
            onClick={onClose}
            aria-label="閉じる"
          >
            <CloseIcon />
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
  const furniture: { kind: SceneEntityKind; label: string }[] = [
    { kind: "table", label: "机" },
    { kind: "chair", label: "椅子" },
    { kind: "sofa", label: "ソファ" },
    { kind: "bed", label: "ベッド" },
    { kind: "shelf", label: "棚" },
    { kind: "pedestal", label: "台座" },
  ];
  const outdoor: { kind: SceneEntityKind; label: string }[] = [
    { kind: "car", label: "車" },
    { kind: "tree", label: "木" },
    { kind: "streetlight", label: "街灯" },
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
      <p className="mb-2 mt-4 text-[11px] font-bold tracking-wide text-neutral-500">家具</p>
      <div className="grid grid-cols-4 gap-2">
        {furniture.map((it) => (
          <button key={it.kind} className={card} onClick={() => pick(it.kind)}>
            <EntityKindIcon kind={it.kind} className="h-10 w-10" />
            <span className="text-xs">{it.label}</span>
          </button>
        ))}
      </div>
      <p className="mb-2 mt-4 text-[11px] font-bold tracking-wide text-neutral-500">屋外</p>
      <div className="grid grid-cols-4 gap-2">
        {outdoor.map((it) => (
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
    spiralIn: "回り込みながら寄る",
    dollyZoom: "背景だけ伸びる緊張感",
    flyover: "頭上を飛び越えて背後へ",
    riseReveal: "足元から上昇して全景を見せる",
    follow: "動く被写体を並走・追跡",
    whipPan: "一瞬で振る場面転換",
    shake: "爆発・衝撃の揺れ(収まる)",
    snapZoom: "位置固定で一気に寄る",
    path: "つかんで曲げる自由な道",
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

/** シーン内リストの1行。上下ドラッグで並び替え、右クリックでメニュー */
function EntityRow({
  entity,
  selected,
  onSelect,
  onRemove,
  onContextMenu,
}: {
  entity: SceneEntity;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entity.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-center justify-between rounded px-2 py-1.5 text-sm ${
        isDragging ? "relative z-10 bg-[#1c1c1c] opacity-90" : ""
      } ${
        selected ? "bg-amber-500/15 text-amber-300" : "text-neutral-300 hover:bg-[#101010]"
      }`}
      onContextMenu={(ev) => {
        ev.preventDefault();
        onContextMenu(ev.clientX, ev.clientY);
      }}
      {...attributes}
      {...listeners}
    >
      <button className="flex flex-1 items-center gap-2 text-left" onClick={onSelect}>
        <EntityKindIcon kind={entity.kind} />
        {entity.label}
      </button>
      <button
        className="text-neutral-600 hover:text-red-400"
        onClick={onRemove}
        title="削除"
        aria-label="削除"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </li>
  );
}

/** レイヤー右クリックメニュー(複製/削除)。外側クリックで閉じる */
function EntityContextMenu({
  x,
  y,
  onDuplicate,
  onRemove,
  onClose,
}: {
  x: number;
  y: number;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);
  return (
    <div
      className="fixed z-50 min-w-32 rounded-lg border border-[#2a2a2a] bg-[#181818] py-1 shadow-xl"
      style={{ left: x, top: y }}
      onPointerDown={(ev) => ev.stopPropagation()}
    >
      <button
        className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[#242424]"
        onClick={onDuplicate}
      >
        複製
      </button>
      <button
        className="block w-full px-3 py-1.5 text-left text-xs text-red-300 hover:bg-[#242424]"
        onClick={onRemove}
      >
        削除
      </button>
    </div>
  );
}

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
  const duplicateEntity = useScene3d((s) => s.duplicateEntity);
  const reorderEntity = useScene3d((s) => s.reorderEntity);
  const selectedCameraId = getSelectedShot({ project, selectedShotId }).cameraId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // 画像からシーンを起こす (Slice D)。ファイル選択入口
  const sceneImagePath = useScene3dRun((s) => s.sceneImagePath);
  const setSceneImagePath = useScene3dRun((s) => s.setSceneImagePath);
  const pickSceneImage = async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (typeof selected !== "string") return;
    setSceneImagePath(selected);
  };
  // 5px 動かすまでドラッグ扱いにしない(クリック選択と共存させる)
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onEntityDragEnd = (ev: DragEndEvent) => {
    const overId = ev.over?.id;
    if (overId != null && ev.active.id !== overId) {
      reorderEntity(String(ev.active.id), String(overId));
    }
  };

  return (
    <aside className="flex w-full flex-col gap-4 border-r border-[#242424] bg-[#141414] px-4 py-4">
      <button
        className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-sm text-neutral-200 hover:border-amber-500/60"
        onClick={() => setPickerOpen(true)}
      >
        + シーンに置く
      </button>

      <button
        className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-sm text-neutral-200 hover:border-amber-500/60"
        onClick={() => void pickSceneImage()}
        title="写真や絵を読み込んで、人物と小物とカメラを3Dシーンに起こします"
      >
        画像からシーンを起こす…
      </button>

      <SceneFromImageDialog
        open={sceneImagePath !== null}
        imagePath={sceneImagePath}
        onClose={() => setSceneImagePath(null)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 text-[11px] font-bold tracking-wide text-neutral-500">シーン内</p>
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={onEntityDragEnd}
        >
          <SortableContext
            items={entities.map((e) => e.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-1">
              {entities.map((e) => (
                <EntityRow
                  key={e.id}
                  entity={e}
                  selected={selectedId === e.id}
                  onSelect={() => selectEntity(e.id)}
                  onRemove={() => removeEntity(e.id)}
                  onContextMenu={(x, y) => setCtxMenu({ id: e.id, x, y })}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        {ctxMenu && (
          <EntityContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onDuplicate={() => {
              duplicateEntity(ctxMenu.id);
              setCtxMenu(null);
            }}
            onRemove={() => {
              removeEntity(ctxMenu.id);
              setCtxMenu(null);
            }}
            onClose={() => setCtxMenu(null)}
          />
        )}

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
                    className="absolute right-1 top-1.5 text-neutral-600 hover:text-red-400"
                    onClick={() => removeCamera(cam.id)}
                    title="このカメラを削除"
                    aria-label="このカメラを削除"
                  >
                    <CloseIcon className="h-3 w-3" />
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

/**
 * モーションライブラリ・ポップアップ。
 * MixamoのFBX(With Skin推奨)を複数まとめて読み込み、選択中の人物に割り当てる。
 * ファイルはユーザーが自分のアカウントで取得したものを持ち込む(アプリには同梱しない)
 */
function MotionLibraryPopup({ entityId, onClose }: { entityId: string; onClose: () => void }) {
  const importedMotions = useScene3d((s) => s.importedMotions);
  const registerImportedMotions = useScene3d((s) => s.registerImportedMotions);
  const removeImportedMotion = useScene3d((s) => s.removeImportedMotion);
  const setEntityMotionClip = useScene3d((s) => s.setEntityMotionClip);
  const project = useScene3d((s) => s.project);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  /** 取り込み時の自動補正の通知(エラーではない。その場再生への変換・サイズ調整) */
  const [warnings, setWarnings] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [genText, setGenText] = useState("");
  // AIで直す対象(nullなら新規生成モード)
  const [reviseTarget, setReviseTarget] = useState<{ id: string; name: string } | null>(null);
  // 動画から取り込み(完全ローカル・無料)
  const videoRef = useRef<HTMLInputElement>(null);
  const capBusy = useScene3dRun((s) => s.captureBusy);
  const setCapBusy = useScene3dRun((s) => s.setCaptureBusy);
  const capError = useScene3dRun((s) => s.captureError);
  const setCapError = useScene3dRun((s) => s.setCaptureError);
  // 待ち時間の推定ゲージ用の開始時刻(実進捗が取れない処理なので経過時間で見せる)
  const capStartedAt = useScene3dRun((s) => s.captureStartedAt);
  const setCapStartedAt = useScene3dRun((s) => s.setCaptureStartedAt);

  const captureFromFile = async (file: File) => {
    setCapBusy("準備中…");
    setCapStartedAt((prev) => prev ?? Date.now());
    setCapError(null);
    try {
      const spec = await captureVideoToSpec(file, (msg) => setCapBusy(msg));
      // 取り込みはMixamo規格(Y Bot)で再生する(2026-07-22移行)。旧specは標準リグのまま
      const template = spec.rig === "mixamo" ? await loadCaptureRig() : getBuiltinTemplate();
      if (!template) throw new Error("標準ライブラリの読み込み待ちです。少し待ってからもう一度");
      const id = `gen-${Date.now()}`;
      const clip = buildGeneratedClip(template, spec, id);
      const entry = registerGeneratedClip(id, spec.name, clip, spec.plants, spec.rig);
      if (!entry) throw new Error("クリップの登録に失敗しました");
      saveGeneratedSpec(id, spec);
      registerImportedMotions([entry]);
      setEntityMotionClip(entityId, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCapError(msg.slice(0, 200));
    } finally {
      setCapBusy(null);
      setCapStartedAt(null);
      if (videoRef.current) videoRef.current.value = "";
    }
  };

  const onCaptureVideo = async (file: File | null) => {
    if (!file || capBusy) return;
    await captureFromFile(file);
  };

  // URLから取り込み(直リンクの動画をRust側でダウンロードして同じ経路へ流す)
  const [capUrl, setCapUrl] = useState("");
  const onCaptureFromUrl = async () => {
    const url = capUrl.trim();
    if (!url || capBusy) return;
    setCapBusy("動画をダウンロード中…");
    setCapStartedAt(Date.now());
    setCapError(null);
    let file: File;
    try {
      const data = await invoke<ArrayBuffer>("scene3d_fetch_capture_video", { url });
      let name = "";
      try {
        name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      } catch {
        // URLが解析できなくてもデフォルト名で続行
      }
      file = new File([data], name || "URL動画.mp4");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCapError(msg.slice(0, 200));
      setCapBusy(null);
      setCapStartedAt(null);
      return;
    }
    setCapUrl("");
    await captureFromFile(file);
  };
  const genBusy = useScene3dRun((s) => s.motionGenerating);
  const setGenBusy = useScene3dRun((s) => s.setMotionGenerating);
  const genError = useScene3dRun((s) => s.motionGenerationError);
  const setGenError = useScene3dRun((s) => s.setMotionGenerationError);
  // AIモーション生成も実進捗が取れないため、開始時刻から推定ゲージを出す
  const genStartedAt = useScene3dRun((s) => s.motionGenerationStartedAt);
  const setGenStartedAt = useScene3dRun((s) => s.setMotionGenerationStartedAt);

  // 標準ライブラリ(同梱CC0・46種)を初回に自動読み込み
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await loadBuiltinMotions();
        if (!cancelled) registerImportedMotions(items);
      } catch (e) {
        if (!cancelled) setErrors((prev) => [...prev, String(e)]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entity = project.entities.find((e) => e.id === entityId);
  const activeClipId = entity?.motion?.type === "clip" ? entity.motion.clipId : null;
  const match = (name: string) => name.toLowerCase().includes(filter.toLowerCase());
  const builtin = importedMotions.filter((m) => m.id.startsWith("builtin-") && match(m.name));
  const generated = importedMotions.filter((m) => m.id.startsWith("gen-") && match(m.name));
  const imported = importedMotions.filter(
    (m) => !m.id.startsWith("builtin-") && !m.id.startsWith("gen-") && match(m.name),
  );

  // AIモーション生成: Codexにキーフレーム仕様を書かせ、標準リグの上に組み立てる。
  // reviseTarget があれば新規でなく既存生成モーションの改訂(会話でリグ調整)
  const onGenerate = async () => {
    const text = genText.trim();
    if (!text || genBusy) return;
    setGenBusy(true);
    setGenStartedAt(Date.now());
    setGenError(null);
    try {
      if (reviseTarget) {
        const entry = await reviseGeneratedMotion(reviseTarget.id, text);
        setEntityMotionClip(entityId, entry.id);
        setReviseTarget(null);
        setGenText("");
        return;
      }
      // AI生成もMixamo規格(Y Bot)で作る。AIはMixamoの骨名の方が学習量が多く間違いが減る
      const template = await loadCaptureRig();
      const { systemPrompt, prompt } = buildMotionPrompt(text, "mixamo");
      // モーション設計は考える時間が長い(60秒では足りない実測あり)ため3分まで待つ
      const res = await codexTextQuery({ prompt, systemPrompt, expectJson: true, timeoutSecs: 180 });
      const parsed = res.parsedJson;
      // 配列をspreadするとオブジェクト化されて検証をすり抜けるため除外(Codex Verifier指摘)
      const spec = validateGeneratedSpec(
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? { ...(parsed as object), rig: "mixamo" }
          : parsed,
      );
      const id = `gen-${Date.now()}`;
      const clip = buildGeneratedClip(template, spec, id);
      const entry = registerGeneratedClip(id, spec.name, clip, undefined, spec.rig);
      if (!entry) throw new Error("モーションの登録に失敗しました");
      // 速度を登録してから割り当てる(割当時に speed が焼き込まれるため順序が重要)
      if (spec.moveSpeed != null) registerClipSpeed(id, spec.moveSpeed);
      saveGeneratedSpec(id, spec);
      registerImportedMotions([entry]);
      setEntityMotionClip(entityId, id);
      setGenText("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGenError(msg.slice(0, 200));
    } finally {
      setGenBusy(false);
      setGenStartedAt(null);
    }
  };

  const onRemoveGenerated = (id: string) => {
    unregisterMotion(id);
    removeGeneratedSpec(id);
    removeImportedMotion(id);
  };

  const motionBtnCls = (active: boolean) =>
    `truncate rounded-lg border px-2 py-2 text-left text-xs ${
      active
        ? "border-lime-400 bg-lime-400/10 text-lime-300"
        : "border-[#2a2a2a] bg-[#101010] text-neutral-300 hover:border-lime-400/50"
    }`;

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setErrors([]);
    const { ok, errors: errs, warnings: warns } = await importMotionFiles(Array.from(list));
    registerImportedMotions(ok);
    setErrors(errs);
    setWarnings(warns);
    setBusy(false);
  };

  return (
    <Popup title="動きをつける" onClose={onClose}>
      {/* 動画から取り込む(完全ローカル・無料。MediaPipe同梱)。主役機能なので先頭に置く */}
      <div className="mb-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-2.5">
        <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-bold tracking-wide text-emerald-300">
          <ClapperIcon />
          動画から動きを取り込む(β)
        </p>
        <input
          ref={videoRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/*"
          className="hidden"
          onChange={(e) => void onCaptureVideo(e.target.files?.[0] ?? null)}
        />
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/20 disabled:opacity-50"
          disabled={!!capBusy}
          onClick={() => videoRef.current?.click()}
        >
          {capBusy ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-200 border-t-transparent" />
              {capBusy}
            </>
          ) : (
            <>
              <FolderIcon />
              動画ファイルを選ぶ…(mp4/mov/webm・20秒まで)
            </>
          )}
        </button>
        <p className="mt-1.5 text-[11px] text-neutral-500">手ブレ・パン・ズームのある動画は再現精度が落ちます。カメラ固定の動画がおすすめ</p>
        {capBusy && capStartedAt ? (
          <div className="mt-1.5">
            <GenerationGauge startedAt={capStartedAt} mode="batch" />
          </div>
        ) : null}
        <div className="mt-1.5 flex gap-1.5">
          <input
            type="text"
            value={capUrl}
            onChange={(e) => setCapUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCaptureFromUrl();
            }}
            /* placeholder には SVG を入れられないので、絵文字は外して文言だけにする */
            placeholder="または動画のURLを貼る(ページURLもOK)"
            className="min-w-0 flex-1 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-emerald-400/60 focus:outline-none"
            disabled={!!capBusy}
          />
          <button
            className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-400/20 disabled:opacity-50"
            onClick={() => void onCaptureFromUrl()}
            disabled={!!capBusy || !capUrl.trim()}
          >
            取り込む
          </button>
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-neutral-500">
          全身が映った実写の動画から、動きだけをキャラに写します(映像は取り込みません)。
          処理は全てこのPC内で完結します。自分で撮った動画・権利のある映像を使ってください。
          URLは動画の直リンクのほか、PCに yt-dlp が入っていれば動画ページのURLにも対応します
        </p>
        {capError && (
          <p className="mt-1 rounded border border-red-500/30 bg-red-500/10 p-1.5 text-[11px] text-red-300">
            {capError}
          </p>
        )}
      </div>

      {/* AIモーション生成(Codex) */}
      <div className="mb-3 rounded-lg border border-sky-400/25 bg-sky-400/5 p-2.5">
        <p className="mb-1.5 text-[11px] font-bold tracking-wide text-sky-300">
          {reviseTarget ? (
            <>
              「{reviseTarget.name}」をAIで直す{" "}
              <button
                className="ml-1 font-normal text-neutral-500 underline hover:text-neutral-300"
                onClick={() => setReviseTarget(null)}
              >
                やめる
              </button>
            </>
          ) : (
            "AIでモーションを作る"
          )}
        </p>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={genText}
            onChange={(e) => setGenText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onGenerate();
            }}
            placeholder={
              reviseTarget
                ? "例: もっと高く跳ぶ / 着地でしゃがむ / 半分の速さで"
                : "例: 大きく手を振る / 深くお辞儀する / ガッツポーズ"
            }
            className="min-w-0 flex-1 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-sky-400/60 focus:outline-none"
            disabled={genBusy}
          />
          <button
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-400/20 disabled:opacity-50"
            onClick={() => void onGenerate()}
            disabled={genBusy || !genText.trim()}
          >
            {genBusy && (
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-200 border-t-transparent" />
            )}
            {genBusy ? (reviseTarget ? "改訂中…" : "生成中…") : reviseTarget ? "直す" : "生成"}
          </button>
        </div>
        {genBusy && genStartedAt ? (
          <div className="mt-1.5">
            <GenerationGauge startedAt={genStartedAt} mode="batch" />
          </div>
        ) : null}
        <p className="mt-1.5 text-[10px] leading-4 text-neutral-500">
          キャラの動きをAIが手付けします(30秒〜2分ほど)。当たり外れがあるので、
          気に入らなければ言い方を変えてもう一度
        </p>
        {genError && (
          <p className="mt-1 rounded border border-red-500/30 bg-red-500/10 p-1.5 text-[11px] text-red-300">
            {genError}
          </p>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".fbx,.glb,.gltf"
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button
        className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[#3a3a3a] px-3 py-2.5 text-sm text-neutral-400 hover:border-pink-400/60 hover:text-pink-300 disabled:opacity-50"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {busy && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-400/60 border-t-transparent" />
        )}
        {busy ? "読み込み中…" : "モーションを読み込む…(FBX/GLB、複数選択可)"}
      </button>
      <p className="mb-3 text-[11px] leading-4 text-neutral-500">
        Mixamoの場合: FBX Binary / With Skin でダウンロードしたファイルを選択。
        まとめてShift選択で一気に取り込めます
      </p>

      {errors.length > 0 && (
        <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-300">
          {errors.map((er, i) => (
            <p key={i}>{er}</p>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mb-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-[11px] text-amber-200">
          {warnings.map((wr, i) => (
            <p key={i}>{wr}</p>
          ))}
        </div>
      )}

      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="モーションを検索…"
        className="mb-2 w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
      />

      {generated.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] font-bold tracking-wide text-neutral-500">
            AIで作ったモーション({generated.length})
          </p>
          <div className="mb-3 grid max-h-32 grid-cols-3 gap-1.5 overflow-y-auto">
            {generated.map((m) => (
              <div key={m.id} className="relative">
                <button
                  className={`w-full ${motionBtnCls(activeClipId === m.id)} pr-5`}
                  onClick={() => setEntityMotionClip(entityId, m.id)}
                  title={`${m.name} を割り当てる`}
                >
                  {m.name}
                </button>
                <button
                  className="absolute right-1 top-1.5 text-neutral-600 hover:text-red-400"
                  onClick={() => onRemoveGenerated(m.id)}
                  title="このAIモーションを削除"
                  aria-label="このAIモーションを削除"
                >
                  <CloseIcon className="h-2.5 w-2.5" />
                </button>
                <button
                  className="absolute bottom-1.5 right-1 text-neutral-600 hover:text-sky-300"
                  onClick={() => setReviseTarget({ id: m.id, name: m.name })}
                  title="このAIモーションを会話で直す(元は残る)"
                  aria-label="このAIモーションを会話で直す"
                >
                  <PencilIcon />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="mb-1.5 text-[11px] font-bold tracking-wide text-neutral-500">
        標準ライブラリ(CC0・{builtin.length}種) —{" "}
        <span className="text-sky-400">移動</span> 付きは旗の行き先まで移動します
      </p>
      {builtin.length === 0 ? (
        <p className="mb-2 text-xs text-neutral-600">読み込み中…</p>
      ) : (
        <div className="mb-3 grid max-h-48 grid-cols-3 gap-1.5 overflow-y-auto">
          {builtin.map((m) => (
            <button
              key={m.id}
              className={motionBtnCls(activeClipId === m.id)}
              onClick={() => setEntityMotionClip(entityId, m.id)}
              title={
                resolveClipSpeed(m.id, m.name) > 0
                  ? `${m.name} を割り当てる(旗の行き先まで移動)`
                  : `${m.name} を割り当てる`
              }
            >
              {resolveClipSpeed(m.id, m.name) > 0 && (
                <span className="mr-1 rounded bg-sky-400/15 px-1 text-[9px] text-sky-300">
                  移動
                </span>
              )}
              {m.name}
            </button>
          ))}
        </div>
      )}

      {imported.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] font-bold tracking-wide text-neutral-500">
            読み込んだモーション({imported.length}) —{" "}
            <span className="text-neutral-400">その場</span> 付きは旗を立てても移動しません
          </p>
          <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto">
            {imported.map((m) => {
              // 写真・動画から起こしたクリップは平行移動を持たない(resolveClipSpeed が
              // 必ず0)。バッジが「無い」だけだと「動くはずなのに動かない」に見えるので、
              // その場再生であることを明示する(速度を捏造して歩かせるのは誤動作)
              const moves = resolveClipSpeed(m.id, m.name) > 0;
              return (
                <button
                  key={m.id}
                  className={motionBtnCls(activeClipId === m.id)}
                  onClick={() => setEntityMotionClip(entityId, m.id)}
                  title={
                    moves
                      ? `${m.name} を割り当てる(旗の行き先まで移動)`
                      : `${m.name} を割り当てる(その場で再生。旗を立てても移動しません)`
                  }
                >
                  {moves ? (
                    <span className="mr-1 rounded bg-sky-400/15 px-1 text-[9px] text-sky-300">
                      移動
                    </span>
                  ) : (
                    <span className="mr-1 rounded bg-neutral-500/15 px-1 text-[9px] text-neutral-400">
                      その場
                    </span>
                  )}
                  {m.name}
                </button>
              );
            })}
          </div>
        </>
      )}
    </Popup>
  );
}

/**
 * 到着後アクションのポップアップ(モーションミックス第1弾)。
 * 標準ライブラリ(骨格を共有)から「着いたあとの動き」を選ぶ。既定は待機
 */
function ArrivalMotionPopup({
  entityId,
  append = false,
  overlay = false,
  onClose,
}: {
  entityId: string;
  /** true: 既存の列に追加する(モーション連結) / false: 単発で置き換える */
  append?: boolean;
  /** true: 上半身レイヤーとして設定する(並列レイヤー) */
  overlay?: boolean;
  onClose: () => void;
}) {
  const importedMotions = useScene3d((s) => s.importedMotions);
  const registerImportedMotions = useScene3d((s) => s.registerImportedMotions);
  const setEntityArrivalClip = useScene3d((s) => s.setEntityArrivalClip);
  const appendEntityArrivalStep = useScene3d((s) => s.appendEntityArrivalStep);
  const setEntityOverlayClip = useScene3d((s) => s.setEntityOverlayClip);
  const project = useScene3d((s) => s.project);

  // 標準ライブラリ未読み込みなら読み込む(通常はWorkspace起動時に読み込み済み)
  useEffect(() => {
    void loadBuiltinMotions()
      .then(registerImportedMotions)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const entity = project.entities.find((e) => e.id === entityId);
  const current = entity?.motion?.type === "clip" ? entity.motion.arrivalClipId : undefined;
  // 標準ライブラリ + AI生成(どちらも同じ骨格なので到着後に切替できる)
  const builtin = importedMotions.filter(
    (m) => m.id.startsWith("builtin-") || m.id.startsWith("gen-"),
  );

  const btnCls = (active: boolean) =>
    `truncate rounded-lg border px-2 py-2 text-left text-xs ${
      active
        ? "border-sky-400 bg-sky-400/10 text-sky-300"
        : "border-[#2a2a2a] bg-[#101010] text-neutral-300 hover:border-sky-400/50"
    }`;

  return (
    <Popup title="着いたらどうする？" onClose={onClose}>
      <p className="mb-2 text-[11px] leading-4 text-neutral-500">
        行き先に着いたあとの動きです。「座る(動作)」など一回きりの動きは、最後の姿勢で止まります
      </p>
      <button
        className={`mb-2 w-full ${btnCls(current == null)}`}
        onClick={() => {
          setEntityArrivalClip(entityId, null);
          onClose();
        }}
      >
        待機(既定)
      </button>
      <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto">
        {builtin.map((m) => (
          <button
            key={m.id}
            className={btnCls(current === m.id)}
            onClick={() => {
              if (overlay) setEntityOverlayClip(entityId, m.id);
              else if (append) appendEntityArrivalStep(entityId, m.id);
              else setEntityArrivalClip(entityId, m.id);
              onClose();
            }}
            title={`着いたら ${m.name}`}
          >
            {m.name}
          </button>
        ))}
      </div>
    </Popup>
  );
}

/**
 * オブジェクト詳細設定(位置・回転・大きさ・寸法・階数)。
 * ポップアップではなく「詳細を調整」ボタン下のトグル展開で表示する
 * (中央ポップアップは作業ビューを隠すため。移動不可のモーダルは使わない)
 */
function ObjectDetailBody({ entityId }: { entityId: string }) {
  const project = useScene3d((s) => s.project);
  const moveEntity = useScene3d((s) => s.moveEntity);
  const scaleEntity = useScene3d((s) => s.scaleEntity);
  const setEntityRotation = useScene3d((s) => s.setEntityRotation);
  const setEntityFloors = useScene3d((s) => s.setEntityFloors);
  const setEntityParam = useScene3d((s) => s.setEntityParam);

  const entity = project.entities.find((e) => e.id === entityId);
  if (!entity) return null;
  const kind = entity.kind;
  const p = entity.params ?? {};
  const toDeg = (rad: number) => {
    // -180〜180 に正規化(向きスライダーは 0〜360 で保存するため)
    const deg = Math.round((rad * 180) / Math.PI);
    return ((deg + 180) % 360 + 360) % 360 - 180;
  };
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0c0c0c] p-2.5">
      <div className="flex flex-col gap-2.5">
        <p className="text-[10px] font-bold tracking-wide text-neutral-500">位置</p>
        <AxisSlider
          label="横"
          value={entity.position[0]}
          min={-15}
          max={15}
          onChange={(v) => moveEntity(entity.id, [v, entity.position[1], entity.position[2]])}
        />
        <AxisSlider
          label="高さ"
          value={entity.position[1]}
          min={0}
          max={10}
          onChange={(v) => moveEntity(entity.id, [entity.position[0], v, entity.position[2]])}
        />
        <AxisSlider
          label="奥"
          value={entity.position[2]}
          min={-15}
          max={15}
          onChange={(v) => moveEntity(entity.id, [entity.position[0], entity.position[1], v])}
        />

        <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">
          回転(度)。BlenderのR相当: 前後の傾き / 向き / 左右の傾き
        </p>
        <AxisSlider
          label="傾きX"
          value={toDeg(entity.rotationX ?? 0)}
          min={-180}
          max={180}
          step={5}
          onChange={(v) => setEntityRotation(entity.id, "x", toRad(v))}
        />
        <AxisSlider
          label="向きY"
          value={toDeg(entity.rotationY)}
          min={-180}
          max={180}
          step={5}
          onChange={(v) => setEntityRotation(entity.id, "y", toRad(v))}
        />
        <AxisSlider
          label="傾きZ"
          value={toDeg(entity.rotationZ ?? 0)}
          min={-180}
          max={180}
          step={5}
          onChange={(v) => setEntityRotation(entity.id, "z", toRad(v))}
        />

        <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">大きさ</p>
        <AxisSlider
          label="倍率"
          value={entity.scale}
          min={0.3}
          max={4}
          onChange={(v) => scaleEntity(entity.id, v)}
        />

        {kind === "wall" && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">寸法</p>
            <AxisSlider label="横幅" value={p.width ?? 3} min={0.5} max={20} onChange={(v) => setEntityParam(entity.id, "width", v)} />
            <AxisSlider label="高さ" value={p.height ?? 2.6} min={0.5} max={12} onChange={(v) => setEntityParam(entity.id, "height", v)} />
          </>
        )}
        {kind === "box" && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">寸法</p>
            <AxisSlider label="横幅" value={p.width ?? 0.8} min={0.1} max={10} onChange={(v) => setEntityParam(entity.id, "width", v)} />
            <AxisSlider label="高さ" value={p.height ?? 0.8} min={0.1} max={10} onChange={(v) => setEntityParam(entity.id, "height", v)} />
            <AxisSlider label="奥行" value={p.depth ?? 0.8} min={0.1} max={10} onChange={(v) => setEntityParam(entity.id, "depth", v)} />
          </>
        )}
        {kind === "building" && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">建物</p>
            <AxisSlider label="階数" value={p.floors ?? 3} min={1} max={12} step={1} onChange={(v) => setEntityFloors(entity.id, v)} />
          </>
        )}
      </div>
    </div>
  );
}

/** 選択中オブジェクト(シンプル表示。細かい調整は詳細ポップアップへ) */
function SelectedObjectSection() {
  const project = useScene3d((s) => s.project);
  const selectedEntityId = useScene3d((s) => s.selectedEntityId);
  const rotateEntity = useScene3d((s) => s.rotateEntity);
  const setEntityMotion = useScene3d((s) => s.setEntityMotion);
  const importedMotions = useScene3d((s) => s.importedMotions);
  const [detailOpen, setDetailOpen] = useState(false);
  const motionLibOpen = useScene3dRun((s) => s.motionLibraryOpen);
  const setMotionLibOpen = useScene3dRun((s) => s.setMotionLibraryOpen);
  const [arrivalPickerOpen, setArrivalPickerOpen] = useState(false);
  const [arrivalAppendOpen, setArrivalAppendOpen] = useState(false);
  const removeEntityArrivalStep = useScene3d((s) => s.removeEntityArrivalStep);
  const setEntityLookAt = useScene3d((s) => s.setEntityLookAt);
  const setEntityOverlayClip = useScene3d((s) => s.setEntityOverlayClip);
  const [overlayPickerOpen, setOverlayPickerOpen] = useState(false);
  const bodyDrawEntityId = useScene3d((s) => s.bodyDrawEntityId);
  const setBodyDrawEntityId = useScene3d((s) => s.setBodyDrawEntityId);

  const entity = project.entities.find((e) => e.id === selectedEntityId);
  if (!entity) return null;

  // 道を描けるのは「移動する」モーションのときだけ(立ち・倒れる・その場再生は道を持たない)
  const canDrawPath =
    entity.motion?.type === "walk" ||
    entity.motion?.type === "run" ||
    (entity.motion?.type === "clip" && (entity.motion.speed ?? 0) > 0);
  const bodyDrawing = bodyDrawEntityId === entity.id;

  const degrees = ((Math.round((entity.rotationY * 180) / Math.PI) % 360) + 360) % 360;
  const motionType = entity.motion?.type ?? null;
  const arrivalClipId = entity.motion?.type === "clip" ? entity.motion.arrivalClipId : undefined;
  // 連結列(あれば単発より優先で表示)
  const arrivalSeq =
    entity.motion?.type === "clip" ? (entity.motion.arrivalSequence ?? null) : null;
  const clipNameOf = (id: string) => importedMotions.find((m) => m.id === id)?.name ?? "?";
  const arrivalName = arrivalSeq
    ? arrivalSeq.map((s) => clipNameOf(s.clipId)).join(" → ")
    : arrivalClipId
      ? (importedMotions.find((m) => m.id === arrivalClipId)?.name ?? "待機")
      : "待機";
  const motionBtn = (active: boolean) =>
    `rounded-lg border px-2 py-1.5 text-xs ${
      active
        ? "border-lime-400 bg-lime-400/10 text-lime-300"
        : "border-[#2a2a2a] bg-[#101010] text-neutral-300 hover:border-lime-400/50"
    }`;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <p className="flex items-center gap-2 text-[11px] font-bold tracking-wide text-amber-400/90">
        <EntityKindIcon kind={entity.kind} />
        {entity.label}
      </p>

      {/* AIで動きをつける導線を、手で選ぶ「歩く/走る」より上に出す。なぜ: 目玉機能が
          プリセットの下に埋もれて見つからない(2026-07-26 指摘) */}
      {entity.kind === "mannequin" && (
        <button
          className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs ${
            motionType === "clip"
              ? "border-lime-400 bg-lime-400/10 text-lime-300"
              : "border-[#2a2a2a] text-neutral-400 hover:border-lime-400/50 hover:text-neutral-200"
          }`}
          onClick={() => setMotionLibOpen(true)}
        >
          <ClapperIcon />
          <span>
            <span className="font-bold">動きをつける…</span>
            <span className="block text-[10px] opacity-70">
              言葉から AI生成 / 実写動画から取り込み / ライブラリから選ぶ
            </span>
          </span>
        </button>
      )}

      {entity.kind === "mannequin" && (
        <p className="text-[10px] leading-4 text-neutral-600">
          かんたんな移動だけなら下から選べます
        </p>
      )}

      {entity.kind === "mannequin" ? (
        <div className="grid grid-cols-3 gap-1.5">
          <button className={motionBtn(motionType === null)} onClick={() => setEntityMotion(entity.id, null)}>
            立ち
          </button>
          <button className={motionBtn(motionType === "walk")} onClick={() => setEntityMotion(entity.id, "walk")}>
            歩く
          </button>
          <button className={motionBtn(motionType === "run")} onClick={() => setEntityMotion(entity.id, "run")}>
            走る
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          <button className={motionBtn(motionType === null)} onClick={() => setEntityMotion(entity.id, null)}>
            静止
          </button>
          <button className={motionBtn(motionType === "walk")} onClick={() => setEntityMotion(entity.id, "walk")} title="ゆっくり移動(1.4m/s)">
            動く
          </button>
          <button className={motionBtn(motionType === "run")} onClick={() => setEntityMotion(entity.id, "run")} title="速く移動(3.4m/s)">
            速く
          </button>
          <button className={motionBtn(motionType === "fall")} onClick={() => setEntityMotion(entity.id, "fall")} title="向いている方向へ倒れる">
            倒れる
          </button>
        </div>
      )}
      {canDrawPath && (
        <button
          className={`rounded-lg border px-2 py-1.5 text-xs ${
            bodyDrawing
              ? "border-sky-400 bg-sky-400/10 text-sky-300"
              : "border-[#2a2a2a] text-neutral-400 hover:border-sky-400/60 hover:text-neutral-200"
          }`}
          onClick={() => setBodyDrawEntityId(bodyDrawing ? null : entity.id)}
          title="ビューポートで一筆書きすると、この人物の通り道になる(今の場所から、描き終えた場所まで)"
        >
          {bodyDrawing ? "描いてください…(Escで中止)" : "移動の道を手で描く"}
        </button>
      )}
      {motionType && motionType !== "clip" && motionType !== "fall" && (
        <p className="text-[10px] leading-4 text-neutral-500">
          旗をドラッグで行き先を変更。再生で動き出します
        </p>
      )}
      {motionType === "fall" && (
        <p className="text-[10px] leading-4 text-neutral-500">
          再生で向いている方向へ倒れます(向きスライダーで倒れる方向を変更)
        </p>
      )}
      {entity.kind === "mannequin" &&
        entity.motion?.type === "clip" &&
        (entity.motion.speed ?? 0) > 0 && (
          <p className="text-[10px] leading-4 text-neutral-500">
            移動モーション: 旗をドラッグで行き先を変更できます
          </p>
        )}
      {/* 到着後アクション(標準ライブラリ/AI生成のみ。骨格を共有するため) */}
      {entity.kind === "mannequin" &&
        entity.motion?.type === "clip" &&
        (entity.motion.speed ?? 0) > 0 &&
        (entity.motion.clipId.startsWith("builtin-") ||
          entity.motion.clipId.startsWith("gen-")) && (
          <>
            <button
              className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-left text-xs text-neutral-300 hover:border-sky-400/50"
              onClick={() => setArrivalPickerOpen(true)}
              title="行き先に着いたあとの動きを選ぶ"
            >
              着いたら: <span className="text-sky-300">{arrivalName}</span>
            </button>
            {/* モーション連結: 着いたあとの動きを列でつなぐ(つなぎ目は自動で滑らかに混ざる) */}
            <div className="flex flex-wrap items-center gap-1">
              {(arrivalSeq ?? []).map((s, i) => (
                <span
                  key={`${s.clipId}-${i}`}
                  className="flex items-center gap-1 rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-200"
                >
                  {clipNameOf(s.clipId)}
                  <button
                    className="text-sky-400/70 hover:text-red-300"
                    onClick={() => removeEntityArrivalStep(entity.id, i)}
                    title="この動きを列から外す"
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                className="rounded border border-dashed border-[#3a3a3a] px-1.5 py-0.5 text-[10px] text-neutral-500 hover:border-sky-400/60 hover:text-sky-300"
                onClick={() => setArrivalAppendOpen(true)}
                title="着いたあとの動きをさらにつなげる(つなぎ目は自動で滑らかに)"
              >
                ＋つなげる
              </button>
            </div>
            {arrivalPickerOpen && (
              <ArrivalMotionPopup
                entityId={entity.id}
                onClose={() => setArrivalPickerOpen(false)}
              />
            )}
            {arrivalAppendOpen && (
              <ArrivalMotionPopup
                entityId={entity.id}
                append
                onClose={() => setArrivalAppendOpen(false)}
              />
            )}
          </>
        )}
      {motionLibOpen && (
        <MotionLibraryPopup entityId={entity.id} onClose={() => setMotionLibOpen(false)} />
      )}

      {/* 並列レイヤー: 上半身だけ別クリップを重ねる(走りながら手を振る等) */}
      {entity.kind === "mannequin" && entity.motion?.type === "clip" && (
        <div className="flex items-center gap-1.5">
          <button
            className="min-w-0 flex-1 truncate rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-left text-xs text-neutral-300 hover:border-violet-400/50"
            onClick={() => setOverlayPickerOpen(true)}
            title="上半身(腕・手・首・頭)だけ別の動きを重ねる"
          >
            上半身で重ねる:{" "}
            <span className="text-violet-300">
              {entity.motion.overlayClipId ? clipNameOf(entity.motion.overlayClipId) : "なし"}
            </span>
          </button>
          {entity.motion.overlayClipId && (
            <button
              className="shrink-0 text-neutral-600 hover:text-red-300"
              onClick={() => setEntityOverlayClip(entity.id, null)}
              title="上半身レイヤーを外す"
              aria-label="上半身レイヤーを外す"
            >
              <CloseIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {overlayPickerOpen && (
        <ArrivalMotionPopup
          entityId={entity.id}
          overlay
          onClose={() => setOverlayPickerOpen(false)}
        />
      )}

      {/* 視線ノード(TRACK_TO相当): 頭が相手を追い続ける */}
      {entity.kind === "mannequin" && (
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          視線(頭が追う相手)
          <select
            className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-sm text-neutral-200"
            value={entity.lookAt ?? ""}
            onChange={(e) => setEntityLookAt(entity.id, e.target.value || null)}
          >
            <option value="">なし</option>
            <option value="__camera">カメラ(撮っているカメラ)</option>
            {project.entities
              .filter((en) => en.id !== entity.id)
              .map((en) => (
                <option key={en.id} value={en.id}>
                  {en.label}
                </option>
              ))}
          </select>
        </label>
      )}

      <p className="text-[10px] leading-4 text-neutral-600">
        ドラッグ中にキー長押し: X=横 / Y=奥行き / Z=高さ / R=回転 / S=大きさ
      </p>

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

      <button
        className="flex items-center gap-1.5 rounded-lg border border-[#2a2a2a] px-2 py-1.5 text-left text-xs text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200"
        onClick={() => setDetailOpen((o) => !o)}
      >
        {detailOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
        詳細を調整(位置・回転・大きさ・寸法)
      </button>
      {detailOpen && <ObjectDetailBody entityId={entity.id} />}
    </div>
  );
}

/** カメラ位置の調整ポップアップ(開始・終了・注視点) */
function CameraPositionPopup({ onClose }: { onClose: () => void }) {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const moveCameraEndpoint = useScene3d((s) => s.moveCameraEndpoint);
  const setCameraLookAtPos = useScene3d((s) => s.setCameraLookAtPos);

  const shot = getSelectedShot({ project, selectedShotId });
  const camera = getShotMove(project, shot);
  const la = camera.lookAtPos ?? [0, 1, 0];

  return (
    <Popup title="カメラ位置を調整" onClose={onClose}>
      <div className="flex flex-col gap-2.5">
        <p className="text-[10px] font-bold tracking-wide text-neutral-500">開始位置(カメラ本体)</p>
        <AxisSlider label="横" value={camera.startPos[0]} min={-15} max={15} onChange={(v) => moveCameraEndpoint("start", [v, camera.startPos[1], camera.startPos[2]])} />
        <AxisSlider label="高さ" value={camera.startPos[1]} min={0.1} max={12} onChange={(v) => moveCameraEndpoint("start", [camera.startPos[0], v, camera.startPos[2]])} />
        <AxisSlider label="奥" value={camera.startPos[2]} min={-15} max={15} onChange={(v) => moveCameraEndpoint("start", [camera.startPos[0], camera.startPos[1], v])} />

        {camera.preset !== "fixed" && camera.preset !== "orbit" && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">終了位置(赤点)</p>
            <AxisSlider label="横" value={camera.endPos[0]} min={-15} max={15} onChange={(v) => moveCameraEndpoint("end", [v, camera.endPos[1], camera.endPos[2]])} />
            <AxisSlider label="高さ" value={camera.endPos[1]} min={0.1} max={12} onChange={(v) => moveCameraEndpoint("end", [camera.endPos[0], v, camera.endPos[2]])} />
            <AxisSlider label="奥" value={camera.endPos[2]} min={-15} max={15} onChange={(v) => moveCameraEndpoint("end", [camera.endPos[0], camera.endPos[1], v])} />
          </>
        )}

        {camera.targetEntityId == null && (
          <>
            <p className="mt-1 text-[10px] font-bold tracking-wide text-neutral-500">
              注視点(カメラが見る場所。被写体とは連動しない)
            </p>
            <AxisSlider label="横" value={la[0]} min={-15} max={15} onChange={(v) => setCameraLookAtPos([v, la[1], la[2]])} />
            <AxisSlider label="高さ" value={la[1]} min={0} max={12} onChange={(v) => setCameraLookAtPos([la[0], v, la[2]])} />
            <AxisSlider label="奥" value={la[2]} min={-15} max={15} onChange={(v) => setCameraLookAtPos([la[0], la[1], v])} />
          </>
        )}
      </div>
    </Popup>
  );
}

function DirectorPanel() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const setCameraTarget = useScene3d((s) => s.setCameraTarget);
  const resetCameraWork = useScene3d((s) => s.resetCameraWork);
  const pathDrawMode = useScene3d((s) => s.pathDrawMode);
  const setPathDrawMode = useScene3d((s) => s.setPathDrawMode);
  const setLens = useScene3d((s) => s.setLens);
  const setOrbitDegrees = useScene3d((s) => s.setOrbitDegrees);
  const setShotDurationFrames = useScene3d((s) => s.setShotDurationFrames);
  const setAspectRatio = useScene3d((s) => s.setAspectRatio);
  const [presetOpen, setPresetOpen] = useState(false);
  const [camPosOpen, setCamPosOpen] = useState(false);
  const selectedEntityId = useScene3d((s2) => s2.selectedEntityId);
  const hasEntity = project.entities.some((e) => e.id === selectedEntityId);
  const [objH, setObjH] = useState(() => {
    const saved = Number(localStorage.getItem("scene3d.panel.objH"));
    return Number.isFinite(saved) && saved >= 120 && saved <= 500 ? saved : 240;
  });
  const objHState = useRef<{ startY: number; startH: number } | null>(null);
  const updateObjH = (h: number) => {
    const clamped = Math.max(120, Math.min(500, Math.round(h)));
    setObjH(clamped);
    localStorage.setItem("scene3d.panel.objH", String(clamped));
  };

  const assignShotCamera = useScene3d((s) => s.assignShotCamera);
  const shot = getSelectedShot({ project, selectedShotId });
  const camera = getShotMove(project, shot);
  const usingCamera = project.cameras.find((c) => c.id === shot.cameraId) ?? project.cameras[0];
  const usedCount = project.shots.filter((sh) => sh.cameraId === shot.cameraId).length;

  return (
    <aside className="flex w-full flex-col overflow-hidden border-l border-[#242424] bg-[#141414]">
      {/* 最上段: 演出チャット(この画面の主役)。
          オブジェクト選択の有無に関わらず常に一番上に出す。なぜ: 下段に置くと
          オブジェクト選択時に240pxの上段に押し下げられて画面外になり、
          「AIに動きを組ませる」導線が見つからない(2026-07-26 指摘) */}
      <div className="shrink-0 border-b border-[#242424] px-4 pb-3 pt-4">
        <DirectorChat />
      </div>

      {/* 中段: 選択オブジェクト(高さは境界ドラッグで調整) */}
      {hasEntity && (
        <>
          <div style={{ height: objH }} className="shrink-0 overflow-y-auto px-4 pt-4">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              オブジェクト
            </p>
            <SelectedObjectSection />
          </div>
          <div
            className="group flex h-2 w-full shrink-0 cursor-row-resize items-center justify-center border-y border-[#242424] bg-[#181818] hover:bg-pink-400/20"
            onPointerDown={(e) => {
              objHState.current = { startY: e.clientY, startH: objH };
              (e.target as Element).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!objHState.current) return;
              updateObjH(objHState.current.startH + (e.clientY - objHState.current.startY));
            }}
            onPointerUp={(e) => {
              objHState.current = null;
              (e.target as Element).releasePointerCapture(e.pointerId);
            }}
          >
            <div className="h-0.5 w-8 rounded bg-[#3a3a3a] group-hover:bg-pink-300" />
          </div>
        </>
      )}

      {/* 下段: カット/カメラ/書き出し */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-neutral-600">
          カット
        </p>
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
          <option value="">(追わない — 固定の注視点)</option>
          {project.entities.map((en) => (
            <option key={en.id} value={en.id}>
              {en.label}
            </option>
          ))}
        </select>
      </label>

      <button
        className="rounded-lg border border-[#2a2a2a] px-2 py-1.5 text-xs text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200"
        onClick={() => setCamPosOpen(true)}
      >
        カメラ位置を調整…(開始・終了・注視点)
      </button>
      <button
        className={`rounded-lg border px-2 py-1.5 text-xs ${
          pathDrawMode
            ? "border-pink-400 bg-pink-400/10 text-pink-300"
            : "border-[#2a2a2a] text-neutral-400 hover:border-pink-400/60 hover:text-neutral-200"
        }`}
        onClick={() => setPathDrawMode(!pathDrawMode)}
        title="ビューポートで一筆書きするとカメラの通り道になる(始点・終点は固定)"
      >
        {pathDrawMode ? "描いてください…(Escで中止)" : "道を手で描く"}
      </button>
      <button
        className="rounded-lg border border-[#2a2a2a] px-2 py-1.5 text-xs text-neutral-400 hover:border-amber-400/60 hover:text-amber-200"
        onClick={() => resetCameraWork()}
        title="真珠の道・曲げを消して、元のカメラの動きに戻す"
      >
        カメラワークをリセット
      </button>
      {camPosOpen && <CameraPositionPopup onClose={() => setCamPosOpen(false)} />}

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

      <StoryboardImportSection />
      <ExportSection />
      </div>
      {presetOpen && <PresetPickerPopup onClose={() => setPresetOpen(false)} />}
    </aside>
  );
}

/**
 * 絵コンテの確定カットを読み出す (CHAIN-01)。
 *
 * 3D は localStorage に閉じた独立状態で、絵コンテで決めた尺・カメラ意図・採用画像が
 * 渡らずユーザーが全部手入力し直していた。ここで storyboardRun ストアから
 * 「確定(confirmed)カット + 採用テイク画像 + 絵コンテメタ(尺/意図/カメラノート)」
 * を取り出し、3D の shot 配列へ写せる形に整える。
 *
 * 読み方は CutGridReviewPanel と同じ流儀に合わせる:
 * 絵コンテメタは generationCutSketchMeta(本生成 run のスナップショット)を優先し、
 * 無ければ live sketchVersions にフォールバックする(reset() 前の経路用)。
 */
function readConfirmedStoryboardCuts(): StoryboardCutImport[] {
  const st = useStoryboardRun.getState();
  const sketchByCutId = new Map<string, StoryboardSketchCut>();
  for (const [cutId, cut] of Object.entries(st.generationCutSketchMeta)) {
    sketchByCutId.set(cutId, cut);
  }
  if (sketchByCutId.size === 0) {
    const active =
      st.sketchVersions.find((v) => v.versionId === st.activeSketchVersionId) ??
      st.sketchVersions[st.sketchVersions.length - 1] ??
      null;
    for (const c of active?.cuts ?? []) sketchByCutId.set(c.cutId, c);
  }

  const confirmed = Array.from(st.cuts.values()).filter((c) => c.status === "confirmed");
  return confirmed.map((c) => {
    const sketch = sketchByCutId.get(c.cutId) ?? null;
    const adopted = c.takes.find((t) => t.takeId === c.selectedTakeId) ?? c.takes[0];
    return {
      cutId: c.cutId,
      // 尺は絵コンテメタが正。無ければ 0 を渡して 3D 側の既定尺に任せる
      // (ここで適当な秒数を捏造すると「決めた尺」と区別が付かなくなる)
      durationSeconds: sketch?.durationSeconds ?? 0,
      imagePath: adopted?.imagePath,
      description: c.description ?? sketch?.intent,
      cameraNote: sketch?.cameraNote,
    };
  });
}

/** 絵コンテ → 3D の取り込み (CHAIN-01)。尺とカット数が入るだけで手入力が激減する */
function StoryboardImportSection() {
  const importStoryboardCuts = useScene3d((s) => s.importStoryboardCuts);
  const shotCount = useScene3d((s) => s.project.shots.length);
  const origins = useScene3d((s) => s.storyboardOrigins);
  const importedCount = Object.keys(origins).length;
  // 確定カット数は「絵コンテを確定して 3D に来た」導線でしか変わらないので、
  // ストア購読ではなくクリック時に読む(3D 編集中の再描画を増やさない)。
  const [pending, setPending] = useState<StoryboardCutImport[] | null>(null);

  const openPicker = () => {
    const cuts = readConfirmedStoryboardCuts();
    if (cuts.length === 0) {
      useToasts.getState().push({
        kind: "error",
        text: "確定した絵コンテのカットが見つかりません。ストーリーモードでカットを確定してください。",
        ttlMs: 4500,
      });
      return;
    }
    setPending(cuts);
  };

  const run = (mode: "append" | "replace") => {
    if (!pending) return;
    const n = importStoryboardCuts(pending, mode);
    setPending(null);
    useToasts.getState().push({
      kind: "success",
      text:
        mode === "replace"
          ? `絵コンテの${n}カットで作り直しました(尺を反映)。`
          : `絵コンテの${n}カットを追加しました(尺を反映)。`,
      ttlMs: 4000,
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[#242424] pt-3">
      <p className="text-[11px] font-bold tracking-wide text-neutral-500">絵コンテから読み込む</p>
      {pending ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] leading-4 text-neutral-400">
            確定カット
            <span className="font-mono tabular-nums"> {pending.length}</span> 件が見つかりました。
            今のカット
            <span className="font-mono tabular-nums"> {shotCount}</span> 本をどうしますか
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              className="rounded-lg border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-[11px] text-neutral-300 transition hover:border-neutral-500"
              onClick={() => run("append")}
            >
              残して追加
            </button>
            <button
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300 transition hover:border-amber-400"
              onClick={() => run("replace")}
            >
              作り直す
            </button>
          </div>
          <button
            className="self-start text-[10px] text-neutral-500 hover:text-neutral-300"
            onClick={() => setPending(null)}
          >
            やめる
          </button>
        </div>
      ) : (
        <button
          className="rounded-xl border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[12px] font-bold text-neutral-200 transition hover:border-neutral-500"
          onClick={openPicker}
        >
          絵コンテから読み込む
        </button>
      )}
      {importedCount > 0 && (
        <p className="text-[10px] leading-4 text-neutral-500">
          このシーンの
          <span className="font-mono tabular-nums"> {importedCount}</span>
          カットは絵コンテ由来です(尺・採用画像・意図を記録済み)
        </p>
      )}
      <p className="text-[10px] leading-4 text-neutral-500">
        カット数と尺だけを写します。カメラワークは初期値なので、ここでドラッグして決めます
      </p>
    </div>
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

  /**
   * 開始フレームPNGを動画タブの開始画像へ渡す (CHAIN-03)。
   *
   * これまで書き出し結果は Finder で開くだけで、動画タブへは手で渡し直していた。
   * sendCutToVideoTab は「スキルモードを抜けずに activeTab だけ video にする」実装なので、
   * 3D から呼んでも 3D の状態(localStorage 保存前のシーン)は失われない
   * (SkillWorkspaceRouter が scene3d の workspace を display:none で保持したまま
   *  動画タブをインライン描画する)。
   *
   * mp4 を「参照動画」として渡すのは今は出来ない: videoGen ストアに参照動画の口が無く、
   * 動画モデル側の受け口も未実装。よってパスの案内 + Finder 表示に留める(嘘の導線を作らない)。
   */
  const sendFirstFrameToVideo = (firstFramePath: string) => {
    sendCutToVideoTab({ imagePath: firstFramePath });
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
        className="flex items-center justify-center gap-2 rounded-xl bg-pink-500 px-3 py-2.5 text-[13px] font-bold text-white transition hover:bg-pink-400 disabled:opacity-50"
        disabled={busy}
        onClick={requestExport}
      >
        {busy && (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
        )}
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

          {/* CHAIN-03: 開始フレームPNGをそのまま動画タブの開始画像へ渡す。
              手渡し(Finderで開いて動画タブで選び直す)を省くための導線 */}
          {status.firstFramePath && (
            <button
              className="rounded-lg bg-pink-500/90 px-2 py-1.5 text-left text-[11px] font-bold text-white transition hover:bg-pink-400"
              onClick={() => sendFirstFrameToVideo(status.firstFramePath!)}
            >
              開始フレームを動画タブへ送る
            </button>
          )}
          {status.mp4Path && (
            <p className="text-[10px] leading-4 text-neutral-500">
              参照動画は動画タブからの自動セットに未対応です。上の mp4
              を書き出し先から手で選んでください
            </p>
          )}
        </div>
      )}
      {status.phase === "error" && (
        <p className="text-[11px] text-red-400">書き出し失敗: {status.message}</p>
      )}
      {/* 開始画像はボタンで動画タブへ渡せるが、参照動画は手渡しのままなので
          「どちらが自動か」を書き分ける(できない導線を約束しない) */}
      <p className="text-[11px] leading-4 text-neutral-500">
        開始フレームPNGは動画生成の「開始画像」としてボタンで渡せます。書き出した動画は
        「参照動画」として手で選びます。保存先(既定 ~/Pictures/GORI GORI)のプロジェクトフォルダに残ります
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
        <p
          className={`truncate font-mono text-[11px] font-bold tabular-nums ${selected ? "text-white" : "text-neutral-300"}`}
        >
          {(shot.durationFrames / SCENE_FPS).toFixed(1)}s
        </p>
        <p className="truncate text-[9px]" style={{ color: clipColor }}>
          {CAMERA_PRESET_LABELS[move.preset]}
        </p>
      </div>
      {segs.length > 1 && (
        <button
          className="absolute right-0.5 top-1 hidden text-neutral-500 hover:text-red-400 group-hover:block"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            removeShot(shot.id);
          }}
          title="リップル削除"
          aria-label="リップル削除"
        >
          <CloseIcon className="h-2.5 w-2.5" />
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

/** Cmd/Ctrl+C でコピーしたエンティティID(Cmd/Ctrl+V で複製) */
let copiedEntityId: string | null = null;

function useKeyboardShortcuts() {
  // S2 mount-pool 対応 (Sol 評価 blocking#1 / 2026-08-04)。
  //
  // 裏に回った 3D 画面も unmount されず残るため、この window keydown も生き残る。
  // すると別スキルやライブラリを操作している最中の Space / 矢印 / Cmd+Z が
  // **見えていない 3D シーンを動かす**（再生が始まる・フレームが飛ぶ・Undo が
  // 3D 側に入る）。描画ループ(Scene3dViewport の frameloop)を止めても
  // キー監視は別経路なので残る、というのが指摘の骨子。
  //
  // 直し方は listener を張らないこと（登録したうえで早期 return にしない）。
  // visible が false の間は addEventListener 自体を行わないので、
  // 非表示中にキーを叩いても onKey は**呼ばれず** useScene3d の状態は変化しない。
  // 表示に戻ると effect が再実行されて登録し直すので、操作性は元どおり。
  const visible = useSkillVisible();
  useEffect(() => {
    if (!visible) return;
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
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        // テキスト選択中は通常コピーを優先。それ以外は選択中エンティティをコピー
        if (window.getSelection()?.toString()) return;
        if (st.selectedEntityId) copiedEntityId = st.selectedEntityId;
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (copiedEntityId) {
          e.preventDefault();
          st.duplicateEntity(copiedEntityId);
        }
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
      } else if (e.key === "Escape") {
        st.clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);
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
          <span className="mx-0.5 w-px bg-[#2a2a2a]" />
          <button className={VIEW_BTN} onClick={() => requestViewPreset("reset")} title="選択に関係なく初期構図に戻る">
            リセット
          </button>
        </div>
      )}
      {showOverlays && (
        <p className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-white/45">
          左ドラッグ: 回る · ホイール: 寄る · 右ドラッグ: ずらす · ダブルクリック: 注視 · カメラの◎を人物へドラッグ: 追従 · ピンクの道はつかむと曲がる(ドラッグ=平面 / Z押しながら=高さ / 玉2回クリック=削除)
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

/* ---------------------------------- 演出チャット ---------------------------------- */

/**
 * 日本語演出→シーン自動構築。
 * 「人物1が歩いてきて、カメラは頭上から回り込みながら寄る」→ Codexがカット割りJSONを設計し、
 * モーション割当・カメラ配置・カット追加まで一式適用する
 */
function DirectorChat() {
  const project = useScene3d((s) => s.project);
  const importedMotions = useScene3d((s) => s.importedMotions);
  const [text, setText] = useState("");
  const busy = useScene3dRun((s) => s.directorBusy);
  const setBusy = useScene3dRun((s) => s.setDirectorBusy);
  const error = useScene3dRun((s) => s.directorError);
  const setError = useScene3dRun((s) => s.setDirectorError);
  const note = useScene3dRun((s) => s.directorNote);
  const setNote = useScene3dRun((s) => s.setDirectorNote);
  const progress = useScene3dRun((s) => s.directorProgress);
  const setProgress = useScene3dRun((s) => s.setDirectorProgress);
  // カット割り設計も実進捗が取れないため、開始時刻から推定ゲージを出す
  const startedAt = useScene3dRun((s) => s.directorStartedAt);
  const setStartedAt = useScene3dRun((s) => s.setDirectorStartedAt);
  // @メンション: シーン内の物体・カメラを候補から挿入する
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  const mentionCandidates = mention
    ? [
        ...project.entities.map((e) => ({ label: e.label, kind: "物体" })),
        ...project.cameras.map((c) => ({ label: c.label, kind: "カメラ" })),
      ].filter((c) => c.label.toLowerCase().includes(mention.query.toLowerCase()))
    : [];

  const updateMention = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) {
      setMention(null);
      return;
    }
    const q = upto.slice(at + 1);
    // @の後に空白・改行が来たらメンション入力は終わったとみなす
    if (/[\s\n]/.test(q) || q.length > 20) {
      setMention(null);
      return;
    }
    setMention({ query: q, start: at });
    setMentionIdx(0);
  };

  const pickMention = (label: string) => {
    if (!mention) return;
    const ta = taRef.current;
    const caret = ta ? ta.selectionStart : mention.start + 1 + mention.query.length;
    const next = text.slice(0, mention.start) + label + " " + text.slice(caret);
    setText(next);
    setMention(null);
    // 挿入した名前の直後にカーソルを戻す
    const pos = mention.start + label.length + 1;
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onRun = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    setStartedAt(Date.now());
    setProgress("監督が考え中…(最大3分)");
    try {
      const clipNames = importedMotions.map((m) => m.name);
      const { systemPrompt, prompt } = buildDirectorPrompt(t, project, clipNames);
      // カット割り設計は考える時間が長め。3分まで待つ(AIモーション生成と同じ)
      const res = await codexTextQuery({ prompt, systemPrompt, expectJson: true, timeoutSecs: 180 });
      const plan = validateDirectorPlan(res.parsedJson);
      await applyDirectorPlan(plan, (msg) => setProgress(msg));
      setNote(plan.note || "組みました");
      setText("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.slice(0, 200));
    } finally {
      setBusy(false);
      setProgress(null);
      setStartedAt(null);
    }
  };

  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-pink-300">
        <ClapperIcon />
        AIに動きを組ませる
      </p>
      <p className="mb-2 mt-1 text-[10px] leading-4 text-neutral-500">
        やりたいことを日本語で書くと、AIが人の動き・カメラの動き・カット割りまでまとめて組みます。
        1つずつ手で選ぶ必要はありません
      </p>
      <div className="relative">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (mention && mentionCandidates.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % mentionCandidates.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(mentionCandidates[mentionIdx].label);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onRun();
            }
          }}
          onBlur={() => {
            // クリック選択(onMouseDown)より後に閉じる
            window.setTimeout(() => setMention(null), 150);
          }}
          rows={2}
          placeholder="例: @で物体を指定。人物1が歩いてきて、カメラは頭上から回り込みながら寄る"
          className="w-full resize-none rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
        />
        {mention && mentionCandidates.length > 0 && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-lg border border-[#333] bg-[#161616] shadow-xl">
            {mentionCandidates.map((c, i) => (
              <button
                key={`${c.kind}-${c.label}`}
                className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs ${
                  i === mentionIdx ? "bg-pink-500/20 text-pink-200" : "text-neutral-300 hover:bg-[#222]"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(c.label);
                }}
                onMouseEnter={() => setMentionIdx(i)}
              >
                <span className="truncate">{c.label}</span>
                <span className="ml-2 shrink-0 text-[10px] text-neutral-600">{c.kind}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg bg-pink-500/90 px-2 py-1.5 text-xs font-semibold text-white hover:bg-pink-500 disabled:opacity-40"
        disabled={busy || text.trim().length === 0}
        onClick={() => void onRun()}
      >
        {busy && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pink-200 border-t-transparent" />
        )}
        {busy ? (progress ?? "監督が考え中…") : "AIに組ませる"}
      </button>
      {busy && startedAt ? (
        <div className="mt-1.5">
          <GenerationGauge startedAt={startedAt} mode="batch" />
        </div>
      ) : null}
      {note && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-lime-300">
          <CheckIcon className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{note}</span>
        </p>
      )}
      {error && (
        <p className="mt-1.5 rounded border border-red-500/30 bg-red-500/10 p-1.5 text-[11px] text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------- 逆読み上げ ---------------------------------- */

/** プリセット→読み上げ用の動詞(「〜します」につながる形) */
const READBACK_VERBS: Record<string, string> = {
  fixed: "動かず据え置きで撮る",
  pushIn: "被写体へ近づいていく",
  pullOut: "被写体から離れていく",
  track: "横に並走する",
  pan: "位置は動かさず視線だけ流す",
  orbit: "まわりを回り込む",
  crane: "上昇しながら見下ろす",
  handheld: "手持ちカメラ風に揺れながら撮る",
  spiralIn: "回り込みながら寄っていく",
  dollyZoom: "被写体の大きさを保ったまま背景だけ伸ばす",
  flyover: "頭上を飛び越えて背後へ抜ける",
  riseReveal: "足元から上昇して全景を見せる",
  follow: "動きに合わせて並走・追跡する",
  whipPan: "一瞬で振って場面を切り替える",
  shake: "衝撃で揺れて徐々に収まる",
  snapZoom: "位置はそのまま一気に寄る",
  path: "自由な道を通って撮る",
};

/**
 * 逆読み上げ: いまのカットを日本語1文で常時表示する。
 * 初心者は「自分が何を作ったか」を言葉で確認できて初めて安心する(AI不要・シーンデータから機械生成)
 */
function ShotReadback() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const shot = getSelectedShot({ project, selectedShotId });
  const move = getShotMove(project, shot);
  const camera = project.cameras.find((c) => c.id === shot.cameraId);
  const target = project.entities.find((e) => e.id === move.targetEntityId);

  const seconds = (shot.durationFrames / project.fps).toFixed(1);
  const subject = target ? `${target.label}を追いながら` : "決めた一点を見つめたまま";
  const verb = READBACK_VERBS[move.preset] ?? "動く";
  const extras: string[] = [];
  if (move.preset === "orbit") extras.push(`${move.orbitDegrees}°回り込み`);
  const pearls = move.pathPoints?.length ?? 0;
  if (pearls > 0) extras.push(`通過点${pearls}個の道を通る`);
  extras.push(`${move.lensMm}mmレンズ`);

  // 主役(被写体)の動きも読み上げる(連結・通過点・視線を変えた直後も一致するように)
  const importedMotions = useScene3d((s) => s.importedMotions);
  const nameOf = (id: string) => importedMotions.find((m) => m.id === id)?.name ?? "動き";
  let actorText = "";
  if (target) {
    const mo = target.motion;
    let motionPart = "立ち";
    let waypoints = 0;
    if (mo?.type === "walk" || mo?.type === "run") {
      motionPart = mo.type === "run" ? "走る" : "歩く";
      waypoints = Math.max(0, mo.path.length - 1);
    } else if (mo?.type === "fall") {
      motionPart = "倒れる";
    } else if (mo?.type === "clip") {
      const chain = [nameOf(mo.clipId)];
      for (const st of mo.arrivalSequence ?? []) chain.push(nameOf(st.clipId));
      if (!mo.arrivalSequence?.length && mo.arrivalClipId) chain.push(nameOf(mo.arrivalClipId));
      motionPart = chain.join("→");
      if (mo.overlayClipId) motionPart += `(上半身: ${nameOf(mo.overlayClipId)})`;
      waypoints = Math.max(0, (mo.path?.length ?? 0) - 1);
    }
    const actorExtras: string[] = [];
    if (waypoints > 0) actorExtras.push(`通過点${waypoints}個`);
    if (target.lookAt) {
      actorExtras.push(
        `視線=${target.lookAt === "__camera" ? "カメラ" : (project.entities.find((e) => e.id === target.lookAt)?.label ?? "?")}`,
      );
    }
    actorText = ` / ${target.label}は${motionPart}${actorExtras.length > 0 ? `(${actorExtras.join("・")})` : ""}`;
  }

  return (
    <div className="flex items-center gap-2 border-t border-[#242424] bg-[#131313] px-4 py-1.5">
      <span className="shrink-0 rounded bg-[#222] px-1.5 py-0.5 text-[10px] font-bold text-neutral-400">
        いま
      </span>
      <p className="truncate text-[11px] text-neutral-400">
        {shot.label}: {camera?.label ?? "カメラ"}が、{subject} {seconds}秒かけて
        <span className="text-neutral-200">{verb}</span>
        <span className="text-neutral-500">（{extras.join("・")}）</span>
        <span className="text-neutral-400">{actorText}</span>
      </p>
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
  // 標準モーションライブラリを最初に読み込む。なぜ: 保存済みシーンのクリップモーションは
  // ライブラリの実体が無いと復元できない(ポップアップを開くまで人形に戻る問題の根治)。
  // 続けて、保存済みのAI生成モーションを標準リグの上に再構築する
  useEffect(() => {
    void loadBuiltinMotions()
      .then(async (items) => {
        useScene3d.getState().registerImportedMotions(items);
        const template = getBuiltinTemplate();
        if (!template) return;
        // motions.json (正本) の読み込み完了を待ってから spec を引く。
        // 待たないと localStorage 由来の暫定キャッシュだけで復元してしまい、
        // ファイルにしか無いモーションが「起動直後だけ人形に戻る」。
        // initializeGeneratedMotions は Promise を共有するので、App.tsx 側の
        // 呼び出しと重なってもファイルを二重に読まない。
        await initializeGeneratedMotions();
        const specs = loadGeneratedSpecs().filter((sp) => sp.spec != null);
        // Mixamo規格(Y Bot)のspecが1つでもあれば取り込みマネキンも読み込む。
        // Y Bot読込失敗は局所化する(失敗が旧規格specの復元まで巻き添えにしない。Codex Verifier指摘)
        let ybot: import("three").Group | null = null;
        if (specs.some(({ spec }) => spec.rig === "mixamo")) {
          try {
            ybot = await loadCaptureRig();
          } catch {
            /* Y Bot無しでも旧規格の復元は続行 */
          }
        }
        const restored: { id: string; name: string }[] = [];
        for (const { id, spec } of specs) {
          try {
            const tpl = spec.rig === "mixamo" ? ybot : template;
            if (!tpl) continue;
            const clip = buildGeneratedClip(tpl, spec, id);
            const entry = registerGeneratedClip(id, spec.name, clip, spec.plants, spec.rig);
            if (entry) {
              // AIの自己申告速度(無ければ名前推定に任せる)を登録してから一覧へ
              if (spec.moveSpeed != null) registerClipSpeed(id, spec.moveSpeed);
              restored.push(entry);
            }
          } catch {
            /* 壊れた保存データはスキップ(他の生成モーションは復元する) */
          }
        }
        if (restored.length > 0) {
          const st = useScene3d.getState();
          st.registerImportedMotions(restored);
          // 割当済みの人物の速度が古い(生成時は速度未対応だった等)場合は再割当で治す
          for (const e of st.project.entities) {
            const motion = e.motion;
            if (motion?.type !== "clip" || !motion.clipId.startsWith("gen-")) continue;
            const name = restored.find((m) => m.id === motion.clipId)?.name;
            const nowSpeed = resolveClipSpeed(motion.clipId, name);
            if ((motion.speed ?? 0) !== nowSpeed) {
              st.setEntityMotionClip(e.id, motion.clipId);
            }
          }
        }
      })
      .catch(() => {
        /* 読み込み失敗時はライブラリを開いたときに再試行される */
      });
  }, []);
  const [rowRef, rowW] = useRowWidth();
  const [leftPct, setLeftPct] = usePanelPct("scene3d.panel.leftPct", 16, 8, 30);
  const [rightPct, setRightPct] = usePanelPct("scene3d.panel.rightPct", 22, 12, 35);
  const [leftOpen, toggleLeft] = usePanelOpen("scene3d.panel.left.open");
  const [rightOpen, toggleRight] = usePanelOpen("scene3d.panel.right.open");

  // %→px(最低幅120pxは保証しつつ、画面が狭ければ%どおり縮む)
  const leftW = Math.max(120, Math.round((rowW * leftPct) / 100));
  const rightW = Math.max(150, Math.round((rowW * rightPct) / 100));

  return (
    <section
      data-tour="scene-3d-workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212] [&_input[type=range]]:accent-neutral-400"
    >
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
          <PageHelp
            what="人物や小物を3D空間に置き、カメラの動きを付けて、そのまま画像・動画生成の下絵にします。"
            first="まずは「+ シーンに置く」で人物か小物を置いてください。"
            note="写真や絵から「画像からシーンを起こす…」で自動配置もできます。"
          />
        </div>
      </div>

      <div ref={rowRef} className="flex min-h-0 flex-1 overflow-hidden">
        {leftOpen ? (
          <>
            <div
              data-tour="scene-3d-assets"
              style={{ width: leftW, minWidth: 140 }}
              className="relative flex overflow-hidden"
            >
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
        <div
          data-tour="scene-3d-camera"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ViewportWithFrame />
          <ShotReadback />
          <ShotTimeline />
        </div>
        {rightOpen ? (
          <>
            <PanelResizer onDelta={(dx) => setRightPct(rowW > 0 ? (-dx / rowW) * 100 : 0, leftPct)} />
            <div
              data-tour="scene-3d-director"
              style={{ width: rightW, minWidth: 200 }}
              className="relative flex overflow-hidden"
            >
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
