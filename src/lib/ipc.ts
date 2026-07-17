import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EditModeId,
  EditModelProgress,
  FontInfo,
  GrabResult,
  MagicLayerResult,
  MaskPayload,
  ModelStatus,
  PsdComposition,
  SegmentResult,
  TextRegion,
  WordsSegmentResult,
} from "./edit/types";
import type { StoryboardEvent, StoryboardRunParams } from "./storyboard/types";

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

export async function rpcRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
  return invoke<R>("codex_request", { method, params: params ?? null });
}

export async function resolveServerRequest(
  id: string | number,
  result?: unknown,
  error?: { code: number; message: string },
): Promise<void> {
  return invoke("codex_resolve_server_request", { id, result, error });
}

export function onNotification(cb: (n: RpcNotification) => void): Promise<UnlistenFn> {
  return listen<RpcNotification>(EVENT_NOTIFICATION, (e) => cb(e.payload));
}

export function onServerRequest(cb: (r: ServerRequest) => void): Promise<UnlistenFn> {
  return listen<ServerRequest>(EVENT_SERVER_REQUEST, (e) => cb(e.payload));
}

export function onAppServerStatus(cb: (s: AppServerStatus) => void): Promise<UnlistenFn> {
  return listen<AppServerStatus>(EVENT_APP_SERVER_STATUS, (e) => cb(e.payload));
}

// ──────────── Edit Tab AI Models ────────────
export type {
  EditModelCategory,
  EditModelProgress,
  ModelStatus,
  PsdComposition,
  PsdLayerSpec,
} from "./edit/types";

