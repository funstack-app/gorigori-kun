import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeWithBytes } from "./ipcBytes";
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
import type { CharacterSheetParams } from "./character/types";

// ──────────── Event names (must match src-tauri/src/events.rs) ────────────
export const EVENT_NOTIFICATION = "codex://notification";
export const EVENT_SERVER_REQUEST = "codex://server-request";
export const EVENT_IMAGE_GENERATED = "codex://image-generated";
export const EVENT_APP_SERVER_STATUS = "codex://app-server-status";
export const EVENT_STORYBOARD = "codex://storyboard";
export const EVENT_EDIT_MODEL_PROGRESS = "codex://edit-model-progress";
export const EVENT_REMOTE_MCP_GEN = "remote-mcp-gen";

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

/** `character_sheet_run` の追加上書き。未指定なら既存経路を完全に維持する。 */
export type CharacterSheetRunParams = CharacterSheetParams & {
  sheetPromptOverride?: string;
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

export type DiagnosticCommand = {
  status: "ok" | "unavailable";
  path?: string | null;
  version: string;
  reason?: string | null;
};

export type DiagnosticEnvironment = {
  appVersion: string;
  os: string;
  arch: string;
  codex: DiagnosticCommand;
  ffmpeg: DiagnosticCommand;
  disk: {
    status: "ok" | "unsupported" | "unavailable";
    freeBytes?: number | null;
    reason: string;
  };
  temporaryStorage: {
    status: "ok" | "unsupported" | "unavailable";
    totalBytes?: number | null;
    warning: boolean;
    errorCount: number;
    reason?: string | null;
  };
  reportText: string;
};

export type NetworkEndpointDiagnostic = {
  id: string;
  label: string;
  status: "ok" | "unavailable";
  statusCode?: number | null;
  reason?: string | null;
};

export type DiagnosticNetwork = {
  codex: NetworkEndpointDiagnostic;
  updates: NetworkEndpointDiagnostic;
};

export const diagnostics = {
  environment: () => invoke<DiagnosticEnvironment>("diag_environment"),
  network: () => invoke<DiagnosticNetwork>("diag_network"),
};

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
  /**
   * ort (ONNX Runtime) 依存の編集AI機能がこのビルドで使えるか。
   *
   * os を直接見て判定しないこと。Windows 互換版 (compat / 旧CPU向け) は
   * os === "windows" のまま false になる (2026-08-02)。
   */
  editAiAvailable: boolean;
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
  /** @deprecated 会話は削除しない設計のため Rust 側で常に 0。UI では使わない。 */
  sessionsDeleted: number;
  /** @deprecated 上と同じ理由で常に 0。 */
  sessionsBytesFreed: number;
  /** 画像ペイロードを除去した rollout ファイル数 (実際に効いている指標)。 */
  strippedFiles: number;
  /** 画像ペイロード除去で削減したバイト数。 */
  strippedBytesFreed: number;
  /** @deprecated Rust 側で代入箇所が無く常に 0。 */
  generatedImagesDeleted: number;
  /** @deprecated 上と同じ理由で常に 0。 */
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

export type StorageCategoryKey =
  | "sessions"
  | "logs"
  | "webviewCache"
  | "backups"
  | "brokenQuarantine"
  | "appData";

/** appData は Rust 側でも拒否されるため、呼び出し側の型からも除外する。 */
export type StorageCleanupCategory = Exclude<StorageCategoryKey, "appData">;

export type StorageCategoryStats = {
  /** カテゴリに存在する実測総量。 */
  bytes: number;
  count: number;
  /** 現在の安全条件で削除できる量。sessions は直近24時間分を含まない。 */
  deletableBytes: number;
  deletableCount: number;
};

export type StorageBreakdown = {
  sessions: StorageCategoryStats;
  logs: StorageCategoryStats;
  webviewCache: StorageCategoryStats;
  backups: StorageCategoryStats;
  brokenQuarantine: StorageCategoryStats;
  appData: StorageCategoryStats;
  totalBytes: number;
  errors: string[];
};

export type StorageCleanupCategoriesReport = {
  freedBytesByCategory: Partial<Record<StorageCleanupCategory, number>>;
  deletedCountsByCategory: Partial<Record<StorageCleanupCategory, number>>;
  errors: string[];
};

export const storageCleanup = {
  run: () => invoke<CleanupReport>("storage_cleanup_run"),
  inspect: () => invoke<CleanupInspection>("storage_cleanup_inspect"),
  breakdown: () => invoke<StorageBreakdown>("storage_breakdown"),
  cleanupCategories: (categories: StorageCleanupCategory[]) =>
    invoke<StorageCleanupCategoriesReport>("storage_cleanup_categories", { categories }),
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

/** `images_file_sizes` の 1 件。size=null は取得不能 (存在しない/権限)。 */
export type FileSizeEntry = { path: string; size: number | null };

export const images = {
  startWatcher: () => invoke<StartWatchResult>("images_start_watcher"),
  /** 一覧用の縮小JPEGをオンデマンド生成し、キャッシュ済みの絶対パスを返す。 */
  thumbnail: (path: string, maxEdge: number) =>
    invoke<string>("images_thumbnail", { path, maxEdge }),
  saveToProject: (src: string, projectDir: string, newName?: string) =>
    invoke<string>("images_save_to_project", {
      src,
      projectDir,
      newName,
    }),
  revealInFinder: (path: string) => invoke<void>("images_reveal_in_finder", { path }),
  /** Persist a PNG mask alongside `srcPath` under a hidden `.masks/` dir. */
  writeMask: (srcPath: string, pngBytes: Uint8Array) =>
    invokeWithBytes<string>("images_write_mask", pngBytes, { "src-path": srcPath }),
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
    invokeWithBytes<string>("images_write_clipboard", pngBytes),
  /** Persist a dropped / picked browser File under `~/.codex/generated_images/`
   * when the original filesystem path is not available from the webview. */
  writeUpload: (fileName: string, bytes: Uint8Array) =>
    invokeWithBytes<string>("images_write_upload", bytes, { "file-name": fileName }),
  /** 生成済み画像を SNS 各サイズへ一括リサイズ書き出しする (W2-2)。
   * paths × targets の直積で PNG を output_dir に書き出す。1 件失敗しても
   * 残りは続行し、成功一覧と失敗内訳を返す。 */
  exportResized: (paths: string[], targets: ResizeTarget[], outputDir: string) =>
    invoke<ResizeResult>("images_export_resized", { paths, targets, outputDir }),
  /** 添付画像の合計サイズ事前検査用 (7zf)。取得できないパスは size=null で返る。 */
  fileSizes: (paths: string[]) => invoke<FileSizeEntry[]>("images_file_sizes", { paths }),
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
    /** direct-run 親 run ID。Started イベントで echo される。生成には影響しない。 */
    sourceTag?: string;
    /** 通常生成専用。`aspect` の規格寸法への正規化を有効化する。
     * マスク編集・comic は渡さない (元画像と同じ解像度が正のため)。
     * 規格寸法表は Rust 側 `images::normalize::canonical_size`。 */
    enforceAspect?: boolean;
    /** 1枚あたりの生成試行回数の上限 (1..=3)。未指定なら従来どおり最大3回の自動リトライ。
     * ブロックアウト生成のように「1操作 = 最大1生成」で生成枠を燃やしたくない
     * 呼び出し元が `1` を渡してリトライを止める (設計 r3 追補1)。 */
    maxAttempts?: number;
  }) =>
    invoke<{
      batchId: string;
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
      /** Rust のキャンセル台帳の実値。true = ユーザーが中止した run。 */
      cancelled: boolean;
    }>("images_generate_batch", { args }),
};

