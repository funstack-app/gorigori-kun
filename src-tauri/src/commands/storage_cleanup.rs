use crate::storage_cleanup::{run_cleanup, CleanupReport};

/// 手動でストレージ掃除を実行する。
/// 設定画面の「ストレージ管理」タブから呼ばれる想定。
#[tauri::command]
pub async fn storage_cleanup_run() -> Result<CleanupReport, String> {
    run_cleanup().await
}

/// 現在のキャッシュ使用量を取得する (掃除前に表示する用)。
#[tauri::command]
pub async fn storage_cleanup_inspect() -> Result<CleanupInspection, String> {
    use std::path::PathBuf;
    use tokio::fs;

    let home = dirs::home_dir().ok_or_else(|| "$HOME 解決失敗".to_string())?;
    let codex_home = home.join(".codex");

    let sessions_bytes = dir_size(&codex_home.join("sessions")).await;
    let logs_bytes = file_size(&codex_home.join("logs_2.sqlite")).await
        + file_size(&codex_home.join("logs_2.sqlite-wal")).await
        + file_size(&codex_home.join("logs_2.sqlite-shm")).await;
    let generated_bytes = dir_size(&codex_home.join("generated_images")).await;
    let cache_bytes = mac_cache_size(&home).await;

    Ok(CleanupInspection {
        sessions_bytes,
        logs_bytes,
        generated_bytes,
        cache_bytes,
        total_bytes: sessions_bytes + logs_bytes + generated_bytes + cache_bytes,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupInspection {
    pub sessions_bytes: u64,
    pub logs_bytes: u64,
    pub generated_bytes: u64,
    pub cache_bytes: u64,
    pub total_bytes: u64,
}

async fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let p = entry.path();
            match entry.metadata().await {
                Ok(m) if m.is_dir() => stack.push(p),
                Ok(m) => total += m.len(),
                Err(_) => continue,
            }
        }
    }
    total
}

async fn file_size(path: &std::path::Path) -> u64 {
    tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

#[cfg(target_os = "macos")]
async fn mac_cache_size(home: &std::path::Path) -> u64 {
    let cache = home.join("Library/Caches/gori-gori-kun");
    let webkit = home.join("Library/WebKit/gori-gori-kun");
    dir_size(&cache).await + dir_size(&webkit).await
}

#[cfg(not(target_os = "macos"))]
async fn mac_cache_size(_home: &std::path::Path) -> u64 {
    0
}
