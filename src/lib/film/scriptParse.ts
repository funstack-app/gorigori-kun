import type { FilmBlock, FilmScene } from "./types";

export type ScriptParseFailure = {
  ok: false;
  error: {
    line: number;
    column: number;
    reason: string;
    sourceLine: string;
  };
};

export type ScriptParseSuccess<T> = { ok: true; value: T };
export type ScriptParseResult<T> = ScriptParseSuccess<T> | ScriptParseFailure;

export type ParsedBlockScript = {
  scenes: FilmScene[];
  blocks: FilmBlock[];
};

export type ScriptCheckCode =
  | "duration-total"
  | "block-duration-limit"
  | "block-sequence"
  | "character-name-variation"
  | "foreshadow-pair";

export type ScriptCheckIssue = {
  code: ScriptCheckCode;
  severity: "warning" | "blocking";
  message: string;
  location?: string;
};

function failure(
  lines: string[],
  lineIndex: number,
  reason: string,
  column = 1,
): ScriptParseFailure {
  const safeIndex = Math.max(0, Math.min(lineIndex, Math.max(0, lines.length - 1)));
  return {
    ok: false,
    error: {
      line: lineIndex + 1,
      column,
      reason,
      sourceLine: lines[safeIndex] ?? "",
    },
  };
}

type SceneDraft = FilmScene & { summaries: string[] };
type BlockDraft = {
  id: string;
  sceneId: string;
  durationSeconds: number;
  summary: string;
  headerLine: number;
  fields: Partial<Record<"画" | "芝居" | "セリフ" | "音" | "伏線", string>>;
  fieldOrder: string[];
};

const REQUIRED_BLOCK_FIELDS = ["画", "芝居", "セリフ", "音", "伏線"] as const;

