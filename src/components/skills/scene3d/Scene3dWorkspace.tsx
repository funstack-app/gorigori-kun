/**
 * 3Dシーン演出 Workspace (Phase 0 スパイク)
 *
 * 「置く・動かす・撮る・生成する」の4動作だけを見せる。
 * キーフレーム・XYZ数値・ボーンは出さない(初心者がBlenderで挫折する要素を排除)。
 *
 * SkillWorkspaceRouter が activeUiMode === "scene3d" のとき本コンポーネントを描画。
 * 既存の GenerationWorkspace / 他スキルWorkspace は触らない。
 */

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import {
  CAMERA_PRESET_LABELS,
  LENS_PRESETS_MM,
  SCENE_FPS,
} from "../../../lib/scene3d/types";
import type { CameraPresetId } from "../../../lib/scene3d/types";
import { useScene3d } from "../../../lib/store/scene3d";
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
  const camera = useScene3d((s) => s.project.camera);
  const entities = useScene3d((s) => s.project.entities);
  const durationFrames = useScene3d((s) => s.project.durationFrames);
  const setCameraPreset = useScene3d((s) => s.setCameraPreset);
  const setCameraTarget = useScene3d((s) => s.setCameraTarget);
  const setLens = useScene3d((s) => s.setLens);
  const setOrbitDegrees = useScene3d((s) => s.setOrbitDegrees);
  const setDurationSeconds = useScene3d((s) => s.setDurationSeconds);

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-l border-[#242424] bg-[#151515] p-3">
      <div>
        <p className="mb-2 text-xs font-semibold text-neutral-400">撮る — カメラの動き</p>
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
          緑=開始位置 / 赤=終了位置 / 水色の線=カメラの通り道
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
          {entities.map((en) => (
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
        秒数: {Math.round(durationFrames / SCENE_FPS)}秒
        <input
          type="range"
          min={2}
          max={15}
          step={1}
          value={Math.round(durationFrames / SCENE_FPS)}
          onChange={(e) => setDurationSeconds(Number(e.target.value))}
        />
      </label>
    </aside>
  );
}

function TimelineBar() {
  const playing = useScene3d((s) => s.playing);
  const cameraView = useScene3d((s) => s.cameraView);
  const currentFrame = useScene3d((s) => s.currentFrame);
  const durationFrames = useScene3d((s) => s.project.durationFrames);
  const setPlaying = useScene3d((s) => s.setPlaying);
  const setCameraView = useScene3d((s) => s.setCameraView);
  const setCurrentFrame = useScene3d((s) => s.setCurrentFrame);

  const seconds = (currentFrame / SCENE_FPS).toFixed(1);

  return (
    <div className="flex items-center gap-3 border-t border-[#242424] bg-[#151515] px-4 py-2.5">
      <button
        className={`rounded px-3 py-1.5 text-sm font-medium ${
          playing ? "bg-red-500/20 text-red-300" : "bg-sky-500/20 text-sky-300"
        }`}
        onClick={() => setPlaying(!playing)}
      >
        {playing ? "■ 停止" : "▶ 再生"}
      </button>
      <button
        className={`rounded border px-3 py-1.5 text-sm ${
          cameraView
            ? "border-amber-500 bg-amber-500/15 text-amber-300"
            : "border-[#2e2e2e] text-neutral-400"
        }`}
        onClick={() => setCameraView(!cameraView)}
        title="撮影カメラの画で確認"
      >
        🎥 カメラの画
      </button>
      <input
        className="flex-1"
        type="range"
        min={0}
        max={durationFrames - 1}
        step={1}
        value={Math.floor(currentFrame)}
        onChange={(e) => setCurrentFrame(Number(e.target.value))}
      />
      <span className="w-16 text-right text-xs tabular-nums text-neutral-400">
        {seconds}s / {Math.round(durationFrames / SCENE_FPS)}s
      </span>
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
          <TimelineBar />
        </div>
        <DirectorPanel />
      </div>
    </section>
  );
}
