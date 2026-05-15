type Size = "sm" | "lg";

type Props = {
  label: string;
  size?: Size;
};

/**
 * Cinematic placeholder card used when an option has no `thumbnail` image.
 * Mirrors the existing "CINE" placeholder visual (dark plum gradient with
 * a centered short label). Used for `No select` and any option that has
 * not had a generated thumbnail yet.
 */
export function CinePlaceholder({ label, size = "sm" }: Props) {
  const text = shortLabel(label);
  const fontClass = size === "lg" ? "text-base" : "text-[8px]";
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-pink-900/40 via-neutral-900 to-neutral-950">
      <span
        className={`${fontClass} font-bold uppercase tracking-wider text-neutral-300`}
      >
        {text}
      </span>
    </div>
  );
}

function shortLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "CINE";
  // Use the first significant token; keep it short for tiny thumbnails.
  if (trimmed.length <= 8) return trimmed.toUpperCase();
  // For long labels (e.g. "Over-the-shoulder", "ARRI Alexa Mini") keep the
  // first word's first 8 chars uppercase.
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord.slice(0, 8).toUpperCase();
}