function parseForeshadowIds(value: string): string[] {
  if (/^(なし|無し|該当なし)$/u.test(value.trim())) return [];
  return [...value.matchAll(/\bF(\d+)\b/giu)]
    .map((match) => `F${Number(match[1])}`)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

/** 強制書式のブロック脚本を FilmProject.script の scenes / blocks へ変換する。 */
export function parseBlockScript(raw: string): ScriptParseResult<ParsedBlockScript> {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const scenes: SceneDraft[] = [];
  const blocks: FilmBlock[] = [];
  let currentScene: SceneDraft | null = null;
  let currentBlock: BlockDraft | null = null;

  const finishBlock = (atLine: number): ScriptParseFailure | null => {
    if (!currentBlock) return null;
    for (let index = 0; index < REQUIRED_BLOCK_FIELDS.length; index += 1) {
      const field = REQUIRED_BLOCK_FIELDS[index];
      if (currentBlock.fields[field] === undefined) {
        return failure(
          lines,
          currentBlock.headerLine,
          `${currentBlock.id} に「- ${field}:」行がありません`,
        );
      }
      if (currentBlock.fieldOrder[index] !== field) {
        return failure(
          lines,
          atLine,
          `${currentBlock.id} の項目順は「画→芝居→セリフ→音→伏線」にしてください`,
        );
      }
    }
    const scene = currentScene;
    if (!scene) return failure(lines, currentBlock.headerLine, "ブロックより前にシーン見出しが必要です");
    scene.summaries.push(currentBlock.summary);
    blocks.push({
      id: currentBlock.id,
      sceneId: currentBlock.sceneId,
      durationSeconds: currentBlock.durationSeconds,
      visual: currentBlock.fields.画 ?? "",
      performance: currentBlock.fields.芝居 ?? "",
      dialogue: currentBlock.fields.セリフ ?? "",
      sound: currentBlock.fields.音 ?? "",
      foreshadowIds: parseForeshadowIds(currentBlock.fields.伏線 ?? ""),
    });
    currentBlock = null;
    return null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const sourceLine = lines[lineIndex];
    const line = sourceLine.trim();
    if (!line) continue;

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      const previousError = finishBlock(lineIndex);
      if (previousError) return previousError;
      const match = line.match(/^##\s+(S\d+)\s+(.+?)\s*\/\s*(\d+(?:\.\d+)?)s$/u);
      if (!match) {
        return failure(
          lines,
          lineIndex,
          "シーン見出しは「## S{n} {場所} / {秒}s」の形にしてください",
        );
      }
      const durationSeconds = Number(match[3]);
      if (!(durationSeconds > 0)) {
        return failure(lines, lineIndex, "シーン秒数は0より大きい数にしてください");
      }
      currentScene = {
        id: match[1],
        location: match[2].trim(),
        purpose: "",
        characterNames: [],
        durationSeconds,
        summaries: [],
      };
      scenes.push(currentScene);
      continue;
    }

    if (line.startsWith("### ")) {
      const previousError = finishBlock(lineIndex);
      if (previousError) return previousError;
      if (!currentScene) {
        return failure(lines, lineIndex, "ブロックより前にシーン見出しが必要です");
      }
      const match = line.match(/^###\s+(B\d+)\s+\((\d+(?:\.\d+)?)s\)\s+(.+)$/u);
      if (!match) {
        return failure(
          lines,
          lineIndex,
          "ブロック見出しは「### B{通し番号} ({秒数}s) {一行要約}」の形にしてください",
        );
      }
      const durationSeconds = Number(match[2]);
      if (!(durationSeconds > 0)) {
        return failure(lines, lineIndex, "ブロック秒数は0より大きい数にしてください");
      }
      currentBlock = {
        id: match[1],
        sceneId: currentScene.id,
        durationSeconds,
        summary: match[3].trim(),
        headerLine: lineIndex,
        fields: {},
        fieldOrder: [],
      };
      continue;
    }

    if (line.startsWith("##") || line.startsWith("###")) {
      return failure(lines, lineIndex, "見出しの # と空白を正しい書式に直してください");
    }

    const fieldMatch = line.match(/^-\s*(画|芝居|セリフ|音|伏線)\s*[:：]\s*(.*)$/u);
    if (!fieldMatch) {
      return failure(lines, lineIndex, "見出しまたは「- 項目: 内容」の行だけを書いてください");
    }
    if (!currentBlock) {
      return failure(lines, lineIndex, "項目行より前にブロック見出しが必要です");
    }
    const field = fieldMatch[1] as (typeof REQUIRED_BLOCK_FIELDS)[number];
    if (currentBlock.fields[field] !== undefined) {
      return failure(lines, lineIndex, `${currentBlock.id} の「${field}」が重複しています`);
    }
    if (!fieldMatch[2].trim()) {
      return failure(lines, lineIndex, `${currentBlock.id} の「${field}」を空欄にできません`);
    }
    currentBlock.fields[field] = fieldMatch[2].trim();
    currentBlock.fieldOrder.push(field);
  }

  const finalError = finishBlock(Math.max(0, lines.length - 1));
  if (finalError) return finalError;
  if (scenes.length === 0) return failure(lines, 0, "シーン見出しが1つもありません");
  if (blocks.length === 0) return failure(lines, 0, "ブロック見出しが1つもありません");

  return {
    ok: true,
    value: {
      scenes: scenes.map(({ summaries, ...scene }) => ({
        ...scene,
        purpose: summaries.join(" / "),
      })),
      blocks,
    },
  };
}

/** AIへ強制したMarkdown表を FilmScene[] へ変換する。 */
export function parseSceneList(raw: string): ScriptParseResult<FilmScene[]> {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const scenes: FilmScene[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    if (!line) continue;
    if (!line.startsWith("|")) {
      return failure(lines, lineIndex, "シーンリストはMarkdown表だけにしてください");
    }
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells[0] === "S番号" || cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
    if (cells.length !== 5) {
      return failure(lines, lineIndex, "表は「S番号・場所・目的・登場人物・推定秒数」の5列にしてください");
    }
    if (!/^S\d+$/u.test(cells[0])) {
      return failure(lines, lineIndex, "S番号はS1から始まる番号にしてください");
    }
    const durationMatch = cells[4].match(/^(\d+(?:\.\d+)?)\s*(?:秒|s)$/iu);
    if (!durationMatch || !(Number(durationMatch[1]) > 0)) {
      return failure(lines, lineIndex, "推定秒数は「10秒」の形で書いてください");
    }
    const characterNames = /^(なし|無し)$/u.test(cells[3])
      ? []
      : cells[3].split(/[、,／/]/u).map((name) => name.trim()).filter(Boolean);
    scenes.push({
      id: cells[0],
      location: cells[1],
      purpose: cells[2],
      characterNames,
      durationSeconds: Number(durationMatch[1]),
    });
  }
  if (scenes.length === 0) return failure(lines, 0, "シーン行が1つもありません");
  return { ok: true, value: scenes };
}

/** 「12秒」「(12s)」のような秒数を本文から決定論で合計する。 */
export function sumWrittenDurations(text: string): number {
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:秒|s)(?![\dA-Za-z])/giu)) {
    total += Number(match[1]);
  }
  return total;
}

