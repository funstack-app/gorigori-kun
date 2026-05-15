import { subjectMotionOptions } from "../../lib/scene/video-catalog";
import { useVideoSceneStore } from "../../lib/store/videoScene";
import { OptionPickerButton } from "./OptionPickerButton";

export function MotionSection() {
  const motion = useVideoSceneStore((state) => state.motion);
  const setMotionField = useVideoSceneStore((state) => state.setMotionField);

  const pickVerb = (value: string) => {
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
        onPick={pickVerb}
        modalTitle="被写体の動きを選ぶ"
      />
      <div className="rounded-md border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-xs text-neutral-400">
        カテゴリ: <span className="font-bold text-neutral-200">{motion.category || "未設定"}</span>
      </div>
    </div>
  );
}
