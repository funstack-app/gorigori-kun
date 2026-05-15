import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StoryboardEvent, StoryboardRunParams } from "./storyboard/types";
import type { EditModelProgress, FontInfo, MagicLayerResult, MaskPayload, ModelStatus, PsdComposition, SegmentResult, TextRegion } from "./edit/types";

// ──────────── Event names (must match src-tauri/src/events.rs) ────────────
export const EVENT_NOTIFICATION = "codex://notification";
export const EVENT_SERVER_REQUEST = "codex://server-request";
export const EVENT_IMAGE_GENERATED = "codex://image-generated";
export const EVENT_APP_SERVER_STATUS = "codex://app-server-status";
export const EVENT_STORYBOARD = "codex://storyboard";
export const EVENT_EDIT_MODEL_PROGRESS = "codex://edit-model-progress";

// ──────────── Generic JSON-RPC bridge ────────────
export type RpcNotification = { method: string; params: unknown };
export type ServerRequest = {
  id: string | number;
  method: string;
  params: unknown;
};
export type AppServerStatus = {
  state: "starting" | "ready" | "exited";
  error?: string;
};

export async function startAppServer(binaryOverride?: string): Promise<unknown> {
  return invoke("codex_start", { binaryOverride });
}

export async function restartAppServer(binaryOverride?: string): Promise<unknown> {
  return invoke("codex_restart", { binaryOverride });
}

export async function appServerReady(): Promise<boolean> {
  return invoke<boolean>("codex_status");
}

export async function rpcRequest<R = unknown>(
  method: string,
  params?: unknown,
): Promise<R> {
  return invoke<R>("codex_request", { method, params: params ?? null });
}

export async function resolveServerRequest(
  id: string | number,
  result?: unknown,
  error?: { code: number; message: string },
): Promise<void> {
  return invoke("codex_resolve_server_request", { id, result, error });
}

export function onNotification(
  cb: (n: RpcNotification) => void,
): Promise<UnlistenFn> {
  return listen<RpcNotification>(EVENT_NOTIFICATION, (e) => cb(e.payload));
}

export function onServerRequest(
  cb: (r: ServerRequest) => void,
): Promise<UnlistenFn> {
  return listen<ServerRequest>(EVENT_SERVER_REQUEST, (e) => cb(e.payload));
}

export function onAppServerStatus(
  cb: (s: AppServerStatus) => void,
): Promise<UnlistenFn> {
  return listen<AppServerStatus>(EVENT_APP_SERVER_STATUS, (e) => cb(e.payload));
}


// ──────────── Edit Tab AI Models ────────────
export type { EditModelCategory, EditModelProgress, ModelStatus, PsdComposition, PsdLayerSpec } from "./edit/types";

export function listenEditModelProgress(
  cb: (progress: EditModelProgress) => void,
): Promise<UnlistenFn> {
  return listen<EditModelProgress>(EVENT_EDIT_MODEL_PROGRESS, (event) =>
    cb(event.payload),
  );
}


export const editSegment = {
  run: (inputPath: string, projectName?: string | null) =>
    invoke<SegmentResult>("edit_segment_run", {
      inputPath,
      projectName: projectName ?? null,
    }),
};

export const editSam2 = {
  embed: (inputPath: string) => invoke<void>("edit_sam2_embed", { inputPath }),
  predict: (x: number, y: number, positive = true) =>
    invoke<MaskPayload>("edit_sam2_predict", { x, y, positive }),
};

export const editModels = {
  list: () => invoke<ModelStatus[]>("edit_models_list"),
  download: (modelIds: string[]) =>
    invoke<void>("edit_models_download", { modelIds }),
  delete: (modelId: string) => invoke<void>("edit_models_delete", { modelId }),
};

export const editOcr = {
  detect: (inputPath: string) =>
    invoke<TextRegion[]>("edit_ocr_detect", { inputPath }),
};

export const editInpaint = {
  run: (inputPath: string, maskPath: string, projectName?: string | null) =>
    invoke<string>("edit_inpaint_run", {
      inputPath,
      maskPath,
      projectName: projectName ?? null,
    }),
};

export const editFonts = {
  list: (languageHint?: string | null) =>
    invoke<FontInfo[]>("edit_fonts_list", { languageHint: languageHint ?? null }),
};

