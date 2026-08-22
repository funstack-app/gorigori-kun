import {
  remoteMcp,
  type RemoteMcpDiscoveredModel,
  type RemoteMcpQueryResult,
  type RemoteMcpToolInfo,
} from "./ipc";
import {
  classifyRemoteMcpTool,
  type RemoteMcpToolKind,
  type RemoteMcpToolLike,
} from "./remoteMcpTools";
import type { VideoDurationConstraint } from "./videoModels";

export type RemoteMcpModelKind = RemoteMcpToolKind;
export type RemoteMcpCatalogSource =
  | "catalog"
  | "cache"
  | "enum"
  | "standard"
  | "unavailable";
export type RemoteMcpSpecStatus = "supported" | "unsupported" | "unknown";
export type RemoteMcpReferenceType = "image" | "video" | "motion";

export type RemoteMcpVideoSpecs = {
  startEndImages: RemoteMcpSpecStatus;
  /** null は未取得、空配列は schema 上で参照欄なし。 */
  referenceTypes: RemoteMcpReferenceType[] | null;
  referenceLimit: number | null;
  duration: string | null;
  durationConstraint: VideoDurationConstraint | null;
  aspectRatios: string[] | null;
  modes: string[] | null;
  audio: RemoteMcpSpecStatus;
  multiCut: RemoteMcpSpecStatus;
};

export type RemoteMcpCatalogModel = {
  id: string;
  name: string;
  label?: string;
  kind: RemoteMcpModelKind;
  /** 標準1件のフォールバックは偽の model 値を送らない。 */
  passModel: boolean;
  metadata?: Record<string, unknown>;
  videoSpecs?: RemoteMcpVideoSpecs;
};

export type RemoteMcpModelCatalog = {
  providerId: string;
  providerLabel: string;
  kind: Exclude<RemoteMcpModelKind, "other">;
  source: RemoteMcpCatalogSource;
  sourceToolName?: string;
  generationTool: RemoteMcpToolInfo | null;
  models: RemoteMcpCatalogModel[];
  /** 一覧ツールが失敗して enum/cache/標準へ退避した場合だけ保持する。 */
  warning?: string;
};

type BuildCatalogInput = {
  providerId: string;
  providerLabel: string;
  kind: "image" | "video";
  tools: readonly RemoteMcpToolInfo[];
  catalogOutput?: RemoteMcpQueryResult | null;
  catalogToolName?: string;
  cachedModels?: readonly RemoteMcpDiscoveredModel[];
  warning?: string;
  /** 一覧ツールが存在する接続先では、読めない応答を標準1件へ置き換えない。 */
  requireExplicitModels?: boolean;
};

function normalized(value: unknown): string {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .trim();
}