export function listenEditModelProgress(
  cb: (progress: EditModelProgress) => void,
): Promise<UnlistenFn> {
  return listen<EditModelProgress>(EVENT_EDIT_MODEL_PROGRESS, (event) => cb(event.payload));
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

export type EditPlatformInfo = {
  os: string;
  arch: string;
  isAppleSilicon: boolean;
};

export const editModels = {
  list: () => invoke<ModelStatus[]>("edit_models_list"),
  download: (modelIds: string[]) => invoke<void>("edit_models_download", { modelIds }),
  delete: (modelId: string) => invoke<void>("edit_models_delete", { modelId }),
  platformInfo: () => invoke<EditPlatformInfo>("edit_platform_info"),
};

export const editOcr = {
  detect: (inputPath: string) => invoke<TextRegion[]>("edit_ocr_detect", { inputPath }),
};

export const editInpaint = {
  run: (inputPath: string, maskPath: string, projectName?: string | null) =>
    invoke<string>("edit_inpaint_run", {
      inputPath,
      maskPath,
      projectName: projectName ?? null,
    }),
};

export const editGrab = {
  /** マスク + 元画像から掴めるオブジェクト透過PNG + bbox + 穴埋め背景を得る (マジックグラブ)。 */
  run: (inputPath: string, maskPath: string, projectName?: string | null) =>
    invoke<GrabResult>("edit_grab_object", {
      inputPath,
      maskPath,
      projectName: projectName ?? null,
    }),
};

export const editFonts = {
  list: (languageHint?: string | null) =>
    invoke<FontInfo[]>("edit_fonts_list", { languageHint: languageHint ?? null }),
};

export type MagicLayerOptions = {
  mode?: EditModeId;
  /** 物体分解 (SAM2 自動マスク) の有効/無効。既定 ON。standard モードでのみ効く。 */
  includeObjects?: boolean;
  /** 採用する物体数の上限。省略時は Rust 側既定 (6)。1〜12 に丸められる。 */
  objectCount?: number;
};

export const editMagic = {
  run: (
    inputPath: string,
    projectName?: string | null,
    options: MagicLayerOptions = {},
  ) =>
    invoke<MagicLayerResult>("edit_magic_run", {
      inputPath,
      projectName: projectName ?? null,
      mode: options.mode ?? "standard",
      includeObjects: options.includeObjects ?? true,
      objectCount: options.objectCount ?? null,
    }),
};

/** ことばで分離 (SAM3 テキストプロンプト・セグメンテーション)。 */
export const editWords = {
  segment: (
    inputPath: string,
    words: Array<{ prompt: string; label?: string }>,
    projectName?: string | null,
    options: { scoreThreshold?: number; mode?: "full" | "layersOnly" } = {},
  ) =>
    invoke<WordsSegmentResult>("edit_words_segment", {
      inputPath,
      words,
      projectName: projectName ?? null,
      scoreThreshold: options.scoreThreshold ?? null,
      mode: options.mode ?? null,
    }),
};

// ──────────── Storage Cleanup ────────────
export type CleanupReport = {
  sessionsDeleted: number;
  sessionsBytesFreed: number;
  generatedImagesDeleted: number;
  generatedImagesBytesFreed: number;
  cacheBytesFreed: number;
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

/** Result of `images_delete_many` (一括削除). One failing path does not
 * abort the rest, so partial success is reported. */
export type BatchDeleteResult = {
  deleted: number;
  failed: { path: string; error: string }[];
};

/** Result of `images_relink_missing` (画像パス再リンク).
 * dbUpdated: history.db で旧→新パスに張り替えた件数。
 * dbPruned: 実体消失で history.db から削除した件数 (壊れた表示を残さない)。
 * dbUnresolved: 削除に失敗した件数。
 * pathMap: フロント側 (projects.json) が同じ張り替えを適用するための旧→新マップ。
 * prunedPaths: 削除した (実体消失) パス一覧。projects.json から壊れた item を取り除くため。 */
export type RelinkResult = {
  dbUpdated: number;
  dbPruned: number;
  dbUnresolved: number;
  pathMap: Record<string, string>;
  prunedPaths: string[];
};

/** `images_export_resized` に渡すリサイズターゲット 1 件。
 * mode: "cover"=中央クロップ / "contain"=余白パディング。 */
export type ResizeTarget = {
  name: string;
  width: number;
  height: number;
  mode: "cover" | "contain";
};

/** `images_export_resized` の書き出し結果 1 件。 */
export type ResizeOutput = {
  source: string;
  target: string;
  output: string;
};

/** `images_export_resized` (SNSリサイズ書き出し) の集計結果。
 * 1 件失敗しても残りは続行し、失敗内訳を返す。 */
export type ResizeResult = {
  outputs: ResizeOutput[];
  failed: { path: string; error: string }[];
};

export const images = {
  startWatcher: () => invoke<StartWatchResult>("images_start_watcher"),
  saveToProject: (src: string, projectDir: string, newName?: string) =>
    invoke<string>("images_save_to_project", {
      src,
      projectDir,
      newName,
    }),
  revealInFinder: (path: string) => invoke<void>("images_reveal_in_finder", { path }),
  /** Persist a PNG mask alongside `srcPath` under a hidden `.masks/` dir. */
  writeMask: (srcPath: string, pngBytes: Uint8Array) =>
    invoke<string>("images_write_mask", {
      srcPath,
      pngBytes: Array.from(pngBytes),
    }),
  /** Copy an image file to a user-chosen path. */
  saveAs: (src: string, dest: string) => invoke<void>("images_save_as", { src, dest }),
  /** Rename an image file in-place within its current directory. */
  rename: (src: string, newName: string) => invoke<string>("images_rename", { src, newName }),
  /** Decode and re-encode an image as PNG or JPEG at a user-chosen path. */
  saveAsFormat: (src: string, dest: string, format: "png" | "jpeg", quality?: number) =>
    invoke<void>("images_save_as_format", { src, dest, format, quality }),
  /** Run the bundled Vision-API helper to remove the background.
   * Returns the new transparent-PNG path (sibling to src). */
  removeBackground: (srcPath: string, bgColorHex?: string) =>
    invoke<string>("images_remove_background", { srcPath, bgColorHex }),
  /** Delete an image/video file from disk and drop its history.db row.
   * Used by F-#12 没作品削除. Missing-file is treated as success. */
  deleteFile: (path: string) => invoke<void>("images_delete", { path }),
  /** Delete multiple media files at once (複数選択での一括削除).
   * One failing path does not abort the rest; returns deleted count and
   * per-path failures. */
  deleteFiles: (paths: string[]) => invoke<BatchDeleteResult>("images_delete_many", { paths }),
  /** 記録パスと実体のズレを再リンクで解消する (非破壊・冪等)。
   * α版→β版で画像の保存先が変わり、history.db / projects.json の旧パスに
   * 実体が無くて「画像が見えない」症状を解消する。history.db は Rust が
   * 直接張り替え、projects.json 用には旧→新マップを返すのでフロントが適用する。 */
  relinkMissing: () => invoke<RelinkResult>("images_relink_missing"),
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
  /** 生成済み画像を SNS 各サイズへ一括リサイズ書き出しする (W2-2)。
   * paths × targets の直積で PNG を output_dir に書き出す。1 件失敗しても
   * 残りは続行し、成功一覧と失敗内訳を返す。 */
  exportResized: (paths: string[], targets: ResizeTarget[], outputDir: string) =>
    invoke<ResizeResult>("images_export_resized", { paths, targets, outputDir }),
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
    turnId?: string;
  }) =>
    invoke<{
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
    }>("images_generate_batch", { args }),
};

