import type { SceneOption } from "../../lib/scene/catalog";

type Props = {
  option: SceneOption;
  selected: boolean;
  onSelect: () => void;
};

/**
 * Visual card for a SceneOption. Shows a small glyph (SVG) representing
 * the option category, its label, and a one-line hint. No external image
 * assets required for MVP; thumbnails can be added later by populating
 * `option.thumbnail`.
 */
export function SceneOptionCard({ option, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "group flex items-center gap-2 rounded-md border px-2 py-1.5 text-left transition",
        selected
          ? "border-pink-400 bg-pink-500/10 text-white shadow-lg shadow-pink-500/10"
          : "border-[#343434] bg-[#101010] text-neutral-100 hover:border-pink-400 hover:bg-[#1f1f1f]",
      ].join(" ")}
    >
      <Glyph option={option} selected={selected} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-bold leading-tight">
          {option.value}
        </div>
        {option.hint && (
          <div
            className={[
              "truncate text-[9px] leading-tight",
              selected ? "text-neutral-300" : "text-neutral-500",
            ].join(" ")}
          >
            {option.hint}
          </div>
        )}
      </div>
    </button>
  );
}

function Glyph({ option, selected }: { option: SceneOption; selected: boolean }) {
  if (option.thumbnail) {
    return (
      <img
        src={option.thumbnail.src}
        alt={option.thumbnail.alt}
        className="h-7 w-10 shrink-0 rounded object-cover"
      />
    );
  }

  const stroke = selected ? "#fff" : "#171717";
  const fill = selected ? "#fff" : "#171717";
  const sub = selected ? "#a3a3a3" : "#737373";

  return (
    <svg
      viewBox="0 0 56 40"
      width={36}
      height={26}
      className="shrink-0 rounded"
      style={{ background: selected ? "#262626" : "#f5f5f5" }}
    >
      {renderGlyphPath(option.visual, stroke, fill, sub, selected)}
    </svg>
  );
}

