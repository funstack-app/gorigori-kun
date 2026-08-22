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
  durationSeconds?: number;
  startImagePath?: string;
  endImagePath?: string;
  referenceImagePaths?: string[];
  referenceVideoPaths?: string[];
  motionReferencePaths?: string[];
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
  properties?: Record<string, JsonSchemaProperty>;
  required?: unknown;
  items?: JsonSchemaProperty;
  maxItems?: number;
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

  // 元画像・元動画が required のツールは編集用。テキスト起点の生成候補には入れない。
  // required が object ラッパーの場合は schemaInputTarget が中へ降りるため除外しない。
  if (remoteMcpSchemaRequiresSourceMedia(tool.inputSchemaJson)) return "other";

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
    // Magnific の一部ツールはモデル slug の欄を mode と呼ぶ。model系が無い時だけ使う。
    (name) => name === "mode",
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

function durationField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) =>
      name === "duration" ||
      name === "durationseconds" ||
      name === "seconds" ||
      name === "lengthseconds",
    (name) => name.includes("duration") && !name.includes("max"),
  ]);
}

function startImageField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) =>
      name === "firstframe" ||
      name === "startframe" ||
      name === "firstimage" ||
      name === "startimage" ||
      name === "initialframe" ||
      name === "initialimage",
    (name) =>
      (name.includes("first") || name.includes("start") || name.includes("initial")) &&
      (name.includes("frame") || name.includes("image")),
    (name) => name === "inputimage" || name === "imageurl",
  ]);
}

function endImageField(properties: Record<string, JsonSchemaProperty>): string | undefined {
  return findField(properties, [
    (name) =>
      name === "lastframe" ||
      name === "endframe" ||
      name === "lastimage" ||
      name === "endimage" ||
      name === "finalframe" ||
      name === "finalimage",
    (name) =>
      (name.includes("last") || name.includes("end") || name.includes("final")) &&
      (name.includes("frame") || name.includes("image")),
  ]);
}

function collectionField(
  properties: Record<string, JsonSchemaProperty>,
  exact: ReadonlySet<string>,
  includes: readonly string[],
): string | undefined {
  const entries = Object.entries(properties).filter(([, property]) => !property.readOnly);
  const exactMatch = entries.find(([name]) => exact.has(normalizedFieldName(name)));
  if (exactMatch) return exactMatch[0];
  return entries.find(([name]) => {
    const normalized = normalizedFieldName(name);
    return normalized.includes("reference") && includes.some((part) => normalized.includes(part));
  })?.[0];
}

function imageReferencesField(
  properties: Record<string, JsonSchemaProperty>,
): string | undefined {
  return collectionField(
    properties,
    new Set(["referenceimages", "referenceimage", "inputimages", "images", "references"]),
    ["image", "frame", "keyframe"],
  );
}

function videoReferencesField(
  properties: Record<string, JsonSchemaProperty>,
): string | undefined {
  return collectionField(
    properties,
    new Set(["referencevideos", "referencevideo", "inputvideos", "videos"]),
    ["video", "clip"],
  );
}