/** Rust `commands::audio_probe::AudioProbeResult` と一致させること。 */
export type AudioProbeResult = {
  fileName: string;
  ext: string;
  durationSec: number;
  sampleRate: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  title: string | null;
  artist: string | null;
};

/**
 * 音源メタデータ抽出 (go4)。
 *
 * 音声データ本体は codex に渡さない。ここで得た文字情報だけをプロンプトへ供給する。
 * 詳細は `src-tauri/src/commands/audio_probe.rs` の冒頭コメント。
 */
export const audio = {
  probe: (path: string) => invoke<AudioProbeResult>("audio_probe", { path }),
  /** picker 経由 (file.path が取れない) の bytes を audio_uploads/ に保存してパスを返す。 */
  writeUpload: (fileName: string, bytes: Uint8Array) =>
    invokeWithBytes<string>("audio_write_upload", bytes, { "file-name": fileName }),
};

/**
 * 走っている生成をやめる (2026-07-27 STΛCK指示で実装)。
 *
 * ## 何が止まって、何が止まらないか
 *
 * - **順番待ちのカット**: 止まる。セマフォ(同時6枚)の順番が来た時点で
 *   キャンセル印を見て、プロセスを起動せずに抜ける
 * - **走っているカット**: 止まる。PID台帳から run_id に紐づくプロセスだけを終了する
 * - **常駐 app-server**: **止めない**。1プロセスが複数 run のカットを担当しているため、
 *   これを殺すと無関係な生成まで巻き添えになる (worker_registry.rs の
 *   is_cancellable_entry が構造的に除外し、テストで固定してある)
 *
 * ## 返り値の読み方
 *
 * - `found`: その run が Rust の**実行中 run 台帳**にいたか。
 *   `false` は「すでに終了している / まだ開始していない / Rust が管理していない ID」で、
 *   **何も中止していない**。UI はこのとき「止まりました」と言ってはいけない。
 *   Rust は終了済みと未開始を区別できないので、原因は断定しない
 * - `terminated`: 実際に終了させた codex exec プロセス数。
 *   常駐 app-server 経由の生成は interrupt で止まり kill しないためここには数えない。
 *   つまり `0` は「実行中のものが無かった」ではなく「プロセスは殺していない」の意味
 *
 * **UI は押した瞬間に「やめました」と言わず、この結果を見てから文言を決める**
 * (押したら止まったことにするのは、このアプリが避けてきた嘘のUI)。
 */