export const editExport = {
  psd: (composition: PsdComposition, outputPath: string) =>
    invoke<string>("edit_export_psd", { composition, outputPath }),
  /** キャンバスの統合PNG保存 (dataBase64 は data: プレフィックスなし)。 */
  png: (path: string, dataBase64: string) =>
    invoke<void>("edit_export_png", { path, dataBase64 }),
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

export type HiggsfieldModelInfo = {
  displayName: string;
  jobSetType: string;
  type: "image" | "video";
};

// P0-1 mediaType 導入 (2026-05-28 動画タブ準備)
export type MediaType = "image" | "video";

// P0-2 動画モデル静的定義 (2026-05-28)
export type HiggsfieldVideoParams = {
  duration?: number;
  quality?: string;
  mode?: string;
  resolution?: string;
  sound?: string;
  genre?: string;
  modelVariant?: string;
  i2vInputField?: "input_image" | "medias" | "input_images";
};

// Magnific オプショナル拡張 (2026-06-08)。MCP接続のみで有効化。未接続なら全false で degrade。
export type MagnificStatus = {
  registered: boolean;
  authenticated: boolean;
};

export type MagnificGenArgs = {
  prompt: string;
  model: string;
  aspect?: string;
  count?: number;
  refImagePaths?: string[];
};

/** Magnific のアカウント残高 (account_balance ツール由来、実測1秒前後)。 */
export type MagnificAccount = {
  credits: number;
  plan?: string | null;
  unlimited: boolean;
};

export const magnific = {
  status: () => invoke<MagnificStatus>("magnific_status"),
  /** codex mcp add で MCP登録+OAuthフロー開始。ブラウザでログイン完了する。 */
  login: () => invoke<string>("magnific_login"),
  logout: () => invoke<void>("magnific_logout"),
  /** Magnific MCP経由で生成しURLをDLして generated_images に保存。コアと同じ結果型。 */
  generateBatch: (args: MagnificGenArgs) =>
    invoke<{
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
    }>("magnific_generate_batch", { args }),
  /** account_balance で残高+プランを取得 (接続済みのときだけ呼ぶ)。 */
  account: () => invoke<MagnificAccount>("magnific_account"),
};

// Higgsfield リモートMCP拡張 (2026-06-10 段階3)。CLI同梱方式の作り直し。
// mcp.higgsfield.ai に codex mcp で接続するだけ。未接続なら全false で degrade。
// 既存 higgsfield (CLI版) とは別オブジェクトとして共存させる。
export type HiggsfieldMcpStatus = {
  registered: boolean;
  authenticated: boolean;
};

// 段階5: 動画パラメータ + mediaType を受け付ける。mediaType="video" のとき
// generate_video を叩き、duration/mode/resolution/sound/genre/modelVariant を
// プロンプトのトップレベルパラメータとして渡す。mediaType 未指定/"image" は従来の
// 画像生成 (後方互換)。動画固有値は HiggsfieldVideoParams のサブセットを再利用。
export type HiggsfieldMcpGenArgs = {
  prompt: string;
  model?: string;
  aspect?: string;
  count?: number;
  refImagePaths?: string[];
  /** "image" | "video"。未指定なら image (後方互換)。 */
  mediaType?: MediaType;
  // ── 以下は mediaType="video" のときだけ意味を持つ ──
  duration?: number;
  mode?: string;
  resolution?: string;
  sound?: string;
  genre?: string;
  modelVariant?: string;
};

// 段階6: コスト見積もり (get_cost)。生成バッチと同じ動画パラメータを受け取り、
// get_cost=true で実生成せずに消費クレジット数だけを取得する。CLI 版 generateCost と互換。
export type HiggsfieldMcpCostArgs = {
  prompt: string;
  model?: string;
  aspect?: string;
  /** "image" | "video"。未指定なら image (後方互換)。 */
  mediaType?: MediaType;
  // ── 以下は mediaType="video" のときだけ意味を持つ ──
  duration?: number;
  mode?: string;
  resolution?: string;
  sound?: string;
  genre?: string;
  modelVariant?: string;
};

// 段階6: クレジット残高。CLI 版 HiggsfieldAccount のフロント互換形。
// codex が一部欠落させても degrade するため email/plan は optional。
export type HiggsfieldMcpAccount = {
  email?: string;
  credits: number;
  subscriptionPlanType?: string;
};

export const higgsfieldMcp = {
  status: () => invoke<HiggsfieldMcpStatus>("higgsfield_mcp_status"),
  /** codex mcp add で MCP登録+OAuth(実機ではaddだけで自動完了)。loginも冪等に試みる。 */
  login: () => invoke<string>("higgsfield_mcp_login"),
  logout: () => invoke<void>("higgsfield_mcp_logout"),
  /** Higgsfield MCP経由で画像/動画生成しURLをDLして generated_images に保存。
   * mediaType="video" で generate_video、参照画像は media_upload→PUT→media_confirm
   * で media_id 化して medias に渡す。コアと同じ結果型。 */
  generateBatch: (args: HiggsfieldMcpGenArgs) =>
    invoke<{
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
    }>("higgsfield_mcp_generate_batch", { args }),
  /** 段階6: models_explore で画像/動画モデルを動的取得。CLI版 listModels と同じ
   * {displayName, jobSetType, type} 形でフロント互換。 */
  listModels: (media: "image" | "video") =>
    invoke<HiggsfieldModelInfo[]>("higgsfield_mcp_list_models", { media }),
  /** 段階6: get_cost=true で実生成せずに消費クレジット数(四捨五入後の整数)を取得。 */
  generateCost: (args: HiggsfieldMcpCostArgs) =>
    invoke<number>("higgsfield_mcp_generate_cost", { args }),
  /** 段階6: balance ツールで利用可能クレジット+プラン名を取得。 */
  account: () => invoke<HiggsfieldMcpAccount>("higgsfield_mcp_account"),
};

// 2026-06-10 段階8: CLI 同梱方式の `higgsfield` オブジェクトは廃止し MCP 版 `higgsfieldMcp`
// に統合済み。CLI 版 Rust コマンド (higgsfield_status/login/list_models/generate_* 等) と
// higgsfield.rs も削除した。Higgsfield 連携は全て上の `higgsfieldMcp` を使う。

/** `codex://image-batch` event payload union (mirrors Rust `BatchEvent`). */
export type ImageBatchProvider = "codex" | "higgsfield" | "magnific";

export type ImageBatchEvent =
  | {
      kind: "started";
      batchId: string;
      count: number;
      provider?: ImageBatchProvider;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      kind: "workerStarted";
      batchId: string;
      idx: number;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      kind: "workerCompleted";
      batchId: string;
      idx: number;
      path: string;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    }
  | {
      kind: "workerFailed";
      batchId: string;
      idx: number;
      error: string;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
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
      // 失敗 worker の理由 (Rust BatchEvent::Completed と鏡映)。codex 経路で付与。
      errors?: string[];
      provider?: ImageBatchProvider;
      modelJobSetType?: string;
      modelDisplayName?: string;
      mediaType?: MediaType;
    };

export function onImageBatch(cb: (e: ImageBatchEvent) => void): Promise<UnlistenFn> {
  return listen<ImageBatchEvent>("codex://image-batch", (e) => cb(e.payload));
}

export function onImageGenerated(cb: (e: ImageEvent) => void): Promise<UnlistenFn> {
  return listen<ImageEvent>(EVENT_IMAGE_GENERATED, (e) => cb(e.payload));
}

export type { StoryboardEvent, StoryboardRunParams };

export function onStoryboardEvent(cb: (event: StoryboardEvent) => void): Promise<UnlistenFn> {
  return listen<StoryboardEvent>(EVENT_STORYBOARD, (event) => cb(event.payload));
}

/**
 * P4 (2026-05-20): 単一カット再生成用パラメータ。
 * ユーザー投入の追加参照画像 + (任意で) 自由記述で 1 take 生成する。
 */
export type RegenerateCutParams = {
  runId: string;
  cutId: string;
  characterReferenceImage: string;
  styleReferenceImage?: string;
  additionalRefs: string[];
  promptOverride?: string;
  aspectRatio: string;
  previousCutImage?: string;
  cutDescription: string;
  cutDurationSeconds?: number;
  sketchMode?: boolean;
};

export const storyboard = {
  run: (params: StoryboardRunParams) => invoke<string>("storyboard_run", { params }),
  /**
   * A-2: 方向性チェック (checkpoint) で停止中の生成ループを再開/中断する。
   * action="continue" で残りカット続行、"cancel" で安全中断 (生成済みは保持)。
   * 戻り値 true = 停止中の run にシグナルを届けた / false = 既に再開済み等で対象なし。
   */
  checkpointResume: (runId: string, action: "continue" | "cancel") =>
    invoke<boolean>("storyboard_checkpoint_resume", { runId, action }),
  /** 単一カットを追加参照画像で再生成 (新 take として TakeCompleted が来る)。 */
  regenerateCut: (params: RegenerateCutParams) =>
    invoke<string>("storyboard_regenerate_cut", { params }),
  /** P2.5: ユーザー採用 take を永続化 (adoptions.json サイドカー)。 */
  persistAdoption: (runId: string, cutId: string, takeId: string) =>
    invoke<void>("storyboard_persist_adoption", { runId, cutId, takeId }),
  /** P2.5: 保存済み採用結果を読み込む (cutId → takeId のマップ)。 */
  readAdoptions: (runId: string) =>
    invoke<Record<string, string>>("storyboard_read_adoptions", { runId }),
  /** 完了済み run の debug-log.json を読み込む（構造化プロンプト履歴の確認用）。 */
  readDebugLog: (runId: string) => invoke<string>("storyboard_read_debug_log", { runId }),
};

// ──────────── Storage Settings ────────────
// 生成画像のローカル保存先。デフォルトは ~/Pictures/GORI GORI/。
// 設定ファイルは ~/Library/Application Support/app.codexframefactory/storage-settings.json。

export type StorageSettings = {
  /** 生成画像の保存先ルートパス。 */
  storageRoot: string;
  /** プロジェクト名でサブフォルダを作成するか。 */
  projectSubfolder: boolean;
  /**
   * プロジェクトデータ (projects.json) の保存フォルダ。
   * 未指定 (null/undefined) なら OS 標準のアプリデータディレクトリに保存する (従来挙動)。
   * Google Drive 等のローカル同期フォルダを指定すると作品データをクラウド同期できる。
   */
  projectsDataRoot?: string | null;
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
  setSettings: (settings: StorageSettings) => invoke<void>("storage_set_settings", { settings }),
  /** ~/.codex/generated_images/ の中身を新保存先にコピー（元ファイルは残す）。 */
  migrateFromCodexHome: () => invoke<MigrationResult>("storage_migrate_from_codex_home"),
  /** ~/.codex/generated_images/ に残っている画像の件数と容量を取得。 */
  legacySummary: () => invoke<LegacySummary>("storage_legacy_summary"),
  /** 現在のローカル保存先の使用容量を取得（サイドバー表示用）。 */
  usageStats: () => invoke<StorageUsageStats>("storage_usage_stats"),
  /** ユーザーのホームディレクトリの絶対パスを取得（推奨パス組立用）。 */
  homeDir: () => invoke<string>("storage_home_dir"),
  /**
   * プロジェクトデータ (projects.json) の保存先フォルダを変更する。
   * 既存の projects.json を新しい場所へ移行（コピー）してから設定を保存する。
   * null / 空文字を渡すと OS 標準のアプリデータディレクトリに戻す。
   */
  setProjectsDataRoot: (newRoot: string | null) =>
    invoke<void>("projects_set_data_root", { newRoot }),
  /**
   * projects.json の世代バックアップ一覧を取得（新しい順）。
   * 各要素 [絶対パス, epochミリ秒, プロジェクト件数]。「バックアップから復元」UI用。
   */
  listProjectBackups: () =>
    invoke<[string, number, number][]>("projects_list_backups"),
  /** 指定バックアップの中身（projects.json 文字列）を取得。復元プレビュー/適用用。 */
  readProjectBackup: (backupPath: string) =>
    invoke<string>("projects_read_backup", { backupPath }),
};

// ──────────── Supabase BYO Cloud ────────────
export const supabaseCloud = {
  testConnection: (config: SupabaseConfig) => invoke<void>("supabase_test_connection", { config }),
  saveConfig: (config: SupabaseConfig) => invoke<void>("supabase_save_config", { config }),
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

export type GenerationInfo = {
  prompt: string;
  model: string | null;
  modelDisplayName: string | null;
  effort: string | null;
  provider: string | null;
  kind: string;
  refImagePaths: string[];
  generatedAt: number;
};

export const sessions = {
  list: () => invoke<Session[]>("sessions_list"),
  create: (title?: string) => invoke<Session>("session_create", { title }),
  rename: (id: string, title: string) => invoke<void>("session_rename", { id, title }),
  delete: (id: string) => invoke<void>("session_delete", { id }),
  getFull: (id: string) => invoke<SessionFull>("session_get_full", { id }),
  recordTurn: (args: TurnRecordArgs) => invoke<TurnRow>("turn_record", { args }),
  recordImage: (args: ImageRecordArgs) => invoke<ImageRow>("image_record", { args }),
  exportZip: (id: string, destZipPath: string) =>
    invoke<ExportSummary>("session_export", { id, destZipPath }),
  /** Load a past turn (with all generated images) so the chat can
   *  replay it as a frozen card. */
  getTurn: (id: string) => invoke<TurnWithImages>("turn_get", { id }),
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
  recent: (limit?: number) => invoke<PromptHistoryRow[]>("turns_recent", { limit }),
  generationInfoForImage: (path: string) =>
    invoke<GenerationInfo | null>("generation_info_for_image", { path }),
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
  loginApiKey: (apiKey: string) => invoke<unknown>("auth_login_api_key", { apiKey }),
  loginChatGPT: () => invoke<{ authUrl?: string }>("auth_login_chatgpt"),
  loginChatGPTDeviceCode: () =>
    invoke<{ verificationUrl?: string; userCode?: string }>("auth_login_chatgpt_device_code"),
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
  // unsplash_access_key は法務対応 (2026-05-21) で撤去。
  | "pexels_api_key"
  | "pixabay_api_key"
  | "tripo_api_key"
  | "meshy_api_key"
  | "supabase_anon_key"
  | "supabase_project_url"
  | "supabase_bucket_name";

export const secrets = {
  set: (key: SecretKey, value: string) => invoke<void>("secret_set", { key, value }),
  get: (key: SecretKey) => invoke<string | null>("secret_get", { key }),
  delete: (key: SecretKey) => invoke<void>("secret_delete", { key }),
  list: () => invoke<SecretKey[]>("secret_list"),
};

// ──────────── Stock photos (BYO API keys via OS Keychain) ────────────
// unsplash は法務対応 (2026-05-21) で撤去。
// pixabay は Rust 側に実装は残るが UI からは提供していない。
export type StockProvider = "pexels" | "pixabay";

// 2026-05-27 masonry チラつき修正で width/height 追加。
export type StockPhoto = {
  id: string;
  thumbUrl: string;
  fullUrl: string;
  width: number;
  height: number;
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
  search: (provider: StockProvider, query: string, page: number, filters?: StockSearchFilters) =>
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
  describeImage: (imagePath: string) => invoke<string>("codex_describe_image", { imagePath }),
  /**
   * ことばで分離の自動モード: 画像内の独立した物体を英語プロンプト+日本語名で列挙する。
   * category は大ジャンル (person/text/background/prop)。旧 Codex 応答では欠落しうる
   * (フロント側で normalizeGenre がフォールバック分類する)。
   */
  listObjects: (imagePath: string) =>
    invoke<Array<{ en: string; ja: string; category?: string | null }>>(
      "codex_list_image_objects",
      { imagePath },
    ),
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

// ──────────── Skill import / export ────────────
export type SkillImportResult = {
  id: string;
  name: string;
  installedAt: string;
  /** zip 一括インポートで展開されたファイル数 (単一 .md では 1)。 */
  fileCount: number;
};

export const skills = {
  /** 単一 SKILL.md をインポートする。 */
  importMarkdown: (sourcePath: string) =>
    invoke<SkillImportResult>("skill_import", { sourcePath }),
  /** .gori-skill.zip を一括インポートする (references/agents 込み)。 */
  importZip: (sourcePath: string) =>
    invoke<SkillImportResult>("skill_import_zip", { sourcePath }),
  /** 既存スキルを .gori-skill.zip として書き出す。展開されたファイル数を返す。 */
  exportZip: (skillId: string, destZipPath: string) =>
    invoke<number>("skill_export_zip", { skillId, destZipPath }),
};

/** scene3d: モーションガイド動画の書き出し(フレーム単位のPNG → ffmpeg MP4)。 */
export const scene3d = {
  /** 書き出しセッションを開始し、専用一時ディレクトリを返す。 */
  exportBegin: () => invoke<string>("scene3d_export_begin"),
  /** 1フレーム分の PNG バイト列を書き込む。 */
  writeFrame: (exportDir: string, index: number, pngBytes: Uint8Array) =>
    invoke<void>("scene3d_write_frame", { exportDir, index, pngBytes }),
  /** PNG連番を MP4 化。戻り値: [mp4パス, 開始フレームPNGパス]。 */
  encode: (exportDir: string, fps: number) =>
    invoke<[string, string]>("scene3d_encode", { exportDir, fps }),
};
