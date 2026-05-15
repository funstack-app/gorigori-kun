use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::supabase_client::{SupabaseClient, SupabaseConfig};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub uploaded_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    pub total_bytes: u64,
    pub errors: Vec<String>,
}

pub async fn sync_storage_root(
    config: SupabaseConfig,
    storage_root: impl AsRef<Path>,
) -> Result<SyncResult, String> {
    let root = storage_root.as_ref().to_path_buf();
    let files = collect_image_files(&root)?;
    let client = SupabaseClient::new(config);
    let mut result = SyncResult::default();

    for path in files {
        let rel = path.strip_prefix(&root).unwrap_or(&path);
        let remote_path = format!("/{}", rel.to_string_lossy().replace('\\', "/"));
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match client.upload_file(&path, &remote_path).await {
            Ok(_) => {
                result.uploaded_count = result.uploaded_count.saturating_add(1);
                result.total_bytes = result.total_bytes.saturating_add(size);
            }
            Err(err) => {
                result.failed_count = result.failed_count.saturating_add(1);
                if result.errors.len() < 8 {
                    result.errors.push(format!("{}: {err}", path.display()));
                }
            }
        }
    }

    Ok(result)
}

pub fn spawn_background_sync() {
    tauri::async_runtime::spawn(async move {
        // 起動直後はアプリ操作を優先し、最初の同期は5分後に行う。
        tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            if let Err(err) = crate::commands::cloud_supabase::supabase_sync_now_core().await {
                tracing::debug!(target: "codex.supabase", "background sync skipped/failed: {err}");
            }
        }
    });
}

fn collect_image_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    collect_image_files_inner(root, &mut files)?;
    Ok(files)
}

fn collect_image_files_inner(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("sync scan failed ({}): {e}", dir.display()))?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_image_files_inner(&path, files)?;
        } else if file_type.is_file() && is_image_file(&path) {
            files.push(path);
        }
    }
    Ok(())
}

fn is_image_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
    )
}
