import {
  cutDurationOptions,
  targetDurationOptions,
  tempoOptions,
} from "../../lib/scene/video-catalog";
import { useVideoSceneStore } from "../../lib/store/videoScene";
import { OptionPickerButton } from "./OptionPickerButton";

function durationLabel(seconds: number): string {
  if ([5, 10, 15, 30].includes(seconds)) return `${seconds}秒`;
  return "カスタム";
}

function parseDuration(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.replace("秒", ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cutDurationLabel(value: number | "auto"): string {
  return value === "auto" ? "自動" : `${value}秒`;
}

function parseCutDuration(value: string): number | "auto" {
  if (value === "自動") return "auto";
  const parsed = Number.parseFloat(value.replace("秒", ""));
  return Number.isFinite(parsed) ? parsed : "auto";
}

export function PacingSection() {
  const pacing = useVideoSceneStore((state) => state.pacing);
  const setPacingField = useVideoSceneStore((state) => state.setPacingField);

  return (
    <div className="space-y-4">
      <OptionPickerButton
        label="テンポ"
        options={tempoOptions}
        value={pacing.tempo}
        onPick={(value) => setPacingField("tempo", value)}
        modalTitle="テンポを選ぶ"
      />
      <OptionPickerButton
        label="動画尺の目安"
        options={targetDurationOptions}
        value={durationLabel(pacing.targetDuration)}
        onPick={(value) => setPacingField("targetDuration", parseDuration(value, pacing.targetDuration))}
        modalTitle="動画尺を選ぶ"
      />
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">カスタム秒数</span>
        <input
          type="number"
          min={1}
          max={300}
          value={pacing.targetDuration}
          onChange={(event) => setPacingField("targetDuration", Number(event.target.value) || 10)}
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white outline-none transition focus:border-pink-500"
        />
      </label>
      <OptionPickerButton
        label="1カットの秒数"
        options={cutDurationOptions}
        value={cutDurationLabel(pacing.cutDuration)}
        onPick={(value) => setPacingField("cutDuration", parseCutDuration(value))}
        modalTitle="1カットの秒数を選ぶ"
      />
    </div>
  );
}
