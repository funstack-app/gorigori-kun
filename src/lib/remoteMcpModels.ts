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

export type RemoteMcpModelKind = RemoteMcpToolKind;
export type RemoteMcpCatalogSource = "catalog" | "cache" | "enum" | "standard";
export type RemoteMcpSpecStatus = "supported" | "unsupported" | "unknown";
export type RemoteMcpReferenceType = "image" | "video" | "motion";

export type RemoteMcpVideoSpecs = {
  startEndImages: RemoteMcpSpecStatus;
  /** null は未取得、空配列は schema 上で参照欄なし。 */
  referenceTypes: RemoteMcpReferenceType[] | null;
  referenceLimit: number | null;
  duration: string | null;
  aspectRatios: string[] | null;
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
    if (model) into.push(model);
  }
  for (const key of ["models", "data", "results", "items"]) {
    if (record[key] !== undefined) collectModelValues(record[key], into, true);
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

  const duration =
    formatDurationValue(
      deepMetadataValue(model.metadata, [
        "durations",
        "durationOptions",
        "supportedDurations",
        "duration",
      ]),
    ) ?? durationFromSchema(parsed.fields);
  const aspectRatios =
    stringList(
      deepMetadataValue(model.metadata, [
        "aspectRatios",
        "supportedAspectRatios",
        "ratios",
      ]),
    ) ?? aspectRatiosFromSchema(parsed.fields);

  return { startEndImages, referenceTypes, referenceLimit, duration, aspectRatios };
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
  const name = normalized(toolName);
  if (/\bvideo\b/.test(name)) return "video";
  if (/\bimage\b/.test(name)) return "image";
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
    warning: input.warning,
  };
}

/** 一覧ツール→enum→標準1件の順で、1プロバイダ分のモデル一覧を取得する。 */
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
    return buildRemoteMcpModelCatalog({
      ...input,
      catalogOutput: output,
      catalogToolName: listTool.name,
    });
  } catch (error) {
    return buildRemoteMcpModelCatalog({
      ...input,
      catalogToolName: listTool.name,
      warning: String(error),
    });
  }
}