function renderGlyphPath(
  visual: SceneOption["visual"],
  stroke: string,
  fill: string,
  sub: string,
  selected: boolean,
) {
  switch (visual) {
    case "frame-close":
      // Big subject filling the frame
      return (
        <>
          <rect x="2" y="2" width="52" height="36" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          <circle cx="28" cy="20" r="14" fill={fill} />
        </>
      );
    case "frame-medium":
      return (
        <>
          <rect x="2" y="2" width="52" height="36" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          <circle cx="28" cy="14" r="6" fill={fill} />
          <rect x="20" y="20" width="16" height="18" rx="2" fill={fill} />
        </>
      );
    case "frame-wide":
      return (
        <>
          <rect x="2" y="2" width="52" height="36" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          <line x1="6" y1="32" x2="50" y2="32" stroke={sub} strokeWidth="1" />
          <circle cx="28" cy="26" r="3" fill={fill} />
          <rect x="26" y="29" width="4" height="6" fill={fill} />
        </>
      );
    case "frame-aerial":
      return (
        <>
          <rect x="2" y="2" width="52" height="36" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          <circle cx="28" cy="20" r="4" fill={fill} />
          <line x1="14" y1="20" x2="42" y2="20" stroke={sub} strokeWidth="0.6" strokeDasharray="2 2" />
          <line x1="28" y1="6" x2="28" y2="34" stroke={sub} strokeWidth="0.6" strokeDasharray="2 2" />
        </>
      );
    case "frame-tilt":
      return (
        <>
          <g transform="rotate(-12 28 20)">
            <rect x="6" y="6" width="44" height="28" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          </g>
          <circle cx="28" cy="20" r="6" fill={fill} />
        </>
      );
    case "frame-shoulder":
      return (
        <>
          <rect x="2" y="2" width="52" height="36" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
          <path d="M 4 38 Q 12 24 24 26 L 24 38 Z" fill={fill} />
          <circle cx="36" cy="18" r="6" fill="none" stroke={stroke} strokeWidth="1" />
        </>
      );
    case "aspect":
      return (
        <rect x="6" y="4" width="44" height="32" rx="2" fill="none" stroke={stroke} strokeWidth="1.5" />
      );
    case "light-natural":
      return (
        <>
          <circle cx="44" cy="10" r="6" fill={fill} />
          <line x1="36" y1="14" x2="14" y2="32" stroke={sub} strokeWidth="1" />
          <line x1="40" y1="18" x2="22" y2="34" stroke={sub} strokeWidth="1" />
          <line x1="46" y1="20" x2="32" y2="36" stroke={sub} strokeWidth="1" />
        </>
      );
    case "light-studio":
      return (
        <>
          <rect x="6" y="6" width="20" height="28" rx="2" fill={fill} opacity="0.85" />
          <rect x="30" y="6" width="20" height="28" rx="2" fill={fill} opacity="0.85" />
          <circle cx="28" cy="20" r="4" fill="none" stroke={stroke} strokeWidth="1" />
        </>
      );
    case "light-back":
      return (
        <>
          <circle cx="28" cy="34" r="20" fill={fill} opacity="0.4" />
          <circle cx="28" cy="22" r="6" fill={stroke === "#fff" ? "#000" : stroke} />
        </>
      );
    case "light-blue-hour":
      return (
        <>
          <rect x="0" y="0" width="56" height="20" fill="#1e3a8a" />
          <rect x="0" y="20" width="56" height="20" fill="#0f172a" />
          <circle cx="28" cy="20" r="3" fill="#fde68a" />
        </>
      );
    case "light-candle":
      return (
        <>
          <rect x="24" y="22" width="8" height="14" rx="1" fill={fill} />
          <ellipse cx="28" cy="18" rx="3" ry="6" fill="#fbbf24" />
          <circle cx="28" cy="18" r="14" fill="#fbbf24" opacity="0.18" />
        </>
      );
    case "light-softbox":
      return (
        <>
          <rect x="8" y="8" width="40" height="24" rx="3" fill={fill} opacity="0.85" />
          <rect x="12" y="12" width="32" height="16" rx="2" fill="#fff" opacity="0.6" />
        </>
      );
    case "camera-film":
      return (
        <>
          <rect x="6" y="10" width="44" height="22" rx="2" fill={fill} />
          <circle cx="20" cy="21" r="6" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="2" />
          <rect x="32" y="14" width="14" height="14" rx="1" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="1" />
        </>
      );
    case "camera-digital":
      return (
        <>
          <rect x="6" y="12" width="44" height="20" rx="3" fill={fill} />
          <circle cx="28" cy="22" r="6" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="2" />
          <rect x="40" y="14" width="6" height="3" rx="0.5" fill={selected ? "#000" : "#fff"} />
        </>
      );
    case "camera-retro":
      return (
        <>
          <rect x="4" y="14" width="48" height="18" rx="2" fill={fill} />
          <circle cx="22" cy="22" r="4" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="1.5" />
          <circle cx="38" cy="22" r="4" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="1.5" />
        </>
      );
    case "camera-cinema":
      return (
        <>
          <rect x="4" y="14" width="32" height="18" rx="2" fill={fill} />
          <circle cx="20" cy="22" r="6" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="2" />
          <polygon points="36,16 50,12 50,32 36,28" fill={fill} />
        </>
      );
    case "camera-mobile":
      return (
        <>
          <rect x="20" y="4" width="16" height="32" rx="3" fill={fill} />
          <circle cx="28" cy="14" r="3" fill="none" stroke={selected ? "#000" : "#fff"} strokeWidth="1.2" />
        </>
      );
    case "focal":
      return (
        <>
          <line x1="6" y1="20" x2="50" y2="20" stroke={stroke} strokeWidth="1" />
          <circle cx="6" cy="20" r="3" fill={fill} />
          <polygon points="50,20 44,16 44,24" fill={fill} />
        </>
      );
    case "lens":
      return (
        <>
          <circle cx="28" cy="20" r="14" fill="none" stroke={stroke} strokeWidth="1.5" />
          <circle cx="28" cy="20" r="9" fill="none" stroke={stroke} strokeWidth="1" />
          <circle cx="28" cy="20" r="5" fill={fill} />
        </>
      );
    case "film-stock":
      return (
        <>
          <rect x="4" y="10" width="48" height="22" rx="1" fill={fill} />
          <g fill={selected ? "#000" : "#fff"}>
            <rect x="6" y="12" width="3" height="3" />
            <rect x="6" y="18" width="3" height="3" />
            <rect x="6" y="24" width="3" height="3" />
            <rect x="47" y="12" width="3" height="3" />
            <rect x="47" y="18" width="3" height="3" />
            <rect x="47" y="24" width="3" height="3" />
          </g>
        </>
      );
    case "style":
      return (
        <>
          <rect x="4" y="6" width="48" height="28" rx="2" fill={fill} />
          <line x1="20" y1="6" x2="20" y2="34" stroke={selected ? "#000" : "#fff"} strokeWidth="1" />
          <line x1="36" y1="6" x2="36" y2="34" stroke={selected ? "#000" : "#fff"} strokeWidth="1" />
        </>
      );
    case "filter":
      return (
        <>
          <circle cx="20" cy="20" r="10" fill={fill} opacity="0.85" />
          <circle cx="36" cy="20" r="10" fill={fill} opacity="0.55" />
        </>
      );
    case "none":
    default:
      return (
        <>
          <line x1="8" y1="32" x2="48" y2="8" stroke={sub} strokeWidth="1.5" />
          <rect x="6" y="6" width="44" height="28" rx="2" fill="none" stroke={stroke} strokeWidth="1" />
        </>
      );
  }
}
