import type { ChangeEvent } from "react";
import { lightSourceOptions } from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { OptionPickerButton } from "./OptionPickerButton";

export function LightingMoodSection() {
  const lightSource = useSceneStore((state) => state.lightingMood.lightSource);
  const mood = useSceneStore((state) => state.lightingMood.mood);
  const setLightingMoodField = useSceneStore((state) => state.setLightingMoodField);

  const onMoodChange = (event: ChangeEvent<HTMLInputElement>) => {
    setLightingMoodField("mood", event.target.value);
  };

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="光源"
        options={lightSourceOptions}
        value={lightSource}
        onPick={(value) => setLightingMoodField("lightSource", value)}
        modalTitle="光源を選ぶ"
      />

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">雰囲気</span>
        <input
          value={mood}
          onChange={onMoodChange}
          placeholder="例: ムーディー、シネマティック、物悲しい"
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
        />
      </label>
    </div>
  );
}
