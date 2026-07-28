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

/// `codex://character-sheet` — キャラクター登録 (IPアセット化パイプライン) の実行進捗。
/// 1枚の参照画像から 3面図+表情+顔ディテールの固定カタログを並列生成する進捗イベント。
/// payload は kind discriminator 付きの camelCase JSON。
pub const EVENT_CHARACTER_SHEET: &str = "codex://character-sheet";

/// `codex://gen-concurrency` — 画像生成の同時実行数が自動で変わったときの通知。
/// payload: `{ kind: "genConcurrencyDegraded", from: number, to: number, message: string }`
/// 429 を検知した降格 (9→6) をユーザーへ1度だけ知らせる。
pub const EVENT_GEN_CONCURRENCY: &str = "codex://gen-concurrency";

/// `codex://gen-phase` — 画像1枚の生成フェーズ遷移 (設計書 S1)。
/// payload: `{ runId, imageIndex?, phase: "queued"|"thinking"|"drawing"|"done", position?: number }`
///
/// なぜ要るか: 送信から完成までの数十秒が UI 上では1枚の無反応なスピナーで、
/// 「動いているのか止まっているのか」がユーザーから区別できなかった。
/// **既に app-server が発火しているのに誰も受信していない通知** (`item/started`) を
/// 購読して、状態が変わり続けることを見せる。枠 (サブスク quota) は消費しない。
pub const EVENT_GEN_PHASE: &str = "codex://gen-phase";

/// `codex://edit-model-progress` — 編集タブ用AIモデルDL進捗。
pub const EVENT_EDIT_MODEL_PROGRESS: &str = "codex://edit-model-progress";

/// `codex://edit-magic-progress` — Magic Layer 統合パイプライン進捗。
pub const EVENT_EDIT_MAGIC_PROGRESS: &str = "codex://edit-magic-progress";

/// ことばで分離 (SAM3) の進捗イベント。
pub const EVENT_EDIT_WORDS_PROGRESS: &str = "codex://edit-words-progress";
