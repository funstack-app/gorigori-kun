import type { FilmPhase } from "../../../lib/film/types";

const PHASES: Array<{
  id: FilmPhase;
  label: string;
  subLabel: string;
}> = [
  { id: 1, label: "① 企画", subLabel: "目的を固定" },
  { id: 2, label: "② 脚本", subLabel: "物語を書く" },
  { id: 3, label: "③ 設計", subLabel: "見た目を決める" },
  { id: 4, label: "④ アセット", subLabel: "素材をそろえる" },
  { id: 5, label: "⑤ 生成", subLabel: "ブロックで作る" },
  { id: 6, label: "⑥ 仕上げ", subLabel: "一本に完成" },
];

function PhaseIcon({ phase }: { phase: FilmPhase }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (phase) {
    case 1:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 2:
      return (
        <svg {...common}>
          <path d="M6 4h9l3 3v13H6z" />
          <path d="M9 10h6M9 14h6" />
        </svg>
      );
    case 3:
      return (
        <svg {...common}>
          <path d="m4 16 8-12 8 12" />
          <path d="M7 16h10v4H7z" />
        </svg>
      );
    case 4:
      return (
        <svg {...common}>
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="7" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
          <rect x="13" y="13" width="7" height="7" rx="1" />
        </svg>
      );
    case 5:
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m10 9 5 3-5 3z" />
        </svg>
      );
    case 6:
      return (
        <svg {...common}>
          <path d="M5 4h14v16H5z" />
          <path d="m9 12 2 2 4-5" />
        </svg>
      );
  }
}

export function FilmPhaseRail({
  phase,
  onSelect,
}: {
  phase: FilmPhase;
  onSelect: (phase: FilmPhase) => void;
}) {
  return (
    <nav
      aria-label="フィルム制作工程"
      className="flex h-full w-52 shrink-0 flex-col gap-2 border-r border-[#242424] bg-[#161616] px-3 py-4"
    >
      {PHASES.map((item) => {
        const active = phase === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "step" : undefined}
            onClick={() => onSelect(item.id)}
            className={[
              "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition",
              active
                ? "border-pink-500 bg-pink-500/10 text-pink-200"
                : "border-[#2a2a2a] bg-transparent text-zinc-300 hover:border-pink-500/40 hover:bg-pink-500/5",
            ].join(" ")}
          >
            <span className={active ? "text-pink-400" : "text-zinc-500"}>
              <PhaseIcon phase={item.id} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-semibold">{item.label}</span>
              <span className="text-[11px] text-zinc-500">{item.subLabel}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
