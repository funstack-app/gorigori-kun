use std::sync::Arc;

use notify_debouncer_full::{Debouncer, FileIdMap};
use tokio::process::Child;
use tokio::sync::{Mutex, RwLock};

use crate::codex::RpcClient;
use crate::commands::storage::StorageSettings;
use crate::edit::runtime::EditRuntime;
use crate::edit::sam2::Sam2Session;

type ImageWatcher = Debouncer<notify::RecommendedWatcher, FileIdMap>;

// 2026-06-10 段階8: CLI 版 Higgsfield のバッチキャンセル用 HiggsfieldCancellation /
// higgsfield_cancellations は廃止。MCP 版は同期生成でキャンセル対象を持たないため不要。

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
}
