import { useEffect, useState } from "react";
import { useAuth } from "../lib/store/auth";

export function RateBadge() {
  const rate = useAuth((s) => s.rateLimits?.primary);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!rate) return null;
  const pct = Math.min(100, Math.max(0, rate.usedPercent ?? 0));
  const remaining = formatRemaining(rate.resetsAt - now);
  const tone =
    pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-md border border-neutral-200 bg-white px-2 text-[11px] text-neutral-500 shadow-sm"
      title={`${pct}% 使用 / ${remaining} 後リセット`}
    >
      <span className="relative inline-block h-1.5 w-14 overflow-hidden rounded-full bg-neutral-200">
        <span
          className={`absolute inset-y-0 left-0 ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-neutral-500">
        {pct}% · リセット {remaining}
      </span>
    </span>
  );
}

function formatRemaining(secs: number): string {
  if (secs <= 0) return "まもなく";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}