export const editMagic = {
  run: (inputPath: string, projectName?: string | null) =>
    invoke<MagicLayerResult>("edit_magic_run", {
      inputPath,
      projectName: projectName ?? null,
    }),
};

// ──────────── Storage Cleanup ────────────
export type CleanupReport = {
  sessionsDeleted: number;
  sessionsBytesFreed: number;
  generatedImagesDeleted: number;
  generatedImagesBytesFreed: number;
  errors: string[];
};

export type CleanupInspection = {
  sessionsBytes: number;
  logsBytes: number;
  generatedBytes: number;
  cacheBytes: number;
  totalBytes: number;
};

export const storageCleanup = {
  run: () => invoke<CleanupReport>("storage_cleanup_run"),
  inspect: () => invoke<CleanupInspection>("storage_cleanup_inspect"),
};

// ──────────── Images ────────────
export type ImageEvent = {
  path: string;
  name: string;
  bucket: string;
  mtime_ms: number;
  size: number;
  kind: "initial" | "created";
};

export type StartWatchResult = { dir: string; watching: boolean };

export const images = {
  startWatcher: () => invoke<StartWatchResult>("images_start_watcher"),
  saveToProject: (src: string, projectDir: string, newName?: string) =>
    invoke<string>("images_save_to_project", {
      src,
      projectDir,
      newName,
    }),
  revealInFinder: (path: string) =>
    invoke<void>("images_reveal_in_finder", { path }),
  /** Persist a PNG mask alongside `srcPath` under a hidden `.masks/` dir. */
  writeMask: (srcPath: string, pngBytes: Uint8Array) =>
    invoke<string>("images_write_mask", {
      srcPath,
      pngBytes: Array.from(pngBytes),
    }),
  /** Copy an image file to a user-chosen path. */
  saveAs: (src: string, dest: string) =>
    invoke<void>("images_save_as", { src, dest }),
  /** Rename an image file in-place within its current directory. */
  rename: (src: string, newName: string) =>
    invoke<string>("images_rename", { src, newName }),
  /** Decode and re-encode an image as PNG or JPEG at a user-chosen path. */
  saveAsFormat: (
    src: string,
    dest: string,
    format: "png" | "jpeg",
    quality?: number,
  ) => invoke<void>("images_save_as_format", { src, dest, format, quality }),
  /** Run the bundled Vision-API helper to remove the background.
   * Returns the new transparent-PNG path (sibling to src). */
  removeBackground: (srcPath: string, bgColorHex?: string) =>
    invoke<string>("images_remove_background", { srcPath, bgColorHex }),
  /** Persist a clipboard-pasted PNG under `~/.codex/generated_images/`
   * so the watcher picks it up and the composer can attach it as a
   * reference. Returns the absolute file path. */
  writeClipboard: (pngBytes: Uint8Array) =>
    invoke<string>("images_write_clipboard", {
      pngBytes: Array.from(pngBytes),
    }),
  /** Persist a dropped / picked browser File under `~/.codex/generated_images/`
   * when the original filesystem path is not available from the webview. */
  writeUpload: (fileName: string, bytes: Uint8Array) =>
    invoke<string>("images_write_upload", {
      fileName,
      bytes: Array.from(bytes),
    }),
  /** Spawn N parallel `codex exec` workers (each with its own
   * isolated CODEX_HOME) and copy each output PNG into a fresh
   * `~/.codex/generated_images/batch-<id>/` subdir so the watcher
   * picks them up. Now used for *all* image requests — including
   * count==1 and mask edits — so the chat has a single rendering
   * path and behaves consistently. */
  generateBatch: (args: {
    prompt: string;
    count: number;
    cwd?: string;
    refImagePaths?: string[];
    /** 同 index で `refImagePaths` と対応するマスク画像。空文字は「マスクなし」。 */
    maskPaths?: string[];
    model?: string;
    effort?: string;
    aspect?: string;
  }) =>
    invoke<{
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
    }>("images_generate_batch", { args }),
};

export const editExport = {
  psd: (composition: PsdComposition, outputPath: string) =>
    invoke<string>("edit_export_psd", { composition, outputPath }),
};

export const layerSplitter = {
  run: (
    inputPath: string,
    preset: "portrait" | "illustration" | "general",
    customPrompts?: string[],
    outputPath?: string,
  ) =>
    invoke<string>("layer_splitter_run", {
      inputPath,
      preset,
      customPrompts,
      outputPath,
    }),
};

