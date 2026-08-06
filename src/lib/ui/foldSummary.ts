const NO_SELECT = "No select";

export function show(
  value: string,
  fallback: string,
  noSelect = NO_SELECT,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === noSelect) return fallback;
  return trimmed;
}

export function compact(...values: string[]): string {
  const filtered = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== NO_SELECT);
  return filtered.length > 0 ? filtered.join(" / ") : "未設定";
}
