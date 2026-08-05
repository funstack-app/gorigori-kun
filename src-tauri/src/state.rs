use std::collections::HashMap;
use std::sync::Arc;

use notify_debouncer_full::{Debouncer, FileIdMap};
use tokio::process::Child;
use tokio::sync::{oneshot, Mutex, RwLock};

use crate::codex::RpcClient;
use crate::commands::storage::StorageSettings;
// ort (ONNX Runtime) を使う編集セッション群は Windows 限定 (2026-07-28)。
// 理由は edit/mod.rs 冒頭のコメント参照 (Intel Mac 対応の復活)。
#[cfg(edit_ai)]
use crate::edit::runtime::EditRuntime;
#[cfg(edit_ai)]
use crate::edit::sam2::Sam2Session;
#[cfg(edit_ai)]
use crate::edit::sam3_text::Sam3TextSession;

type ImageWatcher = Debouncer<notify::RecommendedWatcher, FileIdMap>;

// 2026-06-10 段階8: CLI 版 Higgsfield のバッチキャンセル用 HiggsfieldCancellation /
// higgsfield_cancellations は廃止。MCP 版は同期生成でキャンセル対象を持たないため不要。

// storyboard checkpoint (3カット目の方向性チェック) は S3 (2026-07-28) で撤去した。
// 本生成が全カット並列になり「途中で止めて方向性を確認する」区切りが存在しなくなった
// ため。方向性の確認はラフ (絵コンテ) 段の採用行為が引き受ける。

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<RwLock<Inner>>,
    pub child: Arc<Mutex<Option<Child>>>,
    /// 通常画像生成専用の常駐 app-server。初回生成時に遅延起動する。
    pub(crate) gen_server: Arc<Mutex<Option<crate::codex::gen_server::GenServerProcess>>>,
    pub image_watcher: Arc<Mutex<Option<ImageWatcher>>>,
    /// SQLite pool for session history. Initialized in the Tauri setup
    /// hook after `app_data_dir` is resolvable; commands that need it
    /// `await` `db_pool()` and surface a clear error if init failed.
    pub db: Arc<RwLock<Option<sqlx::SqlitePool>>>,
    pub storage_settings: Arc<RwLock<Option<StorageSettings>>>,
    #[cfg(edit_ai)]
    pub edit_runtime: Arc<EditRuntime>,
    #[cfg(edit_ai)]
    pub sam2_session: Arc<RwLock<Option<Sam2Session>>>,
    /// ことばで分離 (SAM3) のセッション。embed キャッシュを持つため
    /// コマンド呼び出しをまたいで保持する (同じ画像への語の追加が数秒で返る)。
    #[cfg(edit_ai)]
    pub sam3_text_session: Arc<RwLock<Option<Sam3TextSession>>>,
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

    #[cfg(edit_ai)]
    pub fn edit_runtime(&self) -> &EditRuntime {
        &self.edit_runtime
    }

    #[cfg(edit_ai)]
    pub async fn set_sam2_session(&self, session: Sam2Session) {
        *self.sam2_session.write().await = Some(session);
    }

    #[cfg(edit_ai)]
    pub async fn clear_sam2_session(&self) {
        *self.sam2_session.write().await = None;
    }

    #[cfg(edit_ai)]
    pub async fn clear_sam3_text_session(&self) {
        *self.sam3_text_session.write().await = None;
    }

    pub fn inner_clone(&self) -> Self {
        self.clone()
    }
}
