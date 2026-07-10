/**
 * 3Dシーン演出 Workspace (Phase 0 スパイク)
 *
 * 「置く・動かす・撮る・繋ぐ・生成する」だけを見せる。
 * キーフレーム・XYZ数値・ボーンは出さない(初心者がBlenderで挫折する要素を排除)。
 *
 * カット割は CapCut 風タイムライン(STΛCK指示 2026-07-10):
 *   クリップ幅=秒数 / 右端ドラッグで尺変更 / ドラッグで並び替え /
 *   クリック選択 → 右パネルがそのカットの編集になる
 *
 * SkillWorkspaceRouter が activeUiMode === "scene3d" のとき本コンポーネントを描画。
 */

import { useRef } from "react";
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

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { totalDurationFrames } from "../../../lib/scene3d/evaluateScene";
import {
  CAMERA_PRESET_LABELS,
  LENS_PRESETS_MM,
  SCENE_FPS,
  SEEDANCE_MAX_SECONDS,
} from "../../../lib/scene3d/types";
import type { CameraPresetId, SceneShot } from "../../../lib/scene3d/types";
import { getSelectedShot, useScene3d } from "../../../lib/store/scene3d";
import { Scene3dViewport } from "./Scene3dViewport";

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

function ShelfPanel() {
  const addEntity = useScene3d((s) => s.addEntity);
  const entities = useScene3d((s) => s.project.entities);
  const selectedId = useScene3d((s) => s.selectedEntityId);
  const selectEntity = useScene3d((s) => s.selectEntity);
  const removeEntity = useScene3d((s) => s.removeEntity);

  return (
    <aside className="flex w-52 shrink-0 flex-col gap-3 border-r border-[#242424] bg-[#151515] p-3">
      <div>
        <p className="mb-2 text-xs font-semibold text-neutral-400">置く</p>
        <div className="flex flex-col gap-1.5">
          <button
            className="rounded border border-[#2e2e2e] bg-[#1d1d1d] px-3 py-2 text-left text-sm text-neutral-200 hover:border-amber-500/60"
            onClick={() => addEntity("mannequin")}
          >
            🧍 人物を置く
          </button>
          <button
            className="rounded border border-[#2e2e2e] bg-[#1d1d1d] px-3 py-2 text-left text-sm text-neutral-200 hover:border-amber-500/60"
            onClick={() => addEntity("sphere")}
          >
            ⚪ 球を置く
          </button>
          <button
            className="rounded border border-[#2e2e2e] bg-[#1d1d1d] px-3 py-2 text-left text-sm text-neutral-200 hover:border-amber-500/60"
            onClick={() => addEntity("box")}
          >
            📦 箱を置く
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-neutral-500">
          置いたものはビューポート上でドラッグして動かせます
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 text-xs font-semibold text-neutral-400">シーン内</p>
        <ul className="flex flex-col gap-1">
          {entities.map((e) => (
            <li
              key={e.id}
              className={`group flex items-center justify-between rounded px-2 py-1.5 text-sm ${
                selectedId === e.id
                  ? "bg-amber-500/15 text-amber-300"
                  : "text-neutral-300 hover:bg-[#1d1d1d]"
              }`}
            >
              <button className="flex-1 text-left" onClick={() => selectEntity(e.id)}>
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
    </aside>
  );
}

function DirectorPanel() {
  const project = useScene3d((s) => s.project);
  const selectedShotId = useScene3d((s) => s.selectedShotId);
  const setCameraPreset = useScene3d((s) => s.setCameraPreset);
  const setCameraTarget = useScene3d((s) => s.setCameraTarget);
  const setLens = useScene3d((s) => s.setLens);
  const setOrbitDegrees = useScene3d((s) => s.setOrbitDegrees);
  const setShotDurationFrames = useScene3d((s) => s.setShotDurationFrames);

  const shot = getSelectedShot({ project, selectedShotId });
  const camera = shot.camera;

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-[#242424] bg-[#151515] p-3">
      <div>
        <p className="mb-2 text-xs font-semibold text-neutral-400">
          撮る — {shot.label} のカメラ
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {PRESET_ORDER.map((preset) => (
            <button
              key={preset}
              className={`rounded border px-2 py-1.5 text-xs ${
                camera.preset === preset
                  ? "border-sky-500 bg-sky-500/15 text-sky-300"
                  : "border-[#2e2e2e] bg-[#1d1d1d] text-neutral-300 hover:border-sky-500/50"
              }`}
              onClick={() => setCameraPreset(preset)}
            >
              {CAMERA_PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-neutral-500">
          緑=開始位置 / 赤=終了位置 / 水色の線=カメラの通り道(選択中カット)
        </p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        被写体
        <select
          className="rounded border border-[#2e2e2e] bg-[#1d1d1d] px-2 py-1.5 text-sm text-neutral-200"
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

      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        レンズ
        <div className="grid grid-cols-3 gap-1">
          {LENS_PRESETS_MM.map((mm) => (
            <button
              key={mm}
              className={`rounded border px-1.5 py-1 text-xs ${
                camera.lensMm === mm
                  ? "border-sky-500 bg-sky-500/15 text-sky-300"
                  : "border-[#2e2e2e] bg-[#1d1d1d] text-neutral-300"
              }`}
              onClick={() => setLens(mm)}
            >
              {mm}mm
            </button>
          ))}
        </div>
      </label>

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

      <ExportSection />
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
      <p className="text-xs font-semibold text-neutral-400">生成する</p>
      {overLimit && (
        <p className="text-[11px] leading-4 text-amber-400">
          ⚠ 合計{totalSec.toFixed(1)}秒。Seedanceの1回上限は{SEEDANCE_MAX_SECONDS}秒のため、
          このままだと章分割(複数回生成)が必要です
        </p>
      )}
      <button
        className="rounded bg-gradient-to-r from-pink-600 to-rose-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        disabled={busy}
        onClick={requestExport}
      >
        {busy ? "書き出し中…" : "📼 モーションガイドを書き出す"}
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
              <p className="text-emerald-400">✓ motion-guide.mp4 完成(全カット連結)</p>
              <button
                className="rounded border border-[#2e2e2e] px-2 py-1 text-left text-neutral-300 hover:border-neutral-500"
                onClick={() => void revealInFinder(status.mp4Path!)}
              >
                📂 Finderで表示
              </button>
            </>
          ) : (
            <>
              <p className="text-amber-400">
                PNG連番まで書き出しました(ffmpeg未検出のためMP4変換はスキップ)
              </p>
              <button
                className="rounded border border-[#2e2e2e] px-2 py-1 text-left text-neutral-300 hover:border-neutral-500"
                onClick={() => void revealInFinder(status.framesDir)}
              >
                📂 フォルダを表示
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
          ? "border-sky-400 bg-sky-500/20"
          : "border-[#2e2e2e] bg-[#1f1f1f] hover:border-sky-500/40"
      }`}
      onClick={() => selectShot(shot.id)}
      {...attributes}
      {...listeners}
    >
      <p className={`truncate text-xs font-medium ${selected ? "text-sky-200" : "text-neutral-200"}`}>
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
        className="absolute -right-0.5 top-0 h-full w-2 cursor-ew-resize rounded-r-md bg-sky-400/0 hover:bg-sky-400/50"
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
  const setPlaying = useScene3d((s) => s.setPlaying);
  const setCameraView = useScene3d((s) => s.setCameraView);
  const setCurrentFrame = useScene3d((s) => s.setCurrentFrame);
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
    setCurrentFrame(Math.max(0, Math.min(totalFrames - 1, x / pxPerFrame)));
  };

  return (
    <div className="flex flex-col border-t border-[#242424] bg-[#151515]">
      <div className="flex items-center gap-3 px-4 pt-2">
        <button
          className={`rounded px-3 py-1 text-sm font-medium ${
            playing ? "bg-red-500/20 text-red-300" : "bg-sky-500/20 text-sky-300"
          }`}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? "■ 停止" : "▶ 再生"}
        </button>
        <button
          className={`rounded border px-3 py-1 text-sm ${
            cameraView
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-[#2e2e2e] text-neutral-400"
          }`}
          onClick={() => setCameraView(!cameraView)}
          title="撮影カメラの画で確認"
        >
          🎥 カメラの画
        </button>
        <span className="ml-auto text-xs tabular-nums text-neutral-400">
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
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-[#3a3a3a] text-lg text-neutral-500 hover:border-sky-500/60 hover:text-sky-400"
                  onClick={addShot}
                  title="カットを追加(選択中カットの複製から)"
                >
                  ＋
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

export function Scene3dWorkspace() {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]">
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ShelfPanel />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Scene3dViewport />
          </div>
          <ShotTimeline />
        </div>
        <DirectorPanel />
      </div>
    </section>
  );
}
