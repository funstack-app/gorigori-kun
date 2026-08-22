import type {
  AssetLedgerEntry,
  AssetType,
  ForeshadowEntry,
} from "./types";

export type AssetParseFailure = {
  ok: false;
  error: {
    line: number;
    column: number;
    reason: string;
    sourceLine: string;
  };
};

export type AssetParseSuccess = { ok: true; value: AssetLedgerEntry[] };
export type AssetParseResult = AssetParseSuccess | AssetParseFailure;

export type AssetCheckCode =
  | "duplicate-id"
  | "type-prefix-mismatch"
  | "unknown-block";

export type AssetCheckIssue = {
  code: AssetCheckCode;
  severity: "blocking";
  message: string;
  location: string;
};

export const ASSET_TYPE_PREFIX: Record<AssetType, string> = {
  character: "CH",
  location: "LO",
  prop: "PR",
  text: "TX",
};

const TYPE_FROM_LABEL: Record<string, AssetType> = {
  キャラ: "character",
  ロケ: "location",
  小道具: "prop",
  文字物: "text",
};

const IMPORTANCE_FROM_LABEL = {
  主要: "primary",
  準: "supporting",
  背景: "background",
} as const;

const REQUIRED_HEADER = ["ID", "名称", "種別", "重要度", "登場ブロック"];