export type HiggsfieldStatus = {
  installed: boolean;
  authenticated: boolean;
  binaryPath?: string;
  version?: string;
};

export type HiggsfieldModelInfo = {
  displayName: string;
  jobSetType: string;
  type: "image" | "video";
};

export type HiggsfieldAccount = {
  email: string;
  credits: number;
  subscriptionPlanType: string;
};

export type HiggsfieldCompareModel = {
  jobSetType: string;
  displayName: string;
};

export const higgsfield = {
  status: () => invoke<HiggsfieldStatus>("higgsfield_status"),
  login: () => invoke<string>("higgsfield_login"),
  logout: () => invoke<void>("higgsfield_logout"),
  listModels: (media: "image" | "video") =>
    invoke<HiggsfieldModelInfo[]>("higgsfield_list_models", { media }),
  account: () => invoke<HiggsfieldAccount>("higgsfield_account"),
  generateBatch: (args: {
    jobSetType: string;
    displayName: string;
    prompt: string;
    count: number;
    aspect?: string;
    refImagePaths?: string[];
    cwd?: string;
  }) =>
    invoke<{
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
    }>("higgsfield_generate_batch", { args }),
  generateCompare: (args: {
    prompt: string;
    models: HiggsfieldCompareModel[];
    aspect?: string;
    refImagePaths?: string[];
    cwd?: string;
  }) =>
    invoke<{
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
    }>("higgsfield_generate_compare", { args }),
  cancelBatch: (batchId: string) =>
    invoke<void>("higgsfield_cancel_batch", { batchId }),
  generateCost: (args: {
    jobSetType: string;
    prompt: string;
    aspect?: string;
  }) => invoke<number>("higgsfield_generate_cost", args),
};

/** `codex://image-batch` event payload union (mirrors Rust `BatchEvent`). */
export type ImageBatchProvider = "codex" | "higgsfield";

export type ImageBatchEvent =
  | {
      kind: "started";
      batchId: string;
      count: number;
      provider?: ImageBatchProvider;
      modelJobSetType?: string;
      modelDisplayName?: string;
    }
  | {
      kind: "workerStarted";
      batchId: string;
      idx: number;
      modelJobSetType?: string;
      modelDisplayName?: string;
    }
  | {
      kind: "workerCompleted";
      batchId: string;
      idx: number;
      path: string;
      modelJobSetType?: string;
      modelDisplayName?: string;
    }
  | {
      kind: "workerFailed";
      batchId: string;
      idx: number;
      error: string;
      modelJobSetType?: string;
      modelDisplayName?: string;
    }
  | {
      kind: "cancelled";
      batchId: string;
    }
  | {
      kind: "completed";
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
      provider?: ImageBatchProvider;
      modelJobSetType?: string;
      modelDisplayName?: string;
    };

export function onImageBatch(
  cb: (e: ImageBatchEvent) => void,
): Promise<UnlistenFn> {
  return listen<ImageBatchEvent>("codex://image-batch", (e) => cb(e.payload));
}

export function onImageGenerated(
  cb: (e: ImageEvent) => void,
): Promise<UnlistenFn> {
  return listen<ImageEvent>(EVENT_IMAGE_GENERATED, (e) => cb(e.payload));
}

export type { StoryboardEvent, StoryboardRunParams };

export function onStoryboardEvent(
  cb: (event: StoryboardEvent) => void,
): Promise<UnlistenFn> {
  return listen<StoryboardEvent>(EVENT_STORYBOARD, (event) => cb(event.payload));
}

export const storyboard = {
  run: (params: StoryboardRunParams) =>
    invoke<string>("storyboard_run", { params }),
  /** 完了済み run の debug-log.json を読み込む（構造化プロンプト履歴の確認用）。 */
  readDebugLog: (runId: string) =>
    invoke<string>("storyboard_read_debug_log", { runId }),
};

// ──────────── Storage Settings ────────────
// 生成画像のローカル保存先。デフォルトは ~/Pictures/GORI GORI/。
// 設定ファイルは ~/Library/Application Support/app.codexframefactory/storage-settings.json。

export type StorageSettings = {
  /** 生成画像の保存先ルートパス。 */
  storageRoot: string;
  /** プロジェクト名でサブフォルダを作成するか。 */
  projectSubfolder: boolean;
  /** Supabase BYO クラウド連携が有効か。 */
  cloudSupabaseEnabled?: boolean;
  /** Supabase Project URL（anon key は Keychain 保存）。 */
  supabaseProjectUrl?: string | null;
  /** Supabase Storage バケット名。 */
  supabaseBucketName?: string | null;
};