export async function cancelGeneration(runId: string): Promise<{
  terminated: number;
  found: boolean;
}> {
  return invoke<{ terminated: number; found: boolean }>("cancel_generation", {
    runId,
  });
}

/**
 * 生成枠 (同時実行の上限) の現在値 (cne / 2026-08-04)。
 *
 * 上限はフロントに定数を持たない: 429 を検知すると Rust 側が 9 → 6 へ
 * 自動降格するため、ミラーした定数は降格後に嘘になる。必ずここで取り直す。
 */
export async function genCapacity(): Promise<{ limit: number; degraded: boolean }> {
  return invoke<{ limit: number; degraded: boolean }>("gen_capacity");
}

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

export type MagnificVideoModelsResult = {
  contentText: string;
  structuredContent?: unknown;
  /** app-server の正規ツール一覧から取れた video_generate の入力形式。 */
  inputSchemaJson?: string;
};

export type MagnificVideoGenArgs = {
  paramsJson: string;
  /** paramsJson 内のローカル画像を、Rust側でMagnific識別子へ安全に置換する。 */
  localImagePaths?: string[];
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
  /** Magnific MCP が現在公開している動画モデルを実取得する。 */
  videoModelsList: () =>
    invoke<MagnificVideoModelsResult>("magnific_video_models_list"),
  /** 選択モデルを video_generate へ渡し、動画を既存の動画保存先へ保存する。 */
  videoGenerate: (args: MagnificVideoGenArgs) =>
    invoke<{
      generatedPaths: string[];
      failedCount: number;
      errors: string[];
    }>("magnific_video_generate", { args }),
};

export type RemoteMcpProvider = {
  id: string;
  label: string;
  url: string;
};

export type RemoteMcpStatus = {
  id: string;
  registered: boolean;
  authenticated: boolean;
};

export type RemoteMcpDiscoveryAttempt = {
  tool: string;
  ok: boolean;
  /** tool/call の生応答。UI向け結果では Rust 側で4,000文字までに制限される。 */
  raw: string;
};

export type RemoteMcpDiscoveredModel = {
  id: string;
  name: string;
  label?: string;
};

export type RemoteMcpDiscovery = {
  providerId: string;
  attempts: RemoteMcpDiscoveryAttempt[];
  models: RemoteMcpDiscoveredModel[];
};

export type RemoteMcpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchemaJson: string;
};

export type RemoteMcpToolsResult = {
  providerId: string;
  authStatus: string;
  tools: RemoteMcpToolInfo[];
};

export type RemoteMcpGenerateArgs = {
  requestId: string;
  providerId: string;
  toolName: string;
  paramsJson: string;
  kind: "image" | "video";
};

export type RemoteMcpGenEvent = {
  requestId: string;
  providerId: string;
  phase: "running" | "saving" | "done" | "error";
  message?: string;
  savedPaths?: string[];
};

export type RemoteMcpGenerateResult = {
  savedPaths: string[];
  errors: string[];
};

export type RemoteMcpQueryArgs = {
  providerId: string;
  toolName: string;
  paramsJson: string;
};

export type RemoteMcpQueryResult = {
  /** MCP content[] の text を順番どおり改行結合した値。 */
  contentText: string;
  /** MCP が返した structuredContent。無い場合だけ undefined。 */
  structuredContent?: unknown;
};