function compactName(value: string): string {
  return normalized(value).replace(/[^a-z0-9]/g, "");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 課金を伴わないモデル一覧ツールだけを、名前から決定論的に1つ選ぶ。 */
export function findRemoteMcpModelListTool<T extends RemoteMcpToolLike>(
  tools: readonly T[],
  kind?: "image" | "video",
): T | null {
  const scored = tools
    .map((tool, index) => {
      const name = compactName(tool.name);
      let score = 0;
      if (name === "listmodels") score = 100;
      else if (name === "getmodels") score = 95;
      else if (name === "models") score = 90;
      else if (name.endsWith("modelslist")) score = 85;
      else if (name === "modelsexplore" || name.endsWith("modelsexplore")) score = 80;
      if (score > 0 && kind && normalized(tool.name).includes(kind)) score += 30;
      return { tool, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.tool ?? null;
}

function generationToolScore(tool: RemoteMcpToolLike, kind: "image" | "video"): number {
  if (classifyRemoteMcpTool(tool) !== kind) return -1;
  const name = compactName(tool.name);
  const exact = kind === "image" ? ["generateimage", "imagegenerate"] : ["generatevideo", "videogenerate"];
  if (exact.includes(name)) return 100;
  if (name === `textto${kind}`) return 95;
  if (kind === "video" && name === "imagetovideo") return 92;
  if (name === `create${kind}` || name === `${kind}create`) return 88;
  if (name.includes(`generate${kind}`) || name.includes(`${kind}generate`)) return 82;
  if (name.includes(kind)) return 70;
  return 50;
}

/** モデル選択後に裏で使う「主生成ツール」を1つだけ選ぶ。 */
export function selectPrimaryRemoteMcpGenerationTool<T extends RemoteMcpToolLike>(
  tools: readonly T[],
  kind: "image" | "video",
): T | null {
  const scored = tools
    .map((tool, index) => ({ tool, index, score: generationToolScore(tool, kind) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.tool ?? null;
}

function explicitKind(metadata: Record<string, unknown>): RemoteMcpModelKind | null {
  const keys = new Set([
    "type",
    "mediatype",
    "modality",
    "outputtype",
    "generationtype",
    "kind",
  ]);
  const values: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    const record = objectRecord(value);
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      if (keys.has(compactName(key))) values.push(nested);
      if (objectRecord(nested)) visit(nested, depth + 1);
    }
  };
  visit(metadata, 0);
  const text = normalized(values.flatMap((value) => (Array.isArray(value) ? value : [value])).join(" "));
  if (!text) return null;
  if (/\b(image|text|prompt)\s*to\s*video\b|\b(video|movie|clip)\b/.test(text)) return "video";
  if (/\b(text|prompt)\s*to\s*image\b|\b(image|picture|photo)\b/.test(text)) return "image";
  return null;
}

/** type系メタデータを優先し、無い場合だけ id/name から媒体を分類する。 */
export function classifyRemoteMcpModel(
  model: Pick<RemoteMcpCatalogModel, "id" | "name" | "label" | "metadata">,
): RemoteMcpModelKind {
  const fromMetadata = model.metadata ? explicitKind(model.metadata) : null;
  if (fromMetadata) return fromMetadata;

  const text = normalized(`${model.id} ${model.name} ${model.label ?? ""}`);
  if (/\b(image|text|prompt)\s*to\s*video\b/.test(text)) return "video";
  if (/\b(text|prompt)\s*to\s*image\b/.test(text)) return "image";

  const video = /\b(video|veo|seedance|kling|runway|hailuo|minimax|wan|ltx|pika|ray|motion|movie|clip)\b/.test(
    text,
  );
  const image = /\b(image|imagen|flux|ideogram|seedream|recraft|sdxl|stable diffusion|nano banana|gpt image|photo)\b/.test(
    text,
  );
  if (video && !image) return "video";
  if (image && !video) return "image";
  return "other";
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstScalar(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = scalarString(record[key]);
    if (value) return value;
  }
  return null;
}

function modelFromValue(value: unknown): RemoteMcpCatalogModel | null {
  const scalar = scalarString(value);
  if (scalar) {
    return { id: scalar, name: scalar, kind: "other", passModel: true };
  }
  const record = objectRecord(value);
  if (!record) return null;
  const id = firstScalar(record, [
    "id",
    "modelId",
    "model_id",
    "slug",
    "value",
    "name",
    "displayName",
    "display_name",
    "label",
  ]);
  const name = firstScalar(record, [
    "name",
    "displayName",
    "display_name",
    "label",
    "title",
    "id",
    "modelId",
    "model_id",
    "slug",
    "value",
  ]);
  if (!id && !name) return null;
  const model: RemoteMcpCatalogModel = {
    id: id ?? name!,
    name: name ?? id!,
    label: firstScalar(record, ["label", "displayName", "display_name", "title"]) ?? undefined,
    kind: "other",
    passModel: true,
    metadata: record,
  };
  model.kind = classifyRemoteMcpModel(model);
  return model;
}

const MODEL_COLLECTION_KEYS = new Set([
  "models",
  "videomodels",
  "imagemodels",
  "availablemodels",
  "modellist",
  "data",
  "results",
  "items",
]);
const MODEL_WRAPPER_KEYS = new Set(["result", "output", "response", "catalog", "payload"]);

function modelFromKeyedValue(key: string, value: unknown): RemoteMcpCatalogModel | null {
  const record = objectRecord(value);
  if (record) return modelFromValue({ id: key, ...record });
  const name = scalarString(value);
  if (!name) return null;
  return modelFromValue({ id: key, name });
}

function collectModelValues(value: unknown, into: RemoteMcpCatalogModel[], inCollection = false) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const model = modelFromValue(item);
      if (model) into.push(model);
      else collectModelValues(item, into, true);
    }
    return;
  }
  const record = objectRecord(value);
  if (!record) return;
  if (inCollection) {
    const model = modelFromValue(record);
    if (model) {
      into.push(model);
      return;
    }
    // { models: { "kling-3": { name: "Kling 3" } } } のような slug キー形式。
    for (const [key, nested] of Object.entries(record)) {
      if (MODEL_COLLECTION_KEYS.has(compactName(key))) continue;
      const keyedModel = modelFromKeyedValue(key, nested);
      if (keyedModel) into.push(keyedModel);
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    if (MODEL_COLLECTION_KEYS.has(compactName(key))) collectModelValues(nested, into, true);
    else if (MODEL_WRAPPER_KEYS.has(compactName(key))) collectModelValues(nested, into, false);
  }
}

function parseTextJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function unquoteMarkdown(value: string): string {
  return value
    .trim()
    .replace(/^[`*_"']+|[`*_"']+$/g, "")
    .trim();
}

function markdownTextModels(text: string): RemoteMcpCatalogModel[] {
  const models: RemoteMcpCatalogModel[] = [];
  const lines = text.split(/\r?\n/);
  let tableIdIndex = -1;
  let tableNameIndex = -1;
  let pendingYaml: Record<string, unknown> | null = null;
  const flushYaml = () => {
    if (!pendingYaml) return;
    const model = modelFromValue(pendingYaml);
    if (model) models.push(model);
    pendingYaml = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushYaml();
      continue;
    }

    const yamlField = line.match(/^[-*]?\s*(id|model[_ -]?id|slug|name|label|display[_ -]?name)\s*:\s*(.+)$/i);
    if (yamlField) {
      const key = compactName(yamlField[1]);
      if ((key === "id" || key === "modelid" || key === "slug") && pendingYaml?.id) {
        flushYaml();
      }
      pendingYaml ??= {};
      const value = unquoteMarkdown(yamlField[2]);
      if (key === "id" || key === "modelid" || key === "slug") pendingYaml.id = value;
      else if (key === "label" || key === "displayname") pendingYaml.label = value;
      else pendingYaml.name = value;
      continue;
    }
    flushYaml();

    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map(unquoteMarkdown);
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      const normalizedCells = cells.map(compactName);
      const nextIdIndex = normalizedCells.findIndex((cell) =>
        ["id", "modelid", "slug", "model"].includes(cell),
      );
      const nextNameIndex = normalizedCells.findIndex((cell) =>
        ["name", "label", "displayname", "modelname"].includes(cell),
      );
      if (nextIdIndex >= 0) {
        tableIdIndex = nextIdIndex;
        tableNameIndex = nextNameIndex;
        continue;
      }
      if (tableIdIndex >= 0 && cells[tableIdIndex]) {
        const model = modelFromValue({
          id: cells[tableIdIndex],
          name: cells[tableNameIndex >= 0 ? tableNameIndex : tableIdIndex],
        });
        if (model) models.push(model);
      }
      continue;
    }

    // Magnific を含む MCP 一覧でよく使われる Markdown 箇条書き:
    // - **Kling 3.0** (`kling-3.0`) / - `kling-3.0` — Kling 3.0
    if (!/^[-*+]\s+/.test(line)) continue;
    const codeValues = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
    const id = codeValues.find((value) => /^[a-z0-9][a-z0-9._/-]{1,100}$/i.test(value));
    if (!id) continue;
    const bold = line.match(/\*\*([^*]+)\*\*/)?.[1]?.trim();
    const afterCode = line
      .replace(/^[-*+]\s+/, "")
      .replace(/`[^`]+`/, "")
      .replace(/^[\s:()\[\]—–-]+|[\s:()\[\]—–-]+$/g, "")
      .trim();
    const model = modelFromValue({ id, name: bold || afterCode || id, label: bold || undefined });
    if (model) models.push(model);
  }
  flushYaml();
  return models;
}

export function extractRemoteMcpCatalogModels(
  output: Pick<RemoteMcpQueryResult, "contentText" | "structuredContent">,
  hintedKind?: "image" | "video",
): RemoteMcpCatalogModel[] {
  const models: RemoteMcpCatalogModel[] = [];
  if (output.structuredContent !== undefined && output.structuredContent !== null) {
    collectModelValues(output.structuredContent, models);
  }
  const textJson = parseTextJson(output.contentText);
  if (textJson !== null) collectModelValues(textJson, models);
  else models.push(...markdownTextModels(output.contentText));

  const unique = new Map<string, RemoteMcpCatalogModel>();
  for (const model of models) {
    if (model.kind === "other" && hintedKind) model.kind = hintedKind;
    const key = `${model.id}\u0000${model.name}`;
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()];
}

type SchemaField = { name: string; normalizedName: string; property: Record<string, unknown> };

function schemaFields(schemaJson: string): { valid: boolean; fields: SchemaField[] } {
  if (!schemaJson.trim()) return { valid: false, fields: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch {
    return { valid: false, fields: [] };
  }
  const root = objectRecord(parsed);
  if (!root) return { valid: false, fields: [] };
  const fields: SchemaField[] = [];
  const visit = (schema: Record<string, unknown>, depth: number) => {
    if (depth > 4) return;
    const properties = objectRecord(schema.properties);
    if (!properties) return;
    for (const [name, propertyValue] of Object.entries(properties)) {
      const property = objectRecord(propertyValue);
      if (!property) continue;
      fields.push({ name, normalizedName: compactName(name), property });
      visit(property, depth + 1);
      const items = objectRecord(property.items);
      if (items) visit(items, depth + 1);
    }
  };
  visit(root, 0);
  return { valid: true, fields };
}

function deepMetadataValue(metadata: Record<string, unknown> | undefined, keys: readonly string[]) {
  if (!metadata) return undefined;
  const wanted = new Set(keys.map(compactName));
  let found: unknown;
  const visit = (value: unknown, depth: number) => {
    if (found !== undefined || depth > 5) return;
    const record = objectRecord(value);
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      if (wanted.has(compactName(key))) {
        found = nested;
        return;
      }
      if (objectRecord(nested)) visit(nested, depth + 1);
    }
  };
  visit(metadata, 0);
  return found;
}

function booleanMetadata(metadata: Record<string, unknown> | undefined, keys: readonly string[]) {
  const value = deepMetadataValue(metadata, keys);
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] | null {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,|]/) : [];
  const clean = values.map(scalarString).filter((item): item is string => Boolean(item));
  return clean.length > 0 ? [...new Set(clean)] : null;
}

function referenceTypesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): RemoteMcpReferenceType[] | null {
  const value = deepMetadataValue(metadata, [
    "referenceTypes",
    "supportedReferenceTypes",
    "referenceInputs",
  ]);
  const list = stringList(value);
  if (!list) return null;
  const text = normalized(list.join(" "));
  const result: RemoteMcpReferenceType[] = [];
  if (/\b(image|photo|frame|keyframe)\b/.test(text)) result.push("image");
  if (/\b(video|clip)\b/.test(text)) result.push("video");
  if (/\bmotion\b/.test(text)) result.push("motion");
  return result;
}

function referenceLimitFromMetadata(metadata: Record<string, unknown> | undefined): number | null {
  const value = deepMetadataValue(metadata, [
    "referenceLimit",
    "maxReferences",
    "maximumReferences",
    "maxReferenceCount",
  ]);
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatDurationValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const clean = value.map(scalarString).filter((item): item is string => Boolean(item));
    return clean.length > 0 ? clean.map((item) => (/秒|s$/i.test(item) ? item : `${item}秒`)).join(" / ") : null;
  }
  const scalar = scalarString(value);
  if (!scalar) return null;
  return /秒|s$|sec/i.test(scalar) ? scalar : `${scalar}秒`;
}

function numericList(value: unknown): number[] | null {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,|/]/)
      : [value];
  const numbers = source
    .map((item) => {
      if (typeof item === "number") return item;
      const match = scalarString(item)?.match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : Number.NaN;
    })
    .filter((item) => Number.isFinite(item));
  return numbers.length > 0 ? [...new Set(numbers)].sort((a, b) => a - b) : null;
}

function durationConstraintFromValue(value: unknown): VideoDurationConstraint | null {
  const record = objectRecord(value);
  if (record) {
    const values = numericList(record.values ?? record.options ?? record.enum);
    if (values) {
      const requestedDefault = numericList(record.default)?.[0];
      return {
        kind: "enum",
        values,
        default: requestedDefault && values.includes(requestedDefault) ? requestedDefault : values[0],
      };
    }
    const minimum = numericList(record.min ?? record.minimum)?.[0];
    const maximum = numericList(record.max ?? record.maximum)?.[0];
    if (minimum !== undefined && maximum !== undefined) {
      const step = numericList(record.step ?? record.multipleOf)?.[0] ?? 1;
      const requestedDefault = numericList(record.default)?.[0];
      return {
        kind: "integer",
        min: minimum,
        max: maximum,
        step,
        default:
          requestedDefault !== undefined && requestedDefault >= minimum && requestedDefault <= maximum
            ? requestedDefault
            : minimum,
      };
    }
  }
  if (typeof value === "string") {
    const range = value.match(/(\d+(?:\.\d+)?)\s*(?:-|〜|~|to)\s*(\d+(?:\.\d+)?)/i);
    if (range) {
      const min = Number(range[1]);
      const max = Number(range[2]);
      if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
        return { kind: "integer", min, max, step: 1, default: min };
      }
    }
  }
  const values = numericList(value);
  return values
    ? { kind: "enum", values, default: values[0] }
    : null;
}

function durationConstraintFromSchema(fields: SchemaField[]): VideoDurationConstraint | null {
  const field = fields.find(({ normalizedName }) =>
    ["duration", "durationseconds", "seconds", "lengthseconds"].includes(normalizedName),
  );
  if (!field) return null;
  const values = numericList(field.property.enum);
  if (values) {
    const requestedDefault = numericList(field.property.default)?.[0];
    return {
      kind: "enum",
      values,
      default: requestedDefault && values.includes(requestedDefault) ? requestedDefault : values[0],
    };
  }
  const minimum = numericList(field.property.minimum)?.[0];
  const maximum = numericList(field.property.maximum)?.[0];
  if (minimum === undefined || maximum === undefined) return null;
  const step = numericList(field.property.multipleOf)?.[0] ?? 1;
  const requestedDefault = numericList(field.property.default)?.[0];
  return {
    kind: "integer",
    min: minimum,
    max: maximum,
    step,
    default:
      requestedDefault !== undefined && requestedDefault >= minimum && requestedDefault <= maximum
        ? requestedDefault
        : minimum,
  };
}

function durationConstraintLabel(constraint: VideoDurationConstraint | null): string | null {
  if (!constraint) return null;
  return constraint.kind === "enum"
    ? constraint.values.map((value) => `${value}秒`).join(" / ")
    : `${constraint.min}〜${constraint.max}秒${(constraint.step ?? 1) !== 1 ? `（${constraint.step}秒刻み）` : ""}`;
}

function durationFromSchema(fields: SchemaField[]): string | null {
  const field = fields.find(({ normalizedName }) =>
    ["duration", "durationseconds", "seconds", "lengthseconds"].includes(normalizedName),
  );
  if (!field) return null;
  const enumerated = formatDurationValue(field.property.enum);
  if (enumerated) return enumerated;
  const minimum = scalarString(field.property.minimum);
  const maximum = scalarString(field.property.maximum);
  if (minimum && maximum) return `${minimum}〜${maximum}秒`;
  return formatDurationValue(field.property.default);
}

function aspectRatiosFromSchema(fields: SchemaField[]): string[] | null {
  const field = fields.find(({ normalizedName }) =>
    ["aspect", "aspectratio", "ratio"].includes(normalizedName),
  );
  return field ? stringList(field.property.enum) : null;
}

function schemaFeatureStatus(
  parsed: { valid: boolean; fields: SchemaField[] },
  pattern: RegExp,
): RemoteMcpSpecStatus {
  if (!parsed.valid) return "unknown";
  return parsed.fields.some(({ normalizedName, property }) =>
    pattern.test(normalized(`${normalizedName} ${property.title ?? ""} ${property.description ?? ""}`)),
  )
    ? "supported"
    : "unknown";
}

function featureStatus(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
  parsed: { valid: boolean; fields: SchemaField[] },
  pattern: RegExp,
): RemoteMcpSpecStatus {
  const explicit = booleanMetadata(metadata, keys);
  if (explicit !== null) return explicit ? "supported" : "unsupported";
  return schemaFeatureStatus(parsed, pattern);
}

/** カタログのメタデータを優先し、不足分だけ生成ツール schema から読む。 */
export function deriveRemoteMcpVideoSpecs(
  model: Pick<RemoteMcpCatalogModel, "metadata">,
  generationTool: Pick<RemoteMcpToolLike, "inputSchemaJson"> | null,
): RemoteMcpVideoSpecs {
  const parsed = generationTool
    ? schemaFields(generationTool.inputSchemaJson)
    : { valid: false, fields: [] as SchemaField[] };
  const startEnd = booleanMetadata(model.metadata, [
    "supportsStartEndImages",
    "supportsStartEndFrames",
    "supportsFirstLastFrame",
  ]);
  const start = booleanMetadata(model.metadata, ["supportsStartImage", "supportsStartFrame"]);
  const end = booleanMetadata(model.metadata, ["supportsEndImage", "supportsEndFrame"]);
  const hasStart = parsed.fields.some(({ normalizedName }) =>
    /^(first|start|initial)(frame|image)/.test(normalizedName),
  );
  const hasEnd = parsed.fields.some(({ normalizedName }) =>
    /^(last|end|final)(frame|image)/.test(normalizedName),
  );
  const startEndImages: RemoteMcpSpecStatus =
    startEnd !== null
      ? startEnd
        ? "supported"
        : "unsupported"
      : start !== null || end !== null
        ? start === true && end === true
          ? "supported"
          : "unsupported"
        : parsed.valid
          ? hasStart && hasEnd
            ? "supported"
            : "unsupported"
          : "unknown";

  let referenceTypes = referenceTypesFromMetadata(model.metadata);
  if (!referenceTypes && parsed.valid) {
    const result: RemoteMcpReferenceType[] = [];
    for (const field of parsed.fields) {
      const text = normalized(
        `${field.name} ${field.property.title ?? ""} ${field.property.description ?? ""}`,
      );
      if (!/reference|keyframe|first frame|last frame|start frame|end frame/.test(text)) continue;
      if (/image|photo|frame|keyframe/.test(text) && !result.includes("image")) result.push("image");
      if (/video|clip/.test(text) && !result.includes("video")) result.push("video");
      if (/motion/.test(text) && !result.includes("motion")) result.push("motion");
    }
    referenceTypes = result;
  }

  let referenceLimit = referenceLimitFromMetadata(model.metadata);
  if (referenceLimit === null && parsed.valid) {
    const limits = parsed.fields
      .filter(({ name, property }) => /reference|keyframe/i.test(`${name} ${property.description ?? ""}`))
      .map(({ property }) => Number(property.maxItems))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (limits.length > 0) referenceLimit = Math.max(...limits);
  }

  const durationMetadata = deepMetadataValue(model.metadata, [
    "durations",
    "durationOptions",
    "supportedDurations",
    "duration",
  ]);
  const durationConstraint =
    durationConstraintFromValue(durationMetadata) ?? durationConstraintFromSchema(parsed.fields);
  const duration =
    durationConstraintLabel(durationConstraint) ??
    formatDurationValue(durationMetadata) ??
    durationFromSchema(parsed.fields);
  const aspectRatios =
    stringList(
      deepMetadataValue(model.metadata, [
        "aspectRatios",
        "supportedAspectRatios",
        "ratios",
      ]),
    ) ?? aspectRatiosFromSchema(parsed.fields);

  const modes =
    stringList(
      deepMetadataValue(model.metadata, ["modes", "supportedModes", "generationModes"]),
    ) ??
    (() => {
      const field = parsed.fields.find(({ normalizedName }) =>
        ["generationmode", "qualitymode"].includes(normalizedName),
      );
      return field ? stringList(field.property.enum) : null;
    })();
  const audio = featureStatus(
    model.metadata,
    ["supportsAudio", "supportsSound", "nativeAudio", "audioGeneration"],
    parsed,
    /\b(audio|sound|native audio)\b/,
  );
  const multiCut = featureStatus(
    model.metadata,
    ["supportsMultiCut", "supportsMultishot", "multiCut", "multiShot"],
    parsed,
    /\b(multi cut|multicut|multi shot|multishot|shot count)\b/,
  );

  return {
    startEndImages,
    referenceTypes,
    referenceLimit,
    duration,
    durationConstraint,
    aspectRatios,
    modes,
    audio,
    multiCut,
  };
}

function modelEnumFromTool(tool: RemoteMcpToolInfo | null): RemoteMcpCatalogModel[] {
  if (!tool) return [];
  const { fields } = schemaFields(tool.inputSchemaJson);
  const field = fields.find(({ normalizedName }) =>
    ["model", "modelid", "modelname", "mode"].includes(normalizedName),
  );
  if (!field) return [];
  const values = Array.isArray(field.property.enum) ? field.property.enum : [];
  return values
    .map(modelFromValue)
    .filter((model): model is RemoteMcpCatalogModel => Boolean(model));
}

function hintedKindFromToolName(toolName: string | undefined): "image" | "video" | undefined {
  // MCP のツール名は video_models_list のように `_` 区切りが多い。
  // `_` は正規表現上の単語文字なので \b では区切れず、該当媒体を見失っていた。
  const name = compactName(toolName ?? "");
  if (name.includes("video")) return "video";
  if (name.includes("image")) return "image";
  return undefined;
}

export function remoteMcpCatalogKey(providerId: string, kind: "image" | "video") {
  return `${providerId}:${kind}`;
}

export function buildRemoteMcpModelCatalog(input: BuildCatalogInput): RemoteMcpModelCatalog {
  const generationTool = selectPrimaryRemoteMcpGenerationTool(input.tools, input.kind);
  let source: RemoteMcpCatalogSource = "catalog";
  let models = input.catalogOutput
    ? extractRemoteMcpCatalogModels(
        input.catalogOutput,
        hintedKindFromToolName(input.catalogToolName),
      )
    : [];

  if (models.filter((model) => model.kind === input.kind).length === 0 && input.cachedModels?.length) {
    models = input.cachedModels.map((model) => {
      const next: RemoteMcpCatalogModel = { ...model, kind: "other", passModel: true };
      next.kind = classifyRemoteMcpModel(next);
      return next;
    });
    source = "cache";
  }
  if (models.filter((model) => model.kind === input.kind).length === 0) {
    models = modelEnumFromTool(generationTool);
    models.forEach((model) => {
      if (model.kind === "other") model.kind = input.kind;
    });
    source = "enum";
  }

  models = models.filter((model) => model.kind === input.kind);
  if (models.length === 0) {
    if (input.requireExplicitModels) {
      source = "unavailable";
    } else {
      source = "standard";
      models = [
        {
          id: `${input.providerId}-standard`,
          name: `${input.providerLabel} 標準`,
          kind: input.kind,
          passModel: false,
        },
      ];
    }
  }

  const unique = new Map<string, RemoteMcpCatalogModel>();
  for (const model of models) {
    if (input.kind === "video") {
      model.videoSpecs = deriveRemoteMcpVideoSpecs(model, generationTool);
    }
    if (!unique.has(model.id)) unique.set(model.id, model);
  }

  return {
    providerId: input.providerId,
    providerLabel: input.providerLabel,
    kind: input.kind,
    source,
    sourceToolName: input.catalogToolName,
    generationTool,
    models: [...unique.values()],
    warning:
      input.warning ??
      (source === "unavailable"
        ? "モデル一覧の応答から実モデルを読み取れませんでした。"
        : undefined),
  };
}

/** 一覧ツール→cache→enum の順で取得。一覧ツール自体が無い時だけ標準1件へ退避する。 */
export async function fetchRemoteMcpModelCatalog(
  input: Omit<BuildCatalogInput, "catalogOutput" | "catalogToolName" | "warning">,
): Promise<RemoteMcpModelCatalog> {
  const listTool = findRemoteMcpModelListTool(input.tools, input.kind);
  if (!listTool) return buildRemoteMcpModelCatalog(input);

  try {
    const output = await remoteMcp.query({
      providerId: input.providerId,
      toolName: listTool.name,
      paramsJson: "{}",
    });
    const catalog = buildRemoteMcpModelCatalog({
      ...input,
      catalogOutput: output,
      catalogToolName: listTool.name,
      requireExplicitModels: true,
    });
    if (catalog.source === "unavailable") {
      throw new Error(catalog.warning);
    }
    return catalog;
  } catch (error) {
    throw new Error(`モデル一覧を取得できませんでした: ${String(error)}`);
  }
}