export type MigrationResult = {
  copiedCount: number;
  failedCount: number;
  totalBytes: number;
};

export type LegacySummary = {
  exists: boolean;
  fileCount: number;
  totalBytes: number;
};

export type StorageUsageStats = {
  storageRoot: string;
  fileCount: number;
  totalBytes: number;
};

export type SupabaseConfig = {
  projectUrl: string;
  anonKey: string;
  bucketName: string;
};

export type CloudUsage = {
  usedBytes: number;
  limitBytes: number;
  fileCount: number;
};

export type SupabaseSyncResult = {
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  totalBytes: number;
  errors: string[];
};

export const storage = {
  /** 現在の保存先設定を取得。なければデフォルトを返す。 */
  getSettings: () => invoke<StorageSettings>("storage_get_settings"),
  /** 保存先設定を更新。Watcher も再起動される。 */
  setSettings: (settings: StorageSettings) =>
    invoke<void>("storage_set_settings", { settings }),
  /** ~/.codex/generated_images/ の中身を新保存先にコピー（元ファイルは残す）。 */
  migrateFromCodexHome: () =>
    invoke<MigrationResult>("storage_migrate_from_codex_home"),
  /** ~/.codex/generated_images/ に残っている画像の件数と容量を取得。 */
  legacySummary: () => invoke<LegacySummary>("storage_legacy_summary"),
  /** 現在のローカル保存先の使用容量を取得（サイドバー表示用）。 */
  usageStats: () => invoke<StorageUsageStats>("storage_usage_stats"),
  /** ユーザーのホームディレクトリの絶対パスを取得（推奨パス組立用）。 */
  homeDir: () => invoke<string>("storage_home_dir"),
};

// ──────────── Supabase BYO Cloud ────────────
export const supabaseCloud = {
  testConnection: (config: SupabaseConfig) =>
    invoke<void>("supabase_test_connection", { config }),
  saveConfig: (config: SupabaseConfig) =>
    invoke<void>("supabase_save_config", { config }),
  getConfig: () => invoke<SupabaseConfig | null>("supabase_get_config"),
  disconnect: () => invoke<void>("supabase_disconnect"),
  usage: () => invoke<CloudUsage>("supabase_usage"),
  syncNow: () => invoke<SupabaseSyncResult>("supabase_sync_now"),
};

// ──────────── Sessions ────────────
export type Session = {
  id: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  /** Path to the most-recent generated image under this session,
   * if any. Used for the small thumbnail icon in the sidebar. */
  lastImagePath?: string;
};

export type TurnRow = {
  id: string;
  sessionId: string;
  prompt: string;
  model?: string;
  effort?: string;
  provider?: ImageBatchProvider | null;
  modelJobSetType?: string | null;
  modelDisplayName?: string | null;
  refImagePaths: string[];
  count: number;
  kind: "app-server" | "batch";
  createdAt: number;
};

export type ImageRow = {
  id: string;
  turnId: string;
  path: string;
  mtimeMs: number;
  size: number;
  kind: "created" | "initial";
  createdAt: number;
};

export type TurnWithImages = TurnRow & { images: ImageRow[] };
export type SessionFull = { session: Session; turns: TurnWithImages[] };

export type TurnRecordArgs = {
  sessionId: string;
  prompt: string;
  model?: string;
  effort?: string;
  provider?: ImageBatchProvider | null;
  modelJobSetType?: string | null;
  modelDisplayName?: string | null;
  refImagePaths?: string[];
  count: number;
  kind: string;
};

export type ImageRecordArgs = {
  turnId: string;
  path: string;
  mtimeMs: number;
  size: number;
  kind: string;
};

export type ExportSummary = {
  exportedImages: number;
  missingImages: number;
};

