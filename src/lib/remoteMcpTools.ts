export type RemoteMcpToolKind = "image" | "video" | "other";

export type RemoteMcpToolLike = {
  name: string;
  title?: string;
  description?: string;
  inputSchemaJson: string;
};

export type RemoteMcpToolGroups<T extends RemoteMcpToolLike = RemoteMcpToolLike> = {
  image: T[];
  video: T[];
  other: T[];
};

export type RemoteMcpParamInput = {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  count?: number;
};

export type BuildRemoteMcpParamsResult = {
  paramsJson: string;
  params: Record<string, unknown>;
  /** JSON Schema の required にあるが、既知の入力から埋められなかった項目。 */
  missingRequired: string[];
  /** inputSchemaJson 自体が読めないときだけ入る。読めないまま送信しないための柵。 */
  schemaError?: string;
};

type JsonSchemaProperty = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  readOnly?: boolean;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: unknown;
};

const ACTION_PATTERN = /\b(generate|create|render|synthesi[sz]e|make)\b/;
const IMAGE_PATTERN = /\b(image|images|picture|pictures|photo|photos|img)\b|\b(txt2img|t2i)\b/;
const VIDEO_PATTERN = /\b(video|videos|movie|movies|clip|clips)\b|\b(txt2video|t2v|i2v)\b/;
const TO_IMAGE_PATTERN = /\b(text|prompt)[\s_-]*to[\s_-]*(image|picture|photo)\b/;
const TO_VIDEO_PATTERN = /\b(text|prompt|image|photo)[\s_-]*to[\s_-]*(video|movie|clip)\b/;

function searchable(value: unknown): string {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

function parseSchema(schemaJson: string): { schema: JsonSchema | null; error?: string } {
  try {
    const parsed = JSON.parse(schemaJson || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { schema: null, error: "ツールの入力形式がJSONオブジェクトではありません。" };
    }
    return { schema: parsed as JsonSchema };
  } catch {
    return { schema: null, error: "ツールの入力形式を読み取れませんでした。" };
  }
}

function schemaSearchText(schemaJson: string): string {
  const { schema } = parseSchema(schemaJson);
  if (!schema?.properties) return "";
  return Object.entries(schema.properties)
    .map(([name, property]) =>
      searchable(
        [
          name,
          property.title,
          property.description,
          Array.isArray(property.enum) ? property.enum.join(" ") : "",
        ].join(" "),
      ),
    )
    .join(" ");
}

/**
 * MCP ツールを、実名と inputSchema の両方から画像生成・動画生成・その他へ分ける。
 * 一覧/削除ツールを生成と誤認しないよう、媒体名だけでなく generate/create 系の動詞も必須にする。
 */
export function classifyRemoteMcpTool(tool: RemoteMcpToolLike): RemoteMcpToolKind {
  const identity = searchable(`${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`);
  const schemaText = schemaSearchText(tool.inputSchemaJson);
  const combined = `${identity} ${schemaText}`;

  // image_to_video は入力側にも image が現れるので、変換先を最優先する。
  if (TO_VIDEO_PATTERN.test(combined)) return "video";
  if (TO_IMAGE_PATTERN.test(combined)) return "image";

  const hasAction = ACTION_PATTERN.test(combined);
  if (!hasAction) return "other";

  // ツール名・タイトルは schema より強い手掛かり。入力画像を取る動画生成を
  // schema 中の image だけで画像生成へ誤分類しないため、先に判定する。
  const identityHasVideo = VIDEO_PATTERN.test(identity);
  const identityHasImage = IMAGE_PATTERN.test(identity);
  if (identityHasVideo && !identityHasImage) return "video";
  if (identityHasImage && !identityHasVideo) return "image";

  const schemaHasVideo = VIDEO_PATTERN.test(schemaText);
  const schemaHasImage = IMAGE_PATTERN.test(schemaText);
  if (schemaHasVideo && !schemaHasImage) return "video";
  if (schemaHasImage && !schemaHasVideo) return "image";
  return "other";
}

export function groupRemoteMcpTools<T extends RemoteMcpToolLike>(
  tools: readonly T[],
): RemoteMcpToolGroups<T> {
  const groups: RemoteMcpToolGroups<T> = { image: [], video: [], other: [] };
  for (const tool of tools) groups[classifyRemoteMcpTool(tool)].push(tool);
  return groups;
}

function normalizedFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function acceptsScalar(property: JsonSchemaProperty): boolean {
  if (property.readOnly) return false;
  const types = Array.isArray(property.type) ? property.type : [property.type];
  return types.every((type) => type === undefined || type === "string" || type === "number" || type === "integer");
}

function findField(
  properties: Record<string, JsonSchemaProperty>,
  orderedMatches: readonly ((normalized: string) => boolean)[],
): string | undefined {
  const entries = Object.entries(properties).filter(([, property]) => acceptsScalar(property));
  for (const matches of orderedMatches) {
    const found = entries.find(([name]) => matches(normalizedFieldName(name)));
    if (found) return found[0];
  }
  return undefined;
}

function promptField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) => name === "prompt" || name === "inputprompt" || name === "textprompt",
    (name) => name.endsWith("prompt") && !name.includes("negative"),
    (name) => name === "text" || name === "description" || name === "input",
  ]);
}