function motionReferencesField(
  properties: Record<string, JsonSchemaProperty>,
): string | undefined {
  return collectionField(
    properties,
    new Set(["motionreferences", "motionreference", "motionvideos"]),
    ["motion"],
  );
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

function propertyAcceptsArray(property: JsonSchemaProperty): boolean {
  const types = Array.isArray(property.type) ? property.type : [property.type];
  return types.includes("array") || Boolean(property.items);
}

function putMappedPaths(
  params: Record<string, unknown>,
  properties: Record<string, JsonSchemaProperty>,
  field: string | undefined,
  paths: readonly string[] | undefined,
) {
  if (!field || !paths) return;
  const clean = paths.map((path) => path.trim()).filter(Boolean);
  if (clean.length === 0) return;
  params[field] = propertyAcceptsArray(properties[field]) ? clean : clean[0];
}

type SchemaInputTarget = {
  /** 共通入力が入っている object までのキー。最大2段。 */
  path: string[];
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  /** root から target の親まで。各段の required/default を検査するため保持する。 */
  ancestors: Array<{
    path: string[];
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
    child: string;
  }>;
};

function stringRequired(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

function hasKnownInput(properties: Record<string, JsonSchemaProperty>): boolean {
  return Boolean(
    promptField(properties) ||
      modelField(properties) ||
      aspectField(properties) ||
      durationField(properties) ||
      startImageField(properties) ||
      endImageField(properties),
  );
}

function hasGenerationInput(properties: Record<string, JsonSchemaProperty>): boolean {
  return Boolean(
    promptField(properties) ||
      aspectField(properties) ||
      durationField(properties) ||
      startImageField(properties) ||
      endImageField(properties) ||
      imageReferencesField(properties) ||
      videoReferencesField(properties) ||
      motionReferencesField(properties),
  );
}

function preferredWrapperIndex(name: string): number {
  const preferred = ["input", "params", "request", "arguments"];
  const index = preferred.indexOf(name.toLowerCase());
  return index < 0 ? preferred.length : index;
}

/**
 * `input` / `params` などの object を最大2段まで降り、実際の共通入力欄を選ぶ。
 * object の「入れ物」自体を prompt と誤認せず、中の prompt/model/尺などへ割り当てる。
 */
function schemaInputTarget(schema: JsonSchema): SchemaInputTarget {
  const properties = schema.properties ?? {};
  if (hasGenerationInput(properties)) {
    return {
      path: [],
      properties,
      required: stringRequired(schema.required),
      ancestors: [],
    };
  }

  type Candidate = {
    path: string[];
    property: JsonSchemaProperty;
    ancestors: SchemaInputTarget["ancestors"];
  };
  const candidates: Candidate[] = [];
  const visit = (
    currentProperties: Record<string, JsonSchemaProperty>,
    currentRequired: string[],
    path: string[],
    ancestors: SchemaInputTarget["ancestors"],
  ) => {
    if (path.length >= 2) return;
    const entries = Object.entries(currentProperties)
      .filter(([, property]) => Boolean(property.properties))
      .sort(
        ([left], [right]) =>
          preferredWrapperIndex(left) - preferredWrapperIndex(right),
      );
    for (const [name, property] of entries) {
      const nextPath = [...path, name];
      const nextAncestors = [
        ...ancestors,
        {
          path,
          properties: currentProperties,
          required: currentRequired,
          child: name,
        },
      ];
      if (property.properties && hasKnownInput(property.properties)) {
        candidates.push({ path: nextPath, property, ancestors: nextAncestors });
      }
      if (property.properties) {
        visit(
          property.properties,
          stringRequired(property.required),
          nextPath,
          nextAncestors,
        );
      }
    }
  };
  visit(properties, stringRequired(schema.required), [], []);

  const nested = candidates.sort((left, right) => {
    for (let index = 0; index < Math.max(left.path.length, right.path.length); index += 1) {
      const difference =
        preferredWrapperIndex(left.path[index] ?? "") -
        preferredWrapperIndex(right.path[index] ?? "");
      if (difference !== 0) return difference;
    }
    return left.path.length - right.path.length;
  })[0];
  if (!nested?.property.properties) {
    return {
      path: [],
      properties,
      required: stringRequired(schema.required),
      ancestors: [],
    };
  }
  return {
    path: nested.path,
    properties: nested.property.properties,
    required: stringRequired(nested.property.required),
    ancestors: nested.ancestors,
  };
}

function missingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function defaultsForRequired(
  properties: Record<string, JsonSchemaProperty>,
  required: readonly string[],
  omittedChild?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (name === omittedChild) continue;
    if (property.const !== undefined) values[name] = property.const;
    else if (required.includes(name) && property.default !== undefined) {
      values[name] = property.default;
    }
  }
  return values;
}

function requiredSourceMediaField(target: SchemaInputTarget): string | null {
  for (const name of target.required) {
    const property = target.properties[name];
    if (!property || property.properties) continue;
    const normalized = normalizedFieldName(name);
    if (
      /^(video|videos|inputvideo|sourcevideo|referencevideo|videourl|videopath|videoid|clip|inputclip)$/.test(
        normalized,
      ) ||
      /^(image|images|inputimage|sourceimage|imageurl|imagepath|imageid)$/.test(normalized)
    ) {
      return name;
    }
  }
  return null;
}

/** テキスト起点で使えず、元画像・元動画が必須の編集ツールか。 */
export function remoteMcpSchemaRequiresSourceMedia(schemaJson: string): boolean {
  const { schema } = parseSchema(schemaJson);
  return Boolean(schema && requiredSourceMediaField(schemaInputTarget(schema)));
}

/** モデル選択を組み合わせられる inputSchema かを返す。 */
export function remoteMcpSchemaHasModelField(schemaJson: string): boolean {
  const { schema } = parseSchema(schemaJson);
  return Boolean(schema && modelField(schemaInputTarget(schema).properties));
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

  const rootProperties = parsed.schema.properties ?? {};
  const target = schemaInputTarget(parsed.schema);
  const properties = target.properties;
  const required = target.required;
  const mapped: Record<string, unknown> = {};
  let params: Record<string, unknown> = {};

  // const と required の default は schema が明示した値なので、推測せず利用できる。
  for (const [name, property] of Object.entries(properties)) {
    if (property.const !== undefined) mapped[name] = property.const;
    else if (required.includes(name) && property.default !== undefined) {
      mapped[name] = property.default;
    }
  }

  putMappedValue(mapped, properties, promptField(properties), input.prompt);
  putMappedValue(mapped, properties, modelField(properties), input.model);
  putMappedValue(mapped, properties, aspectField(properties), input.aspectRatio);
  putMappedValue(mapped, properties, countField(properties), input.count);
  putMappedValue(mapped, properties, durationField(properties), input.durationSeconds);
  putMappedValue(mapped, properties, startImageField(properties), input.startImagePath);
  putMappedValue(mapped, properties, endImageField(properties), input.endImagePath);
  putMappedPaths(
    mapped,
    properties,
    imageReferencesField(properties),
    input.referenceImagePaths,
  );
  putMappedPaths(
    mapped,
    properties,
    videoReferencesField(properties),
    input.referenceVideoPaths,
  );
  putMappedPaths(
    mapped,
    properties,
    motionReferencesField(properties),
    input.motionReferencePaths,
  );

  if (target.path.length === 0) {
    params = { ...defaultsForRequired(rootProperties, required), ...mapped };
  } else {
    let nested: Record<string, unknown> = mapped;
    for (let index = target.ancestors.length - 1; index >= 0; index -= 1) {
      const ancestor = target.ancestors[index];
      nested = {
        ...defaultsForRequired(
          ancestor.properties,
          ancestor.required,
          ancestor.child,
        ),
        [ancestor.child]: nested,
      };
    }
    params = nested;
  }

  const targetPrefix = target.path.length > 0 ? `${target.path.join(".")}.` : "";
  const missingRequired = required
    .filter((name) => missingValue(mapped[name]))
    .map((name) => `${targetPrefix}${name}`);
  for (const ancestor of target.ancestors) {
    const values = defaultsForRequired(
      ancestor.properties,
      ancestor.required,
      ancestor.child,
    );
    for (const name of ancestor.required) {
      if (name === ancestor.child || !missingValue(values[name])) continue;
      missingRequired.push([...ancestor.path, name].join("."));
    }
  }

  return {
    paramsJson: JSON.stringify(params),
    params,
    missingRequired,
  };
}
