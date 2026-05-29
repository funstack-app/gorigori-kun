import { useState } from "react";

import { NO_SELECT } from "../../lib/scene/catalog";
import {
  lightingSourceOptions,
  timeOfDayOptions,
  videoCompositionOptions,
  videoStyleOptions,
  weatherOptions,
} from "../../lib/scene/video-catalog";
import { useVideoSceneStore } from "../../lib/store/videoScene";
import { CameraMovementSection } from "./CameraMovementSection";
import { MotionSection } from "./MotionSection";
import { OptionPickerButton } from "./OptionPickerButton";
import { PacingSection } from "./PacingSection";
import { SceneCompactCard } from "./SceneCompactCard";
import { SceneSectionModal } from "./SceneSectionModal";

function show(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === NO_SELECT) return fallback;
  return trimmed;
}

function compact(...values: string[]): string {
  const filtered = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== NO_SELECT);
  return filtered.length > 0 ? filtered.join(" / ") : "未設定";
}

type SectionId = "subject" | "camera" | "motion" | "lighting" | "style" | "pacing";

export function VideoSceneBuilder() {
  const subject = useVideoSceneStore((state) => state.subject);
  const cameraMovement = useVideoSceneStore((state) => state.cameraMovement);
  const motion = useVideoSceneStore((state) => state.motion);
  const lighting = useVideoSceneStore((state) => state.lighting);
  const style = useVideoSceneStore((state) => state.style);
  const pacing = useVideoSceneStore((state) => state.pacing);
  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  const close = () => setOpenSection(null);

  return (
    <>
      <div className="scene-builder-stack space-y-2">
        <SceneCompactCard
          number="01"
          title="主役と被写体"
          summary={compact(show(subject.text, "主役未入力"), subject.composition)}
          onClick={() => setOpenSection("subject")}
        />
        <SceneCompactCard
          number="02"
          title="カメラワーク"
          summary={compact(cameraMovement.motion, cameraMovement.speed, cameraMovement.startPosition)}
          onClick={() => setOpenSection("camera")}
        />
        <SceneCompactCard
          number="03"
          title="被写体の動き"
          summary={compact(motion.verb, motion.category)}
          onClick={() => setOpenSection("motion")}
        />
        <SceneCompactCard
          number="04"
          title="ライティング"
          summary={compact(lighting.source, lighting.timeOfDay, lighting.weather)}
          onClick={() => setOpenSection("lighting")}
        />
        <SceneCompactCard
          number="05"
          title="スタイル & ルック"
          summary={compact(style.look)}
          onClick={() => setOpenSection("style")}
        />
        <SceneCompactCard
          number="06"
          title="テンポ & カット秒"
          summary={compact(pacing.tempo, `${pacing.targetDuration}秒`, pacing.cutDuration === "auto" ? "自動" : `${pacing.cutDuration}秒`)}
          onClick={() => setOpenSection("pacing")}
        />
      </div>

      <SceneSectionModal open={openSection === "subject"} number="01" title="主役と被写体" onClose={close}>
        <VideoSubjectSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "camera"} number="02" title="カメラワーク" onClose={close}>
        <CameraMovementSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "motion"} number="03" title="被写体の動き" onClose={close}>
        <MotionSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "lighting"} number="04" title="ライティング" onClose={close}>
        <VideoLightingSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "style"} number="05" title="スタイル & ルック" onClose={close}>
        <VideoStyleSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "pacing"} number="06" title="テンポ & カット秒" onClose={close}>
        <PacingSection />
      </SceneSectionModal>
    </>
  );
}

function VideoSubjectSection() {
  const subject = useVideoSceneStore((state) => state.subject);
  const setSubjectField = useVideoSceneStore((state) => state.setSubjectField);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">主役</span>
        <input
          value={subject.text}
          onChange={(event) => setSubjectField("text", event.target.value)}
          placeholder="例: 赤い傘を持つ少女、雨の交差点"
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
        />
      </label>
      <OptionPickerButton
        label="構図"
        options={videoCompositionOptions}
        value={subject.composition}
        onPick={(value) => setSubjectField("composition", value)}
        modalTitle="構図を選ぶ"
      />
    </div>
  );
}

function VideoLightingSection() {
  const lighting = useVideoSceneStore((state) => state.lighting);
  const setLightingField = useVideoSceneStore((state) => state.setLightingField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="光源"
        options={lightingSourceOptions}
        value={lighting.source}
        onPick={(value) => setLightingField("source", value)}
        modalTitle="光源を選ぶ"
      />
      <OptionPickerButton
        label="時間帯"
        options={timeOfDayOptions}
        value={lighting.timeOfDay}
        onPick={(value) => setLightingField("timeOfDay", value)}
        modalTitle="時間帯を選ぶ"
      />
      <OptionPickerButton
        label="天候"
        options={weatherOptions}
        value={lighting.weather}
        onPick={(value) => setLightingField("weather", value)}
        modalTitle="天候を選ぶ"
      />
    </div>
  );
}

function VideoStyleSection() {
  const style = useVideoSceneStore((state) => state.style);
  const setStyleField = useVideoSceneStore((state) => state.setStyleField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="スタイル"
        options={videoStyleOptions}
        value={style.look}
        onPick={(value) => setStyleField("look", value)}
        modalTitle="スタイルを選ぶ"
      />
    </div>
  );
}
