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
    pub async fn get_session(&self, spec: &ModelSpec) -> Result<OrtSessionHandle, String> {
        {
            let read = self.sessions.read().await;
            if let Some(session) = read.get(spec.id) {
                return Ok(session.clone());
            }
        }

        let path = model_path(spec)?;
        if !path.exists() {
            return Err(format!("model not downloaded: {}", spec.id));
        }

        let session = Session::builder()
            .map_err(|e| format!("session builder: {e}"))?
            .commit_from_file(&path)
            .map_err(|e| format!("session commit: {e}"))?;
        let session = Arc::new(Mutex::new(session));
        self.sessions
            .write()
            .await
            .insert(spec.id.to_string(), session.clone());
        Ok(session)
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