function failure(
  lines: string[],
  lineIndex: number,
  reason: string,
  column = 1,
): AssetParseFailure {
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

function tableCells(sourceLine: string): { cells: string[]; columns: number[] } | null {
  const trimmed = sourceLine.trim();
  if (!trimmed.startsWith("|")) return null;
  const body = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  const rawCells = body.split("|");
  const cells = rawCells.map((cell) => cell.trim());
  const columns: number[] = [];
  let searchFrom = 0;
  for (let index = 0; index < rawCells.length; index += 1) {
    const rawCell = rawCells[index];
    const value = cells[index];
    const rawIndex = sourceLine.indexOf(rawCell, searchFrom);
    const leading = rawCell.length - rawCell.trimStart().length;
    columns.push(Math.max(1, rawIndex + leading + 1));
    searchFrom = Math.max(searchFrom, rawIndex + rawCell.length + 1);
    if (!value) columns[index] = Math.max(1, rawIndex + 1);
  }
  return { cells, columns };
}

/** AIに強制した5列Markdown表を、編集可能なアセット台帳へ変換する。 */
export function parseAssetLedgerResponse(raw: string): AssetParseResult {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const nonEmpty = lines
    .map((sourceLine, lineIndex) => ({ sourceLine, lineIndex }))
    .filter(({ sourceLine }) => sourceLine.trim().length > 0);

  if (nonEmpty.length === 0) return failure(lines, 0, "アセット表が空です");
  if (nonEmpty.length < 3) {
    return failure(lines, nonEmpty[nonEmpty.length - 1]?.lineIndex ?? 0, "表の見出し・区切り・アセット行が必要です");
  }

  const header = tableCells(nonEmpty[0].sourceLine);
  if (!header) {
    return failure(lines, nonEmpty[0].lineIndex, "説明文を付けず、Markdown表だけを返してください");
  }
  if (
    header.cells.length !== REQUIRED_HEADER.length ||
    header.cells.some((cell, index) => cell !== REQUIRED_HEADER[index])
  ) {
    return failure(
      lines,
      nonEmpty[0].lineIndex,
      `見出しは「${REQUIRED_HEADER.join("・")}」の5列にしてください`,
    );
  }

  const separator = tableCells(nonEmpty[1].sourceLine);
  if (
    !separator ||
    separator.cells.length !== REQUIRED_HEADER.length ||
    !separator.cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
  ) {
    return failure(lines, nonEmpty[1].lineIndex, "見出しの次に5列の区切り行を置いてください");
  }

  const assets: AssetLedgerEntry[] = [];
  for (const { sourceLine, lineIndex } of nonEmpty.slice(2)) {
    const row = tableCells(sourceLine);
    if (!row) return failure(lines, lineIndex, "アセット行は | で区切った表にしてください");
    if (row.cells.length !== REQUIRED_HEADER.length) {
      return failure(lines, lineIndex, "アセット行は5列にしてください");
    }

    const [id, name, typeLabel, importanceLabel, blockList] = row.cells;
    if (!/^(?:CH|LO|PR|TX)-\d{2,}$/u.test(id)) {
      return failure(
        lines,
        lineIndex,
        "IDは CH-01 / LO-01 / PR-01 / TX-01 の形にしてください",
        row.columns[0],
      );
    }
    if (!name) {
      return failure(lines, lineIndex, "名称を空欄にできません", row.columns[1]);
    }
    const type = TYPE_FROM_LABEL[typeLabel];
    if (!type) {
      return failure(
        lines,
        lineIndex,
        "種別はキャラ / ロケ / 文字物 / 小道具のどれかにしてください",
        row.columns[2],
      );
    }
    const importance = IMPORTANCE_FROM_LABEL[
      importanceLabel as keyof typeof IMPORTANCE_FROM_LABEL
    ];
    if (!importance) {
      return failure(
        lines,
        lineIndex,
        "重要度は主要 / 準 / 背景のどれかにしてください",
        row.columns[3],
      );
    }
    const blockIds = blockList
      .split(/[,\u3001／/\s]+/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (blockIds.length === 0 || blockIds.some((blockId) => !/^B\d+$/u.test(blockId))) {
      return failure(
        lines,
        lineIndex,
        "登場ブロックは B1, B2 の形で並べてください",
        row.columns[4],
      );
    }

    assets.push({
      id,
      name,
      type,
      importance,
      blockIds: [...new Set(blockIds)],
      status: "unplanned",
      pairKey: null,
      pairSide: null,
    });
  }

  if (assets.length === 0) return failure(lines, nonEmpty[1].lineIndex, "アセット行が1件もありません");
  return { ok: true, value: assets };
}

/** ID・種別・実在ブロックの3本の機械柵。 */
export function validateAssetLedger(
  assets: AssetLedgerEntry[],
  existingBlockIds: string[],
): AssetCheckIssue[] {
  const issues: AssetCheckIssue[] = [];
  const counts = new Map<string, number>();
  const existing = new Set(existingBlockIds);

  for (const asset of assets) counts.set(asset.id, (counts.get(asset.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      issues.push({
        code: "duplicate-id",
        severity: "blocking",
        location: id,
        message: `${id} が${count}件あります。IDは1つだけにしてください。`,
      });
    }
  }

  for (const asset of assets) {
    const expectedPrefix = ASSET_TYPE_PREFIX[asset.type];
    if (!asset.id.startsWith(`${expectedPrefix}-`)) {
      issues.push({
        code: "type-prefix-mismatch",
        severity: "blocking",
        location: asset.id,
        message: `${asset.id} の種別とIDが合っていません。${asset.type}のIDは ${expectedPrefix}- から始めます。`,
      });
    }
    for (const blockId of asset.blockIds) {
      if (existing.has(blockId)) continue;
      issues.push({
        code: "unknown-block",
        severity: "blocking",
        location: `${asset.id}:${blockId}`,
        message: `${asset.id} の登場先 ${blockId} は、承認済みブロック脚本にありません。`,
      });
    }
  }
  return issues;
}

export function nextAssetId(assets: AssetLedgerEntry[], type: AssetType): string {
  const prefix = ASSET_TYPE_PREFIX[type];
  const highest = assets.reduce((max, asset) => {
    const match = asset.id.match(new RegExp(`^${prefix}-(\\d+)$`, "u"));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(2, "0")}`;
}

/** S2のブロック脚本にあるF番号を、S3の編集可能台帳の初期値へする。 */
export function extractForeshadowLedger(blockScript: string): ForeshadowEntry[] {
  const entries = new Map<string, ForeshadowEntry>();
  let currentBlockId = "";

  for (const line of blockScript.replace(/\r\n?/g, "\n").split("\n")) {
    const blockMatch = line.match(/^###\s+(B\d+)\b/u);
    if (blockMatch) currentBlockId = blockMatch[1];
    const fieldMatch = line.match(/^-\s*伏線\s*[:：]\s*(.+)$/u);
    if (!fieldMatch || /^(?:なし|無し)$/u.test(fieldMatch[1].trim())) continue;

    const value = fieldMatch[1];
    const matches = [...value.matchAll(/\b(F\d+)\b/giu)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const id = match[1].toUpperCase();
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? value.length;
      const context = value.slice(start, end).trim();
      const isPlant = /(?:植込|植え込み|植える|plant)/iu.test(context);
      const isPayoff = /(?:回収|payoff|pay-off)/iu.test(context);
      const meaning = context
        .replace(/\bF\d+\b/giu, "")
        .replace(/(?:植込|植え込み|植える|回収|plant|payoff|pay-off)/giu, "")
        .replace(/^[\s:：,、\-/]+|[\s:：,、\-/]+$/gu, "")
        .trim();
      const current = entries.get(id) ?? {
        id,
        description: meaning || id,
        initialMeaning: "",
        trueMeaning: "",
        plantedInBlockId: "",
        paidOffInBlockId: "",
      };
      if (meaning && current.description === id) current.description = meaning;
      if (isPlant) {
        current.plantedInBlockId ||= currentBlockId;
        current.initialMeaning ||= meaning;
      }
      if (isPayoff) {
        current.paidOffInBlockId ||= currentBlockId;
        current.trueMeaning ||= meaning;
      }
      entries.set(id, current);
    }
  }

  return [...entries.values()].sort((left, right) => {
    const leftNumber = Number(left.id.slice(1));
    const rightNumber = Number(right.id.slice(1));
    return leftNumber - rightNumber;
  });
}