export const sessions = {
  list: () => invoke<Session[]>("sessions_list"),
  create: (title?: string) => invoke<Session>("session_create", { title }),
  rename: (id: string, title: string) =>
    invoke<void>("session_rename", { id, title }),
  delete: (id: string) => invoke<void>("session_delete", { id }),
  getFull: (id: string) => invoke<SessionFull>("session_get_full", { id }),
  recordTurn: (args: TurnRecordArgs) =>
    invoke<TurnRow>("turn_record", { args }),
  recordImage: (args: ImageRecordArgs) =>
    invoke<ImageRow>("image_record", { args }),
  exportZip: (id: string, destZipPath: string) =>
    invoke<ExportSummary>("session_export", { id, destZipPath }),
  /** Load a past turn (with all generated images) so the chat can
   *  replay it as a frozen card. */
  getTurn: (id: string) =>
    invoke<TurnWithImages>("turn_get", { id }),
};

// ──────────── Prompt history (replaces the session-list UI) ────────────

export type PromptHistoryRow = {
  id: string;
  prompt: string;
  count: number;
  kind: "app-server" | "batch";
  createdAt: number;
  provider?: ImageBatchProvider | null;
  modelJobSetType?: string | null;
  modelDisplayName?: string | null;
  thumbPath?: string;
};

export const history = {
  recent: (limit?: number) =>
    invoke<PromptHistoryRow[]>("turns_recent", { limit }),
};

// ──────────── Auth ────────────
export type AuthAccount = {
  email?: string;
  planType?: string;
  type?: "chatgpt" | "apiKey";
} | null;

export type AccountRead = {
  account?: AuthAccount;
  requiresOpenaiAuth?: boolean;
};

export const auth = {
  read: () => invoke<AccountRead>("auth_read"),
  loginApiKey: (apiKey: string) =>
    invoke<unknown>("auth_login_api_key", { apiKey }),
  loginChatGPT: () => invoke<{ authUrl?: string }>("auth_login_chatgpt"),
  loginChatGPTDeviceCode: () =>
    invoke<{ verificationUrl?: string; userCode?: string }>(
      "auth_login_chatgpt_device_code",
    ),
  logout: () => invoke<unknown>("auth_logout"),
};

// ──────────── Local secrets (OS Keychain / Credential Manager) ────────────
export type SecretKey =
  | "openai_api_key"
  | "anthropic_api_key"
  | "replicate_api_token"
  | "fal_api_key"
  | "stability_api_key"
  | "google_api_key"
  | "bfl_api_key"
  | "ideogram_api_key"
  | "recraft_api_key"
  | "runway_api_key"
  | "luma_api_key"
  | "pika_api_key"
  | "elevenlabs_api_key"
  | "magnific_api_key"
  | "unsplash_access_key"
  | "pexels_api_key"
  | "pixabay_api_key"
  | "tripo_api_key"
  | "meshy_api_key"
  | "supabase_anon_key"
  | "supabase_project_url"
  | "supabase_bucket_name";

export const secrets = {
  set: (key: SecretKey, value: string) =>
    invoke<void>("secret_set", { key, value }),
  get: (key: SecretKey) => invoke<string | null>("secret_get", { key }),
  delete: (key: SecretKey) => invoke<void>("secret_delete", { key }),
  list: () => invoke<SecretKey[]>("secret_list"),
};

// ──────────── Stock photos (BYO API keys via OS Keychain) ────────────
export type StockProvider = "unsplash" | "pexels" | "pixabay";

export type StockPhoto = {
  id: string;
  thumbUrl: string;
  fullUrl: string;
  author: string;
  sourceUrl?: string;
  downloadTrigger?: string;
};

export type StockSearchFilters = {
  orientation?: string;
  color?: string;
  size?: string;
  orderBy?: string;
  locale?: string;
  perPage?: number;
};

export const stock = {
  search: (
    provider: StockProvider,
    query: string,
    page: number,
    filters?: StockSearchFilters,
  ) =>
    invoke<StockPhoto[]>("stock_search", {
      provider,
      query,
      page,
      filters: filters ?? null,
    }),
  download: (provider: StockProvider, photo: StockPhoto) =>
    invoke<string>("stock_download", { provider, photo }),
};

export const translate = {
  jaToEn: (text: string) => invoke<string>("translate_ja_to_en", { text }),
};

export const codexVision = {
  describeImage: (imagePath: string) =>
    invoke<string>("codex_describe_image", { imagePath }),
};

// ──────────── Codex MCP servers (~/.codex/config.toml) ────────────
export type McpServer = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

export const mcp = {
  list: () => invoke<McpServer[]>("mcp_list"),
  upsert: (server: McpServer) => invoke<void>("mcp_upsert", { server }),
  delete: (name: string) => invoke<void>("mcp_delete", { name }),
};
