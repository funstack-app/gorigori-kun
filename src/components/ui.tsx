import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "xs" | "sm" | "md";

const toneClass: Record<ButtonTone, string> = {
  primary:
    "border-neutral-950 bg-neutral-950 text-white hover:bg-neutral-800 disabled:hover:bg-neutral-950",
  secondary:
    "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 hover:text-neutral-950 disabled:hover:border-neutral-300",
  ghost:
    "border-transparent bg-transparent text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950",
  danger:
    "border-neutral-300 bg-white text-neutral-600 hover:border-rose-500 hover:text-rose-600",
};

const sizeClass: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-[11px]",
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3 text-sm",
};

export function Button({
  tone = "secondary",
  size = "sm",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: ButtonSize;
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${toneClass[tone]} ${sizeClass[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold transition ${
        active
          ? "border-neutral-950 bg-neutral-950 text-white"
          : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-500 hover:text-neutral-950"
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "amber" | "rose";
}) {
  const cls =
    tone === "blue"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : tone === "rose"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-neutral-200 bg-neutral-50 text-neutral-600";
  return (
    <span
      className={`inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

export function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="grid rounded-md border border-neutral-200 bg-neutral-100 p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={`h-8 rounded px-2 text-xs font-medium transition ${
            value === key
              ? "bg-white text-neutral-950 shadow-sm"
              : "text-neutral-500 hover:text-neutral-950"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-neutral-300 bg-white px-3 py-6 text-center">
      <p className="text-xs font-medium text-neutral-700">{title}</p>
      {description && (
        <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
          {description}
        </p>
      )}
    </div>
  );
}
