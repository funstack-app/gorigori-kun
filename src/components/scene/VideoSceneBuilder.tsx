import { useState } from "react";

import { NO_SELECT } from "../../lib/scene/catalog";
import {
  cameraMovementOptions,
  cameraSpeedOptions,
  environmentMotionOptions,
  lightingSourceOptions,
  motionIntensityOptions,
  subjectMotionOptions,
  videoStyleOptions,
  weatherOptions,
} from "../../lib/scene/video-catalog";
import { useVideoSceneStore } from "../../lib/store/videoScene";
import { OptionPickerButton } from "./OptionPickerButton";
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

type SectionId = "subject" | "motion" | "camera" | "staging";

/**
 * 動画シーン構築 (i2v再設計 2026-05-29)。
 * 4軸に集約: 01 主役 / 02 動き / 03 カメラ / 04 演出。
 * 縦1列。画像生成タブと同じコンパクトさ。
 */
export function VideoSceneBuilder() {
  const subject = useVideoSceneStore((state) => state.subject);
  const motion = useVideoSceneStore((state) => state.motion);
  const camera = useVideoSceneStore((state) => state.camera);
  const staging = useVideoSceneStore((state) => state.staging);
  const [openSection, setOpenSection] = useState<SectionId | null>(null);
  const close = () => setOpenSection(null);

  return (
    <>
      <div className="space-y-2">
        <SceneCompactCard
          number="01"
          title="主役"
          summary={show(subject.text, "主役未入力")}
          onClick={() => setOpenSection("subject")}
        />
        <SceneCompactCard
          number="02"
          title="動き"
          summary={compact(motion.verb, motion.intensity)}
          onClick={() => setOpenSection("motion")}
        />
        <SceneCompactCard
          number="03"
          title="カメラ"
          summary={compact(camera.motion, camera.speed)}
          onClick={() => setOpenSection("camera")}
        />
        <SceneCompactCard
          number="04"
          title="演出"
          summary={compact(staging.lighting, staging.weather, staging.environment, staging.style)}
          onClick={() => setOpenSection("staging")}
        />
      </div>

      <SceneSectionModal open={openSection === "subject"} number="01" title="主役" onClose={close}>
        <SubjectSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "motion"} number="02" title="動き" onClose={close}>
        <MotionSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "camera"} number="03" title="カメラ" onClose={close}>
        <CameraSection />
      </SceneSectionModal>
      <SceneSectionModal open={openSection === "staging"} number="04" title="演出" onClose={close}>
        <StagingSection />
      </SceneSectionModal>
    </>
  );
}

function SubjectSection() {
  const subject = useVideoSceneStore((state) => state.subject);
  const setSubjectField = useVideoSceneStore((state) => state.setSubjectField);

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">主役</span>
        <input
          value={subject.text}
          onChange={(event) => setSubjectField("text", event.target.value)}
          placeholder="例: 赤い傘の少女 (元画像にいる人物を一言で)"
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
        />
      </label>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        i2v では元画像に写っている人物を動かします。外見の細かい説明は不要で、「the
        girl」のような短い指し示しで十分です。
      </p>
    </div>
  );
}

function MotionSection() {
  const motion = useVideoSceneStore((state) => state.motion);
  const setMotionField = useVideoSceneStore((state) => state.setMotionField);

  const handlePickVerb = (value: string) => {
    const category = subjectMotionOptions.find((option) => option.value === value)?.hint ?? "";
    setMotionField("verb", value);
    setMotionField("category", category === "指定なし" ? "" : category);
  };

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="被写体の動き"
        options={subjectMotionOptions}
        value={motion.verb}
        onPick={handlePickVerb}
        modalTitle="被写体の動きを選ぶ"
      />
      <OptionPickerButton
        label="被写体の動きの強さ"
        options={motionIntensityOptions}
        value={motion.intensity}
        onPick={(value) => setMotionField("intensity", value)}
        modalTitle="被写体の動きの強さを選ぶ"
      />
    </div>
  );
}

function CameraSection() {
  const camera = useVideoSceneStore((state) => state.camera);
  const setCameraField = useVideoSceneStore((state) => state.setCameraField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="カメラの動き"
        options={cameraMovementOptions}
        value={camera.motion}
        onPick={(value) => setCameraField("motion", value)}
        modalTitle="カメラの動きを選ぶ"
      />
      <OptionPickerButton
        label="カメラ速度"
        options={cameraSpeedOptions}
        value={camera.speed}
        onPick={(value) => setCameraField("speed", value)}
        modalTitle="カメラ速度を選ぶ"
      />
    </div>
  );
}

function StagingSection() {
  const staging = useVideoSceneStore((state) => state.staging);
  const setStagingField = useVideoSceneStore((state) => state.setStagingField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="ライティング"
        options={lightingSourceOptions}
        value={staging.lighting}
        onPick={(value) => setStagingField("lighting", value)}
        modalTitle="ライティングを選ぶ"
      />
      <OptionPickerButton
        label="天候"
        options={weatherOptions}
        value={staging.weather}
        onPick={(value) => setStagingField("weather", value)}
        modalTitle="天候を選ぶ"
      />
      <OptionPickerButton
        label="環境の動き"
        options={environmentMotionOptions}
        value={staging.environment}
        onPick={(value) => setStagingField("environment", value)}
        modalTitle="環境の動きを選ぶ"
      />
      <OptionPickerButton
        label="スタイル"
        options={videoStyleOptions}
        value={staging.style}
        onPick={(value) => setStagingField("style", value)}
        modalTitle="スタイルを選ぶ"
      />
    </div>
  );
}
