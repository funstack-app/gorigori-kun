import { useEffect, useState } from "react";

const PROGRESS_CAP = 95;
const PROGRESS_TAU_SECONDS = 90;
const TICK_MS = 1000;

type GenerationGaugeProps = {
  startedAt: number;
  done?: boolean;
};

/** 実進捗が取れない生成処理を、経過時間から滑らかな推定ゲージとして表示する。 */
export function GenerationGauge({ startedAt, done = false }: GenerationGaugeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (done) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [done, startedAt]);

  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const estimatedPercent = done
    ? 100
    : PROGRESS_CAP * (1 - Math.exp(-elapsedSeconds / PROGRESS_TAU_SECONDS));

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
