import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { adAgent, type AdCopyResult, type AdPitch, type AppealAxis } from "../../lib/agents";

type TargetForm = {
  age: string;
  gender: string;
  attribute: string;
  pain: string;
};

type AdAgentPanelProps = {
  onAdoptPitch?: (pitch: AdPitch, copy: AdCopyResult | undefined) => void;
};

const APPEAL_OPTIONS: Array<{ value: AppealAxis; label: string }> = [
  { value: "functional", label: "機能訴求" },
  { value: "emotional", label: "感情訴求" },
  { value: "comparative", label: "比較訴求" },
  { value: "empathy", label: "共感訴求" },
];

const AGE_OPTIONS: string[] = ["20代", "30代", "40代", "50代+"];
const GENDER_OPTIONS: string[] = ["問わない", "女性", "男性"];

export function AdAgentPanel({
  onAdoptPitch,
}: AdAgentPanelProps): ReactElement {
  const [product, setProduct] = useState<string>("");
  const [target, setTarget] = useState<TargetForm>({
    age: "30代",
    gender: "問わない",
    attribute: "",
    pain: "",
  });
  const [appealAxis, setAppealAxis] = useState<AppealAxis>("functional");
  const [pitches, setPitches] = useState<AdPitch[]>([]);
  const [selectedPitchId, setSelectedPitchId] = useState<string>("");
  const [copy, setCopy] = useState<AdCopyResult | undefined>(undefined);
  const [isProposing, setIsProposing] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const selectedPitch = useMemo(
    (): AdPitch | undefined =>
      pitches.find((pitch: AdPitch): boolean => pitch.id === selectedPitchId),
    [pitches, selectedPitchId],
  );

  async function handlePropose(): Promise<void> {
    setError("");
    setCopy(undefined);
    setIsProposing(true);
    try {
      const result = await adAgent.proposePitches({
        product,
        target,
        appealAxis,
      });
      setPitches(result.data.pitches);
      setSelectedPitchId(result.data.pitches[0]?.id ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "訴求提案に失敗しました");
    } finally {
      setIsProposing(false);
    }
  }

  async function handleAdopt(pitch: AdPitch): Promise<void> {
    setError("");
    try {
      const result = await adAgent.composeCopy({ pitch, target });
      setCopy(result.data);
      setSelectedPitchId(pitch.id);
      onAdoptPitch?.(pitch, result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "コピー組成に失敗しました");
    }
  }

  return (
    <section className="flex h-full flex-col gap-4 text-sm text-zinc-100">
      <div className="space-y-2">
        <label className="block text-xs font-medium text-zinc-300">
          商品/サービス
        </label>
        <textarea
          className="min-h-24 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-pink-400"
          value={product}
          onChange={(event) => setProduct(event.target.value)}
          placeholder="忙しい朝向けの時短コーヒー"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-2">
          <span className="block text-xs font-medium text-zinc-300">年代</span>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
            value={target.age}
            onChange={(event) =>
              setTarget((current: TargetForm): TargetForm => ({
                ...current,
                age: event.target.value,
              }))
            }
          >
            {AGE_OPTIONS.map((age: string) => (
              <option key={age} value={age}>
                {age}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2">
          <span className="block text-xs font-medium text-zinc-300">性別</span>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
            value={target.gender}
            onChange={(event) =>
              setTarget((current: TargetForm): TargetForm => ({
                ...current,
                gender: event.target.value,
              }))
            }
          >
            {GENDER_OPTIONS.map((gender: string) => (
              <option key={gender} value={gender}>
                {gender}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="space-y-2">
        <span className="block text-xs font-medium text-zinc-300">
          職業/属性
        </span>
        <input
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
          value={target.attribute}
          onChange={(event) =>
            setTarget((current: TargetForm): TargetForm => ({
              ...current,
              attribute: event.target.value,
            }))
          }
          placeholder="働く女性"
        />
      </label>

      <label className="space-y-2">
        <span className="block text-xs font-medium text-zinc-300">悩み</span>
        <input
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
          value={target.pain}
          onChange={(event) =>
            setTarget((current: TargetForm): TargetForm => ({
              ...current,
              pain: event.target.value,
            }))
          }
          placeholder="朝の時間がない"
        />
      </label>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <label className="space-y-2">
          <span className="block text-xs font-medium text-zinc-300">
            訴求軸
          </span>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-pink-400"
            value={appealAxis}
            onChange={(event) => setAppealAxis(event.target.value as AppealAxis)}
          >
            {APPEAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="self-end rounded-md bg-pink-500 px-4 py-2 font-medium text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          type="button"
          disabled={isProposing}
          onClick={handlePropose}
        >
          {isProposing ? "提案中" : "訴求提案"}
        </button>
      </div>

      {error ? <p className="text-xs text-red-300">{error}</p> : null}

      <div className="space-y-3">
        {pitches.map((pitch: AdPitch) => (
          <article
            className={`rounded-md border p-3 ${
              pitch.id === selectedPitch?.id
                ? "border-pink-400 bg-pink-400/10"
                : "border-zinc-800 bg-zinc-900"
            }`}
            key={pitch.id}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-zinc-50">{pitch.title}</p>
                <p className="mt-1 text-xs text-zinc-300">{pitch.angle}</p>
                <p className="mt-2 text-xs text-zinc-500">{pitch.reason}</p>
              </div>
              <button
                className="shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-100 hover:border-pink-400"
                type="button"
                onClick={() => void handleAdopt(pitch)}
              >
                採用
              </button>
            </div>
          </article>
        ))}
      </div>

      {copy ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-xs text-zinc-500">コピー</p>
          <p className="mt-2 font-medium text-zinc-50">{copy.mainCopy}</p>
          <p className="mt-1 text-sm text-zinc-300">{copy.subCopy}</p>
        </div>
      ) : null}
    </section>
  );
}
