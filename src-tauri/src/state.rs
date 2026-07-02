use std::collections::HashMap;
use std::sync::Arc;

use notify_debouncer_full::{Debouncer, FileIdMap};
use tokio::process::Child;
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::codex::RpcClient;
use crate::commands::storage::StorageSettings;
use crate::edit::runtime::EditRuntime;
use crate::edit::sam2::Sam2Session;

type ImageWatcher = Debouncer<notify::RecommendedWatcher, FileIdMap>;

// 2026-06-10 段階8: CLI 版 Higgsfield のバッチキャンセル用 HiggsfieldCancellation /
// higgsfield_cancellations は廃止。MCP 版は同期生成でキャンセル対象を持たないため不要。

/// storyboard checkpoint (方向性チェック) でユーザーが選ぶ継続アクション。
/// A-2 (2026-06 監査): 従来 checkpoint は emit するだけで生成ループを止められず、
/// フロントの `paused` は見せかけだった。実際に Rust ループを await 停止し、
/// フロントからのこのアクションで再開/中断する。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointAction {
    /// 残りカットの生成を続行する。
    Continue,
    /// 生成を安全に中断する（生成済みカットは保持）。
    Cancel,
}

/// run_id → checkpoint 再開シグナルの送信端。
/// orchestrator が checkpoint 到達時に oneshot を作って登録し、Receiver を await する。
/// `storyboard_checkpoint_resume` が受信端へアクションを送って再開させる。
type CheckpointSenders = Arc<Mutex<HashMap<String, oneshot::Sender<CheckpointAction>>>>;

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<RwLock<Inner>>,
    pub child: Arc<Mutex<Option<Child>>>,
    pub image_watcher: Arc<Mutex<Option<ImageWatcher>>>,
    /// SQLite pool for session history. Initialized in the Tauri setup
    /// hook after `app_data_dir` is resolvable; commands that need it
    /// `await` `db_pool()` and surface a clear error if init failed.
    pub db: Arc<RwLock<Option<sqlx::SqlitePool>>>,
    pub storage_settings: Arc<RwLock<Option<StorageSettings>>>,
    pub edit_runtime: Arc<EditRuntime>,
    pub sam2_session: Arc<RwLock<Option<Sam2Session>>>,
    /// storyboard checkpoint の再開シグナル置き場 (run_id → oneshot sender)。
    checkpoint_senders: CheckpointSenders,
}

#[derive(Default)]
struct Inner {
    rpc: Option<RpcClient>,
}

impl AppState {
    pub async fn set_rpc(&self, client: RpcClient) {
        self.inner.write().await.rpc = Some(client);
    }

    pub async fn clear_rpc(&self) {
        self.inner.write().await.rpc = None;
    }

    pub async fn rpc(&self) -> Option<RpcClient> {
        self.inner.read().await.rpc.clone()
    }

    pub async fn set_child(&self, child: Child) {
        let mut guard = self.child.lock().await;
        *guard = Some(child);
    }

    pub async fn take_child(&self) -> Option<Child> {
        self.child.lock().await.take()
    }

    pub async fn set_image_watcher(&self, w: ImageWatcher) {
        *self.image_watcher.lock().await = Some(w);
    }

    pub async fn set_db(&self, pool: sqlx::SqlitePool) {
        *self.db.write().await = Some(pool);
    }

    pub async fn db_pool(&self) -> Option<sqlx::SqlitePool> {
        self.db.read().await.clone()
    }

    pub async fn set_storage_settings(&self, settings: StorageSettings) {
        *self.storage_settings.write().await = Some(settings);
    }

    pub async fn storage_settings(&self) -> Option<StorageSettings> {
        self.storage_settings.read().await.clone()
    }

    pub fn edit_runtime(&self) -> &EditRuntime {
        &self.edit_runtime
    }

    pub async fn set_sam2_session(&self, session: Sam2Session) {
        *self.sam2_session.write().await = Some(session);
    }

    pub async fn clear_sam2_session(&self) {
        *self.sam2_session.write().await = None;
    }

    pub fn inner_clone(&self) -> Self {
        self.clone()
    }

    // ===== storyboard checkpoint 再開シグナル =====

    /// checkpoint に到達した run の再開シグナルを登録し、受信端を返す。
    /// orchestrator はこの Receiver を await して継続アクションを待つ。
    /// 同じ run_id の古い sender が残っていれば置き換えて drop する（前の
    /// 受信端はその時点で Err になり cleanup 扱いになる）。
    pub async fn register_checkpoint(&self, run_id: &str) -> oneshot::Receiver<CheckpointAction> {
        let (tx, rx) = oneshot::channel();
        self.checkpoint_senders
            .lock()
            .await
            .insert(run_id.to_string(), tx);
        rx
    }

    /// run の checkpoint 再開シグナルを取り除いてアクションを送る。
    /// フロントの `storyboard_checkpoint_resume` から呼ぶ。
    /// 送信できたら true、対象 run が待機していなければ false を返す。
    pub async fn resume_checkpoint(&self, run_id: &str, action: CheckpointAction) -> bool {
        let sender = self.checkpoint_senders.lock().await.remove(run_id);
        match sender {
            Some(tx) => tx.send(action).is_ok(),
            None => false,
        }
    }

    /// run 終了時（正常/失敗/アプリ終了）に、待機中の checkpoint sender を破棄する。
    /// sender を drop すると orchestrator 側の Receiver が Err になり、await が
    /// 解けてループがリークせず終了する。二重呼び出しは無害。
    pub async fn clear_checkpoint(&self, run_id: &str) {
        self.checkpoint_senders.lock().await.remove(run_id);
    }
}
