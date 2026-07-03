/// Events emitted from Rust to the frontend.

/// `codex://notification` — every JSON-RPC notification from app-server.
/// Payload: `{ method: string, params: any }`
pub const EVENT_NOTIFICATION: &str = "codex://notification";

/// `codex://server-request` — server-initiated request awaiting client reply.
pub const EVENT_SERVER_REQUEST: &str = "codex://server-request";

/// `codex://image-generated` — a new file appeared in `~/.codex/generated_images/`.
pub const EVENT_IMAGE_GENERATED: &str = "codex://image-generated";

/// `codex://app-server-status` — `{ state: "starting" | "ready" | "exited", error?: string }`
pub const EVENT_APP_SERVER_STATUS: &str = "codex://app-server-status";

/// `codex://image-batch` — progress / completion of a parallel batch
/// generated outside the app-server (via `images_generate_batch`).
pub const EVENT_IMAGE_BATCH: &str = "codex://image-batch";

/// `codex://storyboard` — gori-storyboard スキルの実行進捗。
/// EVENT_IMAGE_BATCH とは別チャンネルとして運用する。
/// payload は stdout の1行JSONと同じ形（kind discriminator付き）。
pub const EVENT_STORYBOARD: &str = "codex://storyboard";

/// `codex://multiangle` — gori-multi-angle スキルの実行進捗。
/// 1枚の被写体参照から選んだ構図カットを並列生成する進捗イベント。
/// payload は kind discriminator 付きの camelCase JSON。
pub const EVENT_MULTIANGLE: &str = "codex://multiangle";

/// `codex://edit-model-progress` — 編集タブ用AIモデルDL進捗。
pub const EVENT_EDIT_MODEL_PROGRESS: &str = "codex://edit-model-progress";

/// `codex://edit-magic-progress` — Magic Layer 統合パイプライン進捗。
pub const EVENT_EDIT_MAGIC_PROGRESS: &str = "codex://edit-magic-progress";

/// ことばで分離 (SAM3) の進捗イベント。
pub const EVENT_EDIT_WORDS_PROGRESS: &str = "codex://edit-words-progress";