export function validateDurationTotal(
  actualSeconds: number,
  targetSeconds: number,
  options: { label: "拍" | "シーン"; toleranceRatio?: number },
): ScriptCheckIssue[] {
  const tolerance = Math.max(0, options.toleranceRatio ?? 0);
  const difference = Math.abs(actualSeconds - targetSeconds);
  if (difference <= targetSeconds * tolerance + Number.EPSILON) return [];
  const toleranceText = tolerance === 0 ? "一致" : `±${Math.round(tolerance * 100)}%以内`;
  return [
    {
      code: "duration-total",
      severity: "warning",
      message: `${options.label}の秒数合計は${actualSeconds}秒です。目標${targetSeconds}秒と${toleranceText}にしてください。`,
    },
  ];
}

export function validateBeatsheetDuration(
  beatsheet: string,
  targetSeconds: number,
): ScriptCheckIssue[] {
  return validateDurationTotal(sumWrittenDurations(beatsheet), targetSeconds, {
    label: "拍",
    toleranceRatio: 0,
  });
}

export function validateSceneDuration(
  scenes: FilmScene[],
  targetSeconds: number,
): ScriptCheckIssue[] {
  return validateDurationTotal(
    scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
    targetSeconds,
    { label: "シーン", toleranceRatio: 0.1 },
  );
}

export function validateBlockDurationLimit(
  blocks: FilmBlock[],
  serviceMaxSeconds = 25,
): ScriptCheckIssue[] {
  return blocks
    .filter((block) => block.durationSeconds > serviceMaxSeconds)
    .map((block) => ({
      code: "block-duration-limit" as const,
      severity: "blocking" as const,
      location: block.id,
      message: `${block.id} は${block.durationSeconds}秒です。サービス上限${serviceMaxSeconds}秒以下に直すまで承認できません。`,
    }));
}

