import { useEffect, useState } from "react";

const STORAGE_KEY = "gori.gauge.durations.v1";
const DEFAULT_EXPECTED_SECONDS = 120;
const MAX_HISTORY = 10;
const TICK_MS = 1000;

export type GenerationGaugeMode = "batch" | "multiangle" | "storyboard";

type GenerationGaugeProps = {
  startedAt: number;
  mode: GenerationGaugeMode;
  done?: boolean;
};

type DurationHistory = Partial<Record<GenerationGaugeMode, number[]>>;

function readHistory(): DurationHistory {
  try {
    if (typeof window === "undefined") return {};
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as DurationHistory;
  } catch {
    return {};
  }
}

function validDurations(history: DurationHistory, mode: GenerationGaugeMode): number[] {
  const values = history[mode];
  if (!Array.isArray(values)) return [];
  return values.filter((value) => Number.isFinite(value) && value > 0).slice(-MAX_HISTORY);
}

function expectedSeconds(mode: GenerationGaugeMode): number {
  const values = validDurations(readHistory(), mode).sort((a, b) => a - b);
  if (values.length === 0) return DEFAULT_EXPECTED_SECONDS;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

/** 成功したカードの実測時間だけを、モード別の直近10件へ追加する。 */
export function recordGenerationDuration(mode: GenerationGaugeMode, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    if (typeof window === "undefined") return;
    const history = readHistory();
    history[mode] = [...validDurations(history, mode), seconds].slice(-MAX_HISTORY);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage が使えない環境でも、ゲージ表示と生成処理は継続する。
  }
}

function estimatePercent(elapsedSeconds: number, expected: number): number {
  if (elapsedSeconds <= expected) {
    return 90 * (elapsedSeconds / expected);
  }
  const overtime = elapsedSeconds - expected;
  return Math.min(99, 90 + 9 * (1 - Math.exp(-overtime / expected)));
}

/** 実進捗が取れない生成処理を、経過時間から滑らかな推定ゲージとして表示する。 */
export function GenerationGauge({ startedAt, mode, done = false }: GenerationGaugeProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expected, setExpected] = useState(() => expectedSeconds(mode));

  useEffect(() => {
    setExpected(expectedSeconds(mode));
  }, [mode, startedAt]);

  useEffect(() => {
    if (done) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [done, startedAt]);

  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const estimatedPercent = done
    ? 100
    : estimatePercent(elapsedSeconds, expected);

  return (
    <div
      className="h-[3px] w-full overflow-hidden rounded-full bg-[#2a2a2a]"
      aria-label="生成の推定進捗"
    >
      <div
        className="h-full rounded-full bg-gradient-to-r from-pink-600 to-pink-400 transition-[width] duration-700 ease-out"
        style={{ width: `${estimatedPercent}%` }}
      />
    </div>
  );
}
