export const ADVISOR_ARTIFACT_TYPES = [
  "logline",
  "beatsheet",
  "treatment",
  "scenelist",
  "blocks",
  "premise",
] as const;

export type AdvisorArtifactType = (typeof ADVISOR_ARTIFACT_TYPES)[number];

export type AdvisorArtifact = {
  type: AdvisorArtifactType;
  content: string;
  premiseFields?: Record<string, string>;
};

export type AdvisorParseResult = {
  raw: string;
  text: string;
  artifacts: AdvisorArtifact[];
  malformed: boolean;
  error?: string;
};

const ARTIFACT_FENCE_START = /```artifact:/gu;
const CLOSED_ARTIFACT_FENCE = /```artifact:([^\n`]*)\r?\n([\s\S]*?)```/gu;

function isArtifactType(value: string): value is AdvisorArtifactType {
  return (ADVISOR_ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** premise の「項目: 値」を、表記順に依存せず取り出す。 */
export function parsePremiseFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const sourceLine of content.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = sourceLine.trim().replace(/^[-*]\s*/u, "");
    if (!line) continue;
    const match = line.match(/^([^:：]+?)\s*[:：]\s*(.+)$/u);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

/**
 * AIの返事を決定論で分ける。壊れたフェンスは原文を丸ごと text に残し、
 * UIが「もう一度お願いする」を出せるよう malformed を立てる。
 */
export function parseAdvisorResponse(raw: string): AdvisorParseResult {
  const artifacts: AdvisorArtifact[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  const errors: string[] = [];
  let closedFenceCount = 0;

  for (const match of raw.matchAll(CLOSED_ARTIFACT_FENCE)) {
    closedFenceCount += 1;
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
    const type = match[1].trim();
    const content = match[2].trim();
    if (!isArtifactType(type)) {
      errors.push(`未対応の成果物種別「${type || "空欄"}」です`);
      continue;
    }
    if (!content) {
      errors.push(`${type} の成果物が空です`);
      continue;
    }
    artifacts.push({
      type,
      content,
      ...(type === "premise" ? { premiseFields: parsePremiseFields(content) } : {}),
    });
  }

  const startCount = [...raw.matchAll(ARTIFACT_FENCE_START)].length;
  if (startCount !== closedFenceCount) {
    errors.push("成果物フェンスの開始と終了がそろっていません");
  }

  const malformed = errors.length > 0;
  let text = raw.trim();
  if (!malformed && ranges.length > 0) {
    let cursor = 0;
    const prose: string[] = [];
    for (const range of ranges) {
      prose.push(raw.slice(cursor, range.start));
      cursor = range.end;
    }
    prose.push(raw.slice(cursor));
    text = prose.join("").replace(/\n{3,}/gu, "\n\n").trim();
  }

  return {
    raw,
    text,
    artifacts,
    malformed,
    ...(errors.length > 0 ? { error: errors.join("。") } : {}),
  };
}