export function validateBlockSequence(blocks: FilmBlock[]): ScriptCheckIssue[] {
  const issues: ScriptCheckIssue[] = [];
  blocks.forEach((block, index) => {
    const expected = `B${index + 1}`;
    if (block.id !== expected) {
      issues.push({
        code: "block-sequence",
        severity: "warning",
        location: block.id,
        message: `${expected} の位置が ${block.id} になっています。B番号をB1から連番にしてください。`,
      });
    }
  });
  return issues;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function candidateNamesFor(text: string, expectedName: string): string[] {
  const candidates = new Set<string>();
  const nameLength = expectedName.length;
  if (nameLength < 2) return [];
  const nameChars = /[一-龠々〆ヵヶぁ-ゖァ-ヺーA-Za-z0-9]/u;
  const boundaryAfter = /[はがをにへとも、。：「」\s|,]/u;
  for (let index = 0; index <= text.length - nameLength; index += 1) {
    const candidate = text.slice(index, index + nameLength);
    if (![...candidate].every((char) => nameChars.test(char))) continue;
    const after = text[index + nameLength] ?? "。";
    if (!boundaryAfter.test(after)) continue;
    if (candidate === expectedName) continue;
    if (
      candidate[0] !== expectedName[0] &&
      candidate[candidate.length - 1] !== expectedName[expectedName.length - 1]
    ) continue;
    if (levenshteinDistance(candidate, expectedName) === 1) candidates.add(candidate);
  }
  return [...candidates];
}

/** 登場人物名リストと1文字だけ異なる表記を警告する（文章そのものは変更しない）。 */
export function detectCharacterNameVariations(
  text: string,
  characterNames: string[],
): ScriptCheckIssue[] {
  const issues: ScriptCheckIssue[] = [];
  for (const expected of characterNames.map((name) => name.trim()).filter(Boolean)) {
    for (const found of candidateNamesFor(text, expected)) {
      issues.push({
        code: "character-name-variation",
        severity: "warning",
        location: found,
        message: `登場人物「${expected}」に近い「${found}」があります。人名表記を確認してください。`,
      });
    }
  }
  return issues;
}

type ForeshadowUse = { id: string; kind: "plant" | "payoff" | "unknown"; blockId?: string };

function extractForeshadowUses(text: string): ForeshadowUse[] {
  const uses: ForeshadowUse[] = [];
  let currentBlockId: string | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const blockMatch = line.match(/^###\s+(B\d+)\b/u);
    if (blockMatch) currentBlockId = blockMatch[1];
    const fieldMatch = line.match(/^-\s*伏線\s*[:：]\s*(.+)$/u);
    if (!fieldMatch || /^(なし|無し)$/u.test(fieldMatch[1].trim())) continue;
    const value = fieldMatch[1];
    const matches = [...value.matchAll(/\b(F\d+)\b/giu)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? value.length;
      const context = value.slice(start, end);
      const kind = /(植込|植え込み|植える|plant)/iu.test(context)
        ? "plant"
        : /(回収|payoff|pay-off)/iu.test(context)
          ? "payoff"
          : "unknown";
      uses.push({ id: match[1].toUpperCase(), kind, blockId: currentBlockId });
    }
  }
  return uses;
}

export function validateForeshadowPairs(blockScript: string): ScriptCheckIssue[] {
  const uses = extractForeshadowUses(blockScript);
  const byId = new Map<string, ForeshadowUse[]>();
  for (const use of uses) byId.set(use.id, [...(byId.get(use.id) ?? []), use]);
  const issues: ScriptCheckIssue[] = [];
  for (const [id, idUses] of byId) {
    const hasPlant = idUses.some((use) => use.kind === "plant");
    const hasPayoff = idUses.some((use) => use.kind === "payoff");
    if (hasPlant && hasPayoff && !idUses.some((use) => use.kind === "unknown")) continue;
    const missing = !hasPlant && !hasPayoff
      ? "植込/回収の役割"
      : !hasPlant
        ? "植込"
        : !hasPayoff
          ? "回収"
          : "植込/回収の明記";
    issues.push({
      code: "foreshadow-pair",
      severity: "warning",
      location: id,
      message: `${id} の${missing}が見つかりません。植込と回収を同じF番号で対応させてください。`,
    });
  }
  return issues;
}

export function validateBlockScript(
  raw: string,
  blocks: FilmBlock[],
  serviceMaxSeconds = 25,
): ScriptCheckIssue[] {
  return [
    ...validateBlockDurationLimit(blocks, serviceMaxSeconds),
    ...validateBlockSequence(blocks),
    ...validateForeshadowPairs(raw),
  ];
}
