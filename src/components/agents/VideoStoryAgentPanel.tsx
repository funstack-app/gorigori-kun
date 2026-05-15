import { useState } from "react";
import type { ReactElement } from "react";
import {
  type StoryboardCut,
  type StoryboardResult,
  type VideoDuration,
  videoStoryAgent,
} from "../../lib/agents";

type VideoStoryAgentPanelProps = {
  onStoryboardBuilt?: (storyboard: StoryboardResult) => void;
};

const DURATION_OPTIONS: Array<{ value: VideoDuration; label: string }> = [
  { value: "15s", label: "15秒" },
  { value: "30s", label: "30秒" },
  { value: "60s", label: "60秒" },
  { value: "custom", label: "カスタム" },
];

export function VideoStoryAgentPanel({
  onStoryboardBuilt,
}: VideoStoryAgentPanelProps): ReactElement {
  const [core, setCore] = useState<string>("");
  const [duration, setDuration] = useState<VideoDuration>("30s");
  const [storyboard, setStoryboard] = useState<StoryboardResult | undefined>(
    undefined,
  );
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  async function handleBuild(): Promise<void> {
    setError("");
    setIsBuilding(true);
    try {
      const result = await videoStoryAgent.buildStoryboard({ core, duration });
      setStoryboard(result.data);
      onStoryboardBuilt?.(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ストーリー構築に失敗しました");
    } finally {
      setIsBuilding(false);
    }
  }

  return (
    <section className="flex h-full flex-col gap-4 text-sm text-zinc-100">
      <label className="space-y-2">
        <span className="block text-xs font-medium text-zinc-300">
          物語の核
        </span>
        <textarea
          className="min-h-28 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
          value={core}
          onChange={(event) => setCore(event.target.value)}
          placeholder="失恋した女性が朝の散歩で気持ちを切り替える"
        />
      </label>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <label className="space-y-2">
          <span className="block text-xs font-medium text-zinc-300">
            尺予定
          </span>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
            value={duration}
            onChange={(event) => setDuration(event.target.value as VideoDuration)}
          >
            {DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="self-end rounded-md bg-pink-500 px-4 py-2 font-medium text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          type="button"
          disabled={isBuilding}
          onClick={handleBuild}
        >
          {isBuilding ? "構築中" : "ストーリー構築"}
        </button>
      </div>

      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      {storyboard ? (
        <div className="overflow-hidden rounded-md border border-zinc-800">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">カット</th>
                <th className="px-3 py-2 font-medium">役割</th>
                <th className="px-3 py-2 font-medium">構図</th>
                <th className="px-3 py-2 font-medium">カメラ</th>
                <th className="px-3 py-2 text-right font-medium">尺</th>
              </tr>
            </thead>
            <tbody>
              {storyboard.cuts.map((cut: StoryboardCut) => (
                <tr className="border-t border-zinc-800" key={cut.cutNumber}>
                  <td className="px-3 py-3 text-zinc-200">{cut.cutNumber}</td>
                  <td className="px-3 py-3 text-zinc-200">{cut.role}</td>
                  <td className="px-3 py-3 text-zinc-300">{cut.composition}</td>
                  <td className="px-3 py-3 text-zinc-300">{cut.cameraWork}</td>
                  <td className="px-3 py-3 text-right text-zinc-200">
                    {cut.durationSeconds}秒
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