/** OAuth 対応リモート HTTP MCP の共通接続層。専用生成 UI とは独立している。 */
export const remoteMcp = {
  providers: () => invoke<RemoteMcpProvider[]>("remote_mcp_providers"),
  statusAll: () => invoke<RemoteMcpStatus[]>("remote_mcp_status_all"),
  login: (id: string) => invoke<string>("remote_mcp_login", { providerId: id }),
  logout: (id: string) => invoke<void>("remote_mcp_logout", { providerId: id }),
  /** 読み取り系ツールだけを実測し、モデル候補と全試行結果を保存する。 */
  discover: (id: string) =>
    invoke<RemoteMcpDiscovery>("remote_mcp_discover", { providerId: id }),
  /** app data_dir に保存された前回結果。未実測なら null。 */
  discoveryCached: (id: string) =>
    invoke<RemoteMcpDiscovery | null>("remote_mcp_discovery_cached", { providerId: id }),
  /** MCP が公開しているツール(そのサービスでできる操作)を実測する。 */
  listTools: (id: string) =>
    invoke<RemoteMcpToolsResult>("remote_mcp_list_tools", { providerId: id }),
  /** app data_dir に保存された前回のツール一覧。未取得なら null。 */
  listToolsCached: (id: string) =>
    invoke<RemoteMcpToolsResult | null>("remote_mcp_list_tools_cached", { providerId: id }),
  /** モデル一覧などの読み取り専用ツールを、結果を保存せず直接呼ぶ。 */
  query: (args: RemoteMcpQueryArgs) =>
    invoke<RemoteMcpQueryResult>("remote_mcp_query", args),
  /** 生成を依頼する。画面の進捗・完了・失敗は remote-mcp-gen イベントを正とする。 */
  generate: (args: RemoteMcpGenerateArgs) =>
    invoke<RemoteMcpGenerateResult>("remote_mcp_generate", args),
};

export function onRemoteMcpGen(
  cb: (event: RemoteMcpGenEvent) => void,
): Promise<UnlistenFn> {
  return listen<RemoteMcpGenEvent>(EVENT_REMOTE_MCP_GEN, (event) => cb(event.payload));
}

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
      /** direct-run 親 run ID。Started イベントで echo される。生成には影響しない。 */
      sourceTag?: string;
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

/**
 * `codex://gen-phase` — 画像1枚が「順番待ち→AI準備中→描画中→完成」の
 * どこにいるか (設計書 S1)。Rust の `GenPhase::as_str` と1対1で対応する。
 */
export type GenPhaseName = "queued" | "thinking" | "drawing" | "done";

export type GenPhaseEvent = {
  /** バッチ ID (Rust の run_id)。どの生成に属するか。 */
  runId: string;
  /** バッチ内の何枚目か (1始まり)。カット系 (絵コンテ等) では付かない。 */
  imageIndex?: number;
  phase: GenPhaseName;
  /** queued のときだけ。自分の前に走っている枚数。 */
  position?: number;
};

