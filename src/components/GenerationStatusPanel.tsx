import { useEffect, useState } from "react";
import {
  GENERATION_KIND_LABEL,
  NO_RESPONSE_THRESHOLD_MS,
  describeStall,
  jobPercent,
  useGenerationStatus,
  type GenerationJob,
} from "../lib/store/generationStatus";

/**
 * 右上に常駐する「生成の今」パネル。
 *
 * ## なぜ (2026-07-25 STΛCK指示)
 * 「生成中のまま進まない」と見えたとき、実際には codex exec が4本並列で動いていた。
 * 止まっているのか動いているのかがユーザーから判別できないのが最大の問題だった。
 * そこで次の3点を常時見せる:
 *   - 並列で何枚動いているか
 *   - 認証が切れていないか
 *   - 進まないなら何が原因か (エラーコードを含む)
 * フリーズに見える状態を作らないことが目的。
 */

/** 秒を「1分20秒」形式にする。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

function SpinnerIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function JobRow({ job }: { job: GenerationJob }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (job.finished) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [job.finished]);

  // 無反応の自動検出。理由が未設定でも、黙って固まらせない。
  const silentFor = now - job.lastEventAt;
  const effectiveStall =
    job.stall ??
    (!job.finished && job.running > 0 && silentFor > NO_RESPONSE_THRESHOLD_MS
      ? ({ type: "no-response", sinceMs: silentFor } as const)
      : null);

  const percent = jobPercent(job, 120);
  const settled = job.completed + job.failed;
  const isError = effectiveStall?.type === "error" || effectiveStall?.type === "auth-required";

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#141414]/95 px-3 py-2.5 shadow-lg backdrop-blur">
      {/* 見出し: 種類 + 並列稼働数。本文より一段大きく太く（情報階層） */}
      <div className="flex items-center gap-2">
        {job.finished ? null : (
          <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-pink-400" />
        )}
        <span className="text-[13px] font-black leading-tight text-white">
          {GENERATION_KIND_LABEL[job.kind]}
        </span>
        {job.running > 0 && (
          <span className="rounded-full bg-[#2a1f26] px-1.5 py-0.5 text-[10px] font-bold text-pink-300">
            {job.running}枚 同時実行
          </span>
        )}
      </div>

      {/* 本文: 数値の内訳。見出しより小さく、色を落とす */}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-400">
        <span className="font-mono tabular-nums text-neutral-300">
          {job.total ? `${settled} / ${job.total}` : `${settled} 枚`}
        </span>
        {job.failed > 0 && (
          <span className="font-mono tabular-nums text-red-400">失敗 {job.failed}</span>
        )}
        <span className="ml-auto font-mono tabular-nums text-neutral-500">
          {formatElapsed(now - job.startedAt)}
        </span>
      </div>

      {/* 進捗バー: total があれば実測、無ければ経過時間で補間（90%止め） */}
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-[#2a2a2a]">
        <div
          className={
            "h-full rounded-full transition-[width] duration-700 ease-out " +
            (isError
              ? "bg-red-500"
              : "bg-gradient-to-r from-pink-600 to-pink-400")
          }
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* 進まない理由。ここが空にならないことがこのパネルの存在意義 */}
      {effectiveStall && (
        <div
          className={
            "mt-2 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug " +
            (isError ? "bg-[#2a1818] text-red-300" : "bg-[#1e1e1e] text-amber-300")
          }
        >
          <AlertIcon className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>{describeStall(effectiveStall)}</span>
        </div>
      )}
    </div>
  );
}

export function GenerationStatusPanel() {
  const jobs = useGenerationStatus((s) => s.jobs);
  const active = Object.values(jobs).filter((job) => !job.finished);
  if (active.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-32 z-30 flex w-72 flex-col gap-2">
      {active.map((job) => (
        <JobRow key={job.id} job={job} />
      ))}
    </div>
  );
}
