use std::collections::HashMap;
use std::sync::Arc;

use ort::session::Session;
use tokio::sync::{Mutex, RwLock};

use crate::edit::registry::{model_path, ModelSpec};

pub type OrtSessionHandle = Arc<Mutex<Session>>;

pub struct EditRuntime {
    sessions: RwLock<HashMap<String, OrtSessionHandle>>,
}

impl EditRuntime {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// モデルIDから ort セッションを取得（キャッシュ付き）。
    ///
    /// 返り値は `Arc<Mutex<Session>>` を **全呼び出し元で共有** する。同じモデルIDを使う
    /// 別コマンド (例: クリック切り抜き UI と Magic Layer の物体分解) が同一の Mutex を
    /// 奪い合う点に注意する。片方が guard を解放し損ねると、もう片方の `.lock().await` が
    /// 永久待ちになる (2026-07-02 デッドロック真因)。共有したくない用途は
    /// `build_session_uncached` を使う。
    pub async fn get_session(&self, spec: &ModelSpec) -> Result<OrtSessionHandle, String> {
        {
            let read = self.sessions.read().await;
            if let Some(session) = read.get(spec.id) {
                return Ok(session.clone());
            }
        }

        let session = Self::build_session(spec)?;
        self.sessions
            .write()
            .await
            .insert(spec.id.to_string(), session.clone());
        Ok(session)
    }

    /// キャッシュを一切介さず、その呼び出し専用の独立セッションを生成する。
    ///
    /// なぜ: Magic Layer の物体分解はグリッド点を数百回 decoder に流す。これをキャッシュ
    /// 共有セッションでやると、クリック切り抜き UI (state.sam2_session 経由で同じ decoder を
    /// 参照) と Mutex を共有してしまい、UI 側が guard を保持したままだと物体分解の
    /// `.lock().await` が 0% CPU で永久停止する。専用セッションなら他コマンドと Mutex を
    /// 共有しないので、この経路のデッドロックが**構造的に**起きえない。
    pub fn build_session_uncached(spec: &ModelSpec) -> Result<OrtSessionHandle, String> {
        Self::build_session(spec)
    }

    fn build_session(spec: &ModelSpec) -> Result<OrtSessionHandle, String> {
        let path = model_path(spec)?;
        if !path.exists() {
            return Err(format!("model not downloaded: {}", spec.id));
        }

        tracing::info!(target: "codex.edit", "runtime: ONNXセッション生成開始 id={} path={}", spec.id, path.display());
        let session = Session::builder()
            .map_err(|e| format!("session builder: {e}"))?
            .commit_from_file(&path)
            .map_err(|e| format!("session commit: {e}"))?;
        tracing::info!(target: "codex.edit", "runtime: ONNXセッション生成完了 id={}", spec.id);
        Ok(Arc::new(Mutex::new(session)))
    }

    pub async fn clear(&self) {
        self.sessions.write().await.clear();
    }
}

impl Default for EditRuntime {
    fn default() -> Self {
        Self::new()
    }
}