export function onGenPhase(cb: (e: GenPhaseEvent) => void): Promise<UnlistenFn> {
  return listen<GenPhaseEvent>("codex://gen-phase", (e) => cb(e.payload));
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

/** adoptions.json (サイドカー v2) の 1 エントリ。cutId → これ。
 *  imagePath は採用時点の画像パス。v1 形式で書かれた古いファイルから
 *  読んだ場合は null (Rust 側が正規化して返す)。 */
export type AdoptionEntry = {
  takeId: string;
  imagePath?: string | null;
};

export const storyboard = {
  run: (params: StoryboardRunParams) => invoke<string>("storyboard_run", { params }),
  // checkpointResume は S3 (2026-07-28) で撤去。Rust 側のコマンドごと消してある。
  // 残すと「押しても何も起きないのに成功扱い」の死んだ経路になる。
  /** 単一カットを追加参照画像で再生成 (新 take として TakeCompleted が来る)。 */
  regenerateCut: (params: RegenerateCutParams) =>
    invoke<string>("storyboard_regenerate_cut", { params }),
  /** P2.5: ユーザー採用 take を永続化 (adoptions.json サイドカー)。
   *  imagePath は採用時点の画像パス。起動時の復元
   *  (restoreUnrecoveredAdoptions) が manifest.json やディレクトリ走査に
   *  依存せずプロジェクトへ戻せるように、採用時に焼いておく (rr2)。 */
  persistAdoption: (runId: string, cutId: string, takeId: string, imagePath?: string) =>
    invoke<void>("storyboard_persist_adoption", { runId, cutId, takeId, imagePath }),
  /** P2.5: 保存済み採用結果を読み込む (cutId → 採用記録のマップ)。
   *  v1 形式 (値が takeId 文字列) で書かれたファイルも Rust 側が
   *  `{ takeId, imagePath: null }` に正規化して返す。 */
  readAdoptions: (runId: string) =>
    invoke<Record<string, AdoptionEntry>>("storyboard_read_adoptions", { runId }),
  /** 完了済み run の debug-log.json を読み込む（構造化プロンプト履歴の確認用）。 */
  readDebugLog: (runId: string) => invoke<string>("storyboard_read_debug_log", { runId }),
};

/** film-projects.json のファイル正本を扱う薄い IPC 境界。 */
export const filmProjects = {
  read: () => invoke<string>("film_projects_read"),
  write: (content: string, allowEmpty = false) =>
    invoke<void>("film_projects_write", { content, allowEmpty }),
  /** film-projects.json の世代バックアップ一覧（新しい順）。 */
  listBackups: () =>
    invoke<[string, number, number][]>("film_projects_list_backups"),
  /** 一覧から選んだバックアップの JSON を、ファイル名IDの検査つきで読む。 */
  readBackup: (backupId: string) =>
    invoke<string>("film_projects_read_backup", { backupId }),
};

// ──────────── Asset Ledger ────────────

export type AssetLedgerType = "character" | "scene" | "look" | "prop" | "custom";

export type AssetLedgerSource =
  | "character-register"
  | "preset"
  | "film"
  | "library"
  | "import";

export type AssetLedgerEntry = {
  id: string;
  type: AssetLedgerType;
  name: string;
  createdAt: string;
  updatedAt: string;
  primaryImagePath: string | null;
  imagePaths: string[];
  /** 空文字列は「生成指示文なし」を表す。推測した文は入れない。 */
  prompt: string;
  negativePrompt: string | null;
  source: AssetLedgerSource;
  locked: boolean;
  tags: string[];
};

export type AssetLedgerFile = {
  version: 1;
  assets: AssetLedgerEntry[];
};

export type AssetLedgerBackupRow = [backupId: string, at: number, count: number];

/** assets-ledger.json の正本を扱う薄い IPC 境界。 */
export const assetLedger = {
  read: () => invoke<AssetLedgerFile>("assets_ledger_read"),
  upsert: (asset: AssetLedgerEntry) =>
    invoke<AssetLedgerEntry>("assets_ledger_upsert", { asset }),
  delete: (id: string) => invoke<void>("assets_ledger_delete", { id }),
  listBackups: () =>
    invoke<AssetLedgerBackupRow[]>("assets_ledger_list_backups"),
  readBackup: (backupId: string) =>
    invoke<AssetLedgerFile>("assets_ledger_read_backup", { backupId }),
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
  /**
   * 過去に使っていた画像保存先の履歴 (最大5世代・新しい順)。
   * ライブラリはここも読み続けるので、保存先を変えても過去の画像が見えなくならない。
   * **設定を組み立てるときは必ずスプレッド (`{...settings, ...}`) で引き継ぐこと。**
   * キーを列挙して組み直すとこの履歴が黙って落ち、過去画像が見えなくなる。
   */
  previousStorageRoots?: string[];
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
  /** 保存先設定を更新。Watcher も再起動される。
   *  保存先 (storageRoot) が変わったときは Rust 側で再リンクが走り、その結果
   *  (旧→新パスマップ) を返す。変更が無ければ null。呼び出し側は返り値を
   *  applyRelinkResult に流して projects / presets / favorites / judgements /
   *  referenceRoles を即時追従させる (l99 4-2。欠くと次回起動まで stale)。 */
  setSettings: (settings: StorageSettings) =>
    invoke<RelinkResult | null>("storage_set_settings", { settings }),
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
   *
   * @returns 新しい保存先へコピーできなかった**世代バックアップの件数**（0 なら完全成功）。
   *   移行そのものの失敗は throw する。0 より大きい場合、現在のデータは新しい保存先で
   *   正常に使えるが、過去のバックアップが旧フォルダに取り残されている（2026-08-06 DL-04）。
   */
  setProjectsDataRoot: (newRoot: string | null) =>
    invoke<number>("projects_set_data_root", { newRoot }),
  /**
   * projects.json の世代バックアップ一覧を取得（新しい順）。
   * 各要素 [絶対パス, epochミリ秒, プロジェクト件数]。「バックアップから復元」UI用。
   */
  listProjectBackups: () =>
    invoke<[string, number, number][]>("projects_list_backups"),
  /** 指定バックアップの中身（projects.json 文字列）を取得。復元プレビュー/適用用。 */
  readProjectBackup: (backupPath: string) =>
    invoke<string>("projects_read_backup", { backupPath }),
  /**
   * presets.json の世代バックアップ一覧を取得（新しい順）。
   * 各要素 [絶対パス, epochミリ秒, プリセット件数]。
   * 「プリセット・キャラクターのバックアップ」UI用。
   */
  listPresetBackups: () =>
    invoke<[string, number, number][]>("presets_list_backups"),
  /** 指定バックアップの中身（presets.json 文字列）を取得。復元適用用。 */
  readPresetBackup: (backupPath: string) =>
    invoke<string>("presets_read_backup", { backupPath }),
  /**
   * scene3d.json の世代バックアップ一覧を取得（新しい順）。
   * 各要素 [絶対パス, epochミリ秒, shot(カット)数]。
   * 「3Dシーンのバックアップ」UI用。3D シーンは単一プロジェクトなので
   * 件数ではなくカット数を手がかりに復元時点を選ぶ。
   */
  listScene3dBackups: () =>
    invoke<[string, number, number][]>("scene3d_list_backups"),
  /** 指定バックアップの中身（scene3d.json 文字列）を取得。復元適用用。 */
  readScene3dBackup: (backupPath: string) =>
    invoke<string>("scene3d_read_backup", { backupPath }),
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
  mediaType?: MediaType;
  durationSeconds?: number;
  thumbnailPath?: string;
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
  mediaType?: MediaType;
  durationSeconds?: number;
  thumbnailPath?: string;
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
  count: number;
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
  recentWithImages: (limit?: number) =>
    invoke<TurnWithImages[]>("turns_recent_with_images", { limit }),
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
  /**
   * レギュレーション検査用: 画像内の文字ブロックを座標付きで抽出する (生 JSON 文字列)。
   *
   * describeImage は「AI画像生成で再現するための英語プロンプト1行」を返すもので、
   * 画像内の文字列を含まない。文字面積・NG表現・打消し表記・ロゴといった
   * 文字前提のルールは、この抽出結果を渡さないと構造的に判定できない
   * (2026-07-27 監査で空振りを検出)。
   *
   * 返り値は未検証の生出力。パースは呼び出し側 (regulationCheck/textBlocks.ts) が行う。
   */
  extractTextBlocks: (imagePath: string, imgW: number, imgH: number) =>
    invoke<string>("codex_extract_text_blocks", { imagePath, imgW, imgH }),
  /**
   * 画像→3Dシーン再構成用: 画像を Blender 風ブロックアウトとして解析し、
   * 床平面上の配置図 (person/objects/camera) を構造化 JSON で返す。
   *
   * 返り値は未検証の生出力。パースと検証は呼び出し側
   * (scene3d/layoutAnalysis.ts の parseSceneLayout) が行う。
   */
  analyzeSceneLayout: (imagePath: string) =>
    invoke<string>("codex_analyze_scene_layout", { imagePath }),
  /**
   * 審査セルフチェック用: 画像から「審査観点の事実」だけを列挙する (生 JSON 文字列)。
   *
   * describeImage は「AI画像生成で再現するための英語プロンプト1行」を返すもので、
   * 固有名詞を出さないよう最適化されている ("a red sports car" であって "a Ferrari"
   * ではない)。ブランド名・実在人物名・作品名は構造的に出てこないため、権利・肖像
   * まわりの判定材料には使えない (extractTextBlocks を新設したのと同型の理由)。
   *
   * このコマンドは**事実の列挙だけ**を返す。「審査に通るか」の判定はしない
   * (承認可否は LINE の裁量)。ルールへの当てはめは呼び出し側が行う。
   *
   * 返り値は未検証の生出力。パースは呼び出し側 (sticker/check.ts) が行う。
   */
  reviewFacts: (imagePath: string) => invoke<string>("codex_review_facts", { imagePath }),
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

/** インストール済みスキル (専用 CODEX_HOME/skills 配下の実在ディレクトリ)。 */
export type InstalledSkill = { id: string; path: string };

export const skills = {
  /** 単一 SKILL.md をインポートする。 */
  importMarkdown: (sourcePath: string) =>
    invoke<SkillImportResult>("skill_import", { sourcePath }),
  /**
   * インストール済みスキル一覧。パスは Rust が解決した実パスで、フロントは
   * ホームディレクトリからパスを組み立てない (ygn 2026-08-03)。
   */
  listInstalled: () => invoke<InstalledSkill[]>("skill_list_installed"),
  /** スキルの SKILL.md 本文を読む。戻り値: [本文, スキルid]。 */
  readSkillMd: (skillId: string) =>
    invoke<[string, string]>("skill_export_read", { skillId }),
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
  /**
   * PNG連番を MP4 化。戻り値: [mp4パス, 開始フレームPNGパス]。
   * projectName を渡すと保存先のプロジェクト別サブフォルダへ出力される
   * (未指定なら storage_root 直下)。成果物は一時領域ではなく保存先に残る。
   */
  encode: (exportDir: string, fps: number, projectName?: string) =>
    invoke<[string, string]>("scene3d_encode", { exportDir, fps, projectName }),
};

/** ストーリー動画のカット結合 (uy6 Wave 3)。 */
export const videoConcat = {
  /**
   * カット動画を順に1本へ再エンコード結合し、保存先と実際に使ったつなぎ方を返す。
   *
   * ffmpeg 不在時は `ffmpeg-not-found:` で始まるエラー文字列を返す
   * (scene3d と同じ prefix 規約。呼び出し側はこれを degrade 案内に分岐させる)。
   */
  story: (paths: string[], transition: "cut" | "crossfade" = "cut") =>
    invoke<{ path: string; transitionApplied: "cut" | "crossfade" }>("video_concat_story", {
      paths,
      transition,
    }),
};

// ──────────── LINE スタンプ: 層A検査 + 書き出し (7q5 S6) ────────────

/**
 * 出口の2択。工程①〜⑤は共通で、**ここだけが分岐する**。
 *
 * - `personal` (このまま使う): 規格矯正はするが規格違反でも止めない。main/tab を出さない。
 * - `submission` (申請用に書き出す): 規格違反があれば止める。main/tab を出す。枚数の5択も見る。
 *
 * **入口でモードを聞かない。** 何も作っていない段階で商売の意思決定を強いないため。
 */
export type StickerExportMode = "personal" | "submission";

/** 層A所見の重さ。`blocker` は申請モードで書き出しを止める。 */
export type StickerIssueSeverity = "blocker" | "warning";

/** 層A（決定論チェッカー）の所見1件。 */
export type StickerIssue = {
  /** `size-over` / `no-alpha` / `margin-short` / `fringe` など。 */
  id: string;
  severity: StickerIssueSeverity;
  message: string;
};

/** 1枚分の検査結果。 */
export type StickerInspection = {
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** 不透明画素が占める割合 (0〜1)。 */
  inkRatio: number;
  /** 被写体と外枠の最短距離 (px)。被写体が無ければ null。 */
  marginPx: number | null;
  issues: StickerIssue[];
};

export type StickerInspectResult = {
  items: StickerInspection[];
  /** セット全体の所見 (`total-too-large` / `count-invalid`)。 */
  setIssues: StickerIssue[];
  totalBytes: number;
};

export type StickerExportItem = {
  source: string;
  output: string;
  width: number;
  height: number;
  bytes: number;
  /** 縮小率。**1.0 を超えることはない** (拡大禁止)。 */
  scale: number;
  issues: StickerIssue[];
};

export type StickerExportFailure = { source: string; error: string };

export type StickerExportResult = {
  mode: StickerExportMode;
  items: StickerExportItem[];
  /** 1枚失敗しても残りは書き出される (部分成功)。 */
  failed: StickerExportFailure[];
  mainImage: string | null;
  tabImage: string | null;
  totalBytes: number;
  setIssues: StickerIssue[];
  /** 申請モードで作った提出用 ZIP のパス。personal では null。 */
  zipPath: string | null;
  /**
   * 作った ZIP の**実ファイルサイズ**(バイト)。personal では null。
   *
   * `totalBytes` (PNG の素の合計) とは別物。圧縮率は中身次第で変わるため、
   * 60MB 判定はこちらの実測値で行う。
   */
  zipBytes: number | null;
};

export type StickerChromaResult = {
  /** 抜いた結果の PNG パス。**元画像は残る** (失敗時に戻れるようにするため)。 */
  output: string;
  /** 完全透過にした画素数。**0 なら緑背景が無かった** (＝抜けていない)。 */
  cleared: number;
  /** 遷移帯 (半透明) の画素数。 */
  semiTransparent: number;
  /** 残った不透明画素数 (＝被写体)。 */
  opaque: number;
  /** 緑スピルを削った画素数。 */
  despilled: number;
  /** 半透明が輪郭1周分 (100) に対しどれだけ多いか。 */
  fringePct: number;
  /**
   * 抜け残り (輪郭のにじみ) の疑いがあるか。
   *
   * しきい値の判定は **Rust 側が済ませて返す**。フロントで数値比較を書くと
   * しきい値が2箇所になるため (正本は `chroma.rs` の `FRINGE_WARN_PCT`)。
   */
  fringeWarn: boolean;
};

/**
 * 「この画像はこの統計で抜いた」という申告1件 (A5)。
 *
 * 縁の品質 (`fringe` / `edge-aliased`) は**抜いた瞬間にしか測れない**。
 * Rust 側 `inspect_rgba` は統計を引数で受け取る設計だが、**本番の呼び出しが両方とも
 * `None` を渡しており、縁の検査が実運用で一度も動いていなかった**。
 * 抜いた側 (フロント) が覚えておいて `inspect` / `export` の両方へ渡す。
 *
 * `path` は `StickerChromaResult.output` と同じ値 (＝抜いた後のファイル)。
 * **申告が無い画像では `fringe` を判定しない** — 持ち込み画像や抜きに失敗した画像に
 * 縁の品質は語れないため (測っていないものを測ったふりにしない)。
 */
export type StickerChromaSample = {
  path: string;
  cleared: number;
  semiTransparent: number;
  opaque: number;
  despilled: number;
};

/**
 * LINE スタンプの層A (画像規格の決定論チェック) と書き出し。
 *
 * ⚠️ ここが保証するのは **画像規格** (サイズ・透過・余白・容量) だけ。
 * 「審査に通る」ことは保証しない (承認可否は LINE の裁量)。UI 文言でもそう書かないこと。
 */
export const sticker = {
  /**
   * 緑背景を色距離で抜いて透過 PNG を作る (決定論・AI不使用)。
   *
   * 背景色を先に決めてから抜くので、**被写体が純白でも抜ける** (背景除去AIは
   * 白を白から分離できない)。ort を使わないため Windows 互換版でも動く。
   *
   * `cleared === 0` は**エラーではなく「抜けなかった」事実**として返る。
   * 規格としての合否は `inspect` / `export` の層A (`no-alpha`) が判定する。
   */
  chromaKey: (path: string) => invoke<StickerChromaResult>("sticker_chroma_key", { path }),
  /**
   * 検査だけ行う (ファイルは1バイトも書かない)。書き出し前の確認画面が使う。
   *
   * 出る所見は `export` と**同じ関数**から出る。別実装にすると
   * 「確認画面では通ったのに書き出しで止まる」が起きる。
   */
  inspect: (
    paths: string[],
    mode: StickerExportMode,
    /** 抜いた側が測った統計 (A5)。渡した画像だけ `fringe` / `edge-aliased` を判定する。 */
    chromaSamples?: StickerChromaSample[],
  ) =>
    invoke<StickerInspectResult>("sticker_inspect", {
      paths,
      mode,
      chromaSamples: chromaSamples ?? null,
    }),
  /**
   * フォルダへ一式書き出す (`01.png`〜)。
   *
   * **申請モードは提出用 ZIP も1つ作る** (`line-stickers.zip`)。LINE Creators Market は
   * ZIP でのアップロードを受け付けるため、作らないとユーザーが手で ZIP 化する作業が残る
   * (STΛCK指摘 2026-08-05)。個別ファイルもそのまま残るので D&D 派の導線は壊れない。
   *
   * 出力先に既存の連番/main/tab があると**書く前にエラーで止まる**
   * (`01 (1).png` を作って連番を壊さないため)。上書きしてよい場合だけ
   * `overwrite: true` を渡す — その判断は人がする。
   */
  export: (params: {
    paths: string[];
    outputDir: string;
    mode: StickerExportMode;
    /** メイン画像 (240×240) の元。未指定なら1枚目。submission でのみ使う。 */
    mainSource?: string;
    /** タブ画像 (96×74) の元。未指定なら1枚目。submission でのみ使う。 */
    tabSource?: string;
    overwrite?: boolean;
    /**
     * 作成に使った書き味 (プロンプトスタイル) のID。
     *
     * 渡すと出力先に `作成条件.txt` を併置する。**提出物には何も足さない**
     * (PNG のメタデータには書かない)。あとで「どちらで作ったか」を追うための控え。
     */
    promptStyle?: string;
    /**
     * 抜いた側が測った統計 (A5)。**`inspect` と同じ配列を渡すこと** —
     * 材料が違うと「確認画面では出た警告が書き出しでは消える」が起きる。
     */
    chromaSamples?: StickerChromaSample[];
  }) =>
    invoke<StickerExportResult>("sticker_export", {
      paths: params.paths,
      outputDir: params.outputDir,
      mode: params.mode,
      mainSource: params.mainSource ?? null,
      tabSource: params.tabSource ?? null,
      overwrite: params.overwrite ?? false,
      promptStyle: params.promptStyle ?? null,
      chromaSamples: params.chromaSamples ?? null,
    }),
};
