import type { ReactNode } from "react";
import { useToasts, type ToastKind } from "../lib/store/toasts";

/* --- フラットアイコン (絵文字廃止) --- */

const TOAST_SVG = {
  width: 10,
  height: 10,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function CheckIcon() {
  return (
    <svg {...TOAST_SVG} aria-hidden>
      <path d="M4 12.5l5.5 5.5L20 6" />
    </svg>
  );
}

function WarnTriangleIcon() {
  return (
    <svg {...TOAST_SVG} aria-hidden>
      <path d="M12 3.5L22 20H2z" />
      <path d="M12 9.5v4.5M12 17.2v.3" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg {...TOAST_SVG} aria-hidden>
      <path d="M12 10.5v7M12 6.6v.3" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg {...TOAST_SVG} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** コピー (重ねた矩形)。 */
function CopyIcon() {
  return (
    <svg {...TOAST_SVG} width={13} height={13} strokeWidth={1.8} aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M15 6V5a1 1 0 00-1-1H5a1 1 0 00-1 1v9a1 1 0 001 1h1" />
    </svg>
  );
}

/** 閉じる (×)。 */
function CloseIcon() {
  return (
    <svg {...TOAST_SVG} width={13} height={13} strokeWidth={1.8} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

const kindStyles: Record<ToastKind, { ring: string; bar: string; icon: ReactNode }> = {
  info: { ring: "ring-sky-700/60", bar: "bg-sky-500", icon: <InfoIcon /> },
  success: { ring: "ring-emerald-700/60", bar: "bg-emerald-500", icon: <CheckIcon /> },
  warn: { ring: "ring-amber-700/60", bar: "bg-amber-500", icon: <WarnTriangleIcon /> },
  error: { ring: "ring-rose-700/60", bar: "bg-rose-500", icon: <CrossIcon /> },
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-40 flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const s = kindStyles[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg bg-neutral-900/90 p-3 text-sm text-neutral-100 shadow-lg ring-1 ${s.ring} backdrop-blur`}
          >
            <span
              className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-neutral-900 ${s.bar}`}
              aria-hidden
            >
              {s.icon}
            </span>
            <span className="flex-1 whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-200">
              {t.text}
            </span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(t.text);
                } catch {
                  // navigator.clipboard が利用できない環境は無視
                }
              }}
              className="mt-0.5 text-neutral-500 hover:text-neutral-200"
              aria-label="コピー"
              title="コピー"
            >
              <CopyIcon />
            </button>
            <button
              onClick={() => dismiss(t.id)}
              className="mt-0.5 text-neutral-500 hover:text-neutral-200"
              aria-label="閉じる"
              title="閉じる"
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