function modelField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) => name === "model" || name === "modelid" || name === "modelname",
    (name) => name.includes("model"),
  ]);
}

function aspectField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) => name === "aspectratio" || name === "aspect" || name === "ratio",
    (name) => name === "size" || name === "resolution",
    (name) => name.includes("aspectratio"),
  ]);
}

function countField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  const aliases = new Set([
    "n",
    "count",
    "numimages",
    "numberofimages",
    "numberimages",
    "numoutputs",
    "numberofoutputs",
    "samples",
    "batchsize",
  ]);
  return findField(properties, [
    (name) => aliases.has(name),
    (name) => name.startsWith("num") && (name.includes("image") || name.includes("output")),
  ]);
}

function coerceScalar(value: string | number, property: JsonSchemaProperty): string | number {
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (types.includes("integer") || types.includes("number")) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return types.includes("integer") ? Math.round(numeric) : numeric;
  }
  return String(value);
}

function putMappedValue(
  params: Record<string, unknown>,
  properties: Record<string, JsonSchemaProperty>,
  field: string | undefined,
  value: string | number | undefined,
) {
  if (!field || value === undefined || (typeof value === "string" && !value.trim())) return;
  params[field] = coerceScalar(value, properties[field]);
}

/** モデル選択を組み合わせられる inputSchema かを返す。 */
export function remoteMcpSchemaHasModelField(schemaJson: string): boolean {
  const { schema } = parseSchema(schemaJson);
  return Boolean(schema?.properties && modelField(schema.properties));
}

/**
 * アプリ側の共通入力を MCP ツール固有のフィールド名へ割り当てる。
 * 未知の required は推測で埋めず missingRequired に残し、呼び出し側が送信を止める。
 */
export function buildRemoteMcpParams(
  schemaJson: string,
  input: RemoteMcpParamInput,
): BuildRemoteMcpParamsResult {
  const parsed = parseSchema(schemaJson);
  if (!parsed.schema) {
    return {
      paramsJson: "{}",
      params: {},
      missingRequired: [],
      schemaError: parsed.error,
    };
  }

  const properties = parsed.schema.properties ?? {};
  const required = Array.isArray(parsed.schema.required)
    ? parsed.schema.required.filter((name): name is string => typeof name === "string")
    : [];
  const params: Record<string, unknown> = {};

  // const と required の default は schema が明示した値なので、推測せず利用できる。
  for (const [name, property] of Object.entries(properties)) {
    if (property.const !== undefined) params[name] = property.const;
    else if (required.includes(name) && property.default !== undefined) {
      params[name] = property.default;
    }
  }

  putMappedValue(params, properties, promptField(properties), input.prompt);
  putMappedValue(params, properties, modelField(properties), input.model);
  putMappedValue(params, properties, aspectField(properties), input.aspectRatio);
  putMappedValue(params, properties, countField(properties), input.count);

  const missingRequired = required.filter((name) => {
    const value = params[name];
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
  });

  return {
    paramsJson: JSON.stringify(params),
    params,
    missingRequired,
  };
}
