use crate::storage_cleanup::{
    cleanup_storage_categories, gori_cleanup_codex_homes, inspect_storage_breakdown, run_cleanup,
    webkit_cache_candidates, CleanupReport, StorageBreakdown, StorageCleanupCategoriesReport,
};

/// 手動でストレージ掃除を実行する。
/// 設定画面の「ストレージ管理」タブから呼ばれる想定。
#[tauri::command]
pub async fn storage_cleanup_run() -> Result<CleanupReport, String> {
    run_cleanup().await
}

/// 現在のキャッシュ使用量を取得する (掃除前に表示する用)。
///
/// run_cleanup と同じく、GORI が所有する2つの CODEX_HOME と名指しキャッシュだけを
/// 集計する。共通 `~/.codex` と生成画像は削除対象外なので、この合計には混ぜない。
#[tauri::command]
pub async fn storage_cleanup_inspect() -> Result<CleanupInspection, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME 解決失敗".to_string())?;

    let homes = gori_cleanup_codex_homes();

    let mut sessions_bytes = 0u64;
    let mut logs_bytes = 0u64;
    for ch in &homes {
        sessions_bytes += dir_size(&ch.join("sessions")).await;
        logs_bytes += file_size(&ch.join("logs_2.sqlite")).await
            + file_size(&ch.join("logs_2.sqlite-wal")).await
            + file_size(&ch.join("logs_2.sqlite-shm")).await;
    }

    // 生成画像と一覧サムネイルは今回の削除許可リスト外。
    let generated_bytes = 0;
    let cache_bytes = mac_cache_size(&home).await;

    Ok(CleanupInspection {
        sessions_bytes,
        logs_bytes,
        generated_bytes,
        cache_bytes,
        total_bytes: sessions_bytes + logs_bytes + generated_bytes + cache_bytes,
    })
}

/// 一時データを、画面で判断できるカテゴリ別に実測する。
#[tauri::command]
pub async fn storage_breakdown() -> Result<StorageBreakdown, String> {
    inspect_storage_breakdown().await
}

/// ユーザーが明示的に選んだカテゴリだけを削除する。
/// appData は core 側でも拒否され、画面を迂回して呼んでも削除できない。
#[tauri::command]
pub async fn storage_cleanup_categories(
    categories: Vec<String>,
) -> Result<StorageCleanupCategoriesReport, String> {
    cleanup_storage_categories(categories).await
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
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
}

// 掃除側と同じ名指しキャッシュだけを集計する。WebKit ルート全体を数えると、
// 削除対象外の WebsiteData / LocalStorage まで「消せる容量」に混ざってしまう。
#[cfg(target_os = "macos")]
async fn mac_cache_size(home: &std::path::Path) -> u64 {
    let mut total = 0u64;
    for path in webkit_cache_candidates(home) {
        total += dir_size(&path).await;
    }
    total
}

#[cfg(not(target_os = "macos"))]
async fn mac_cache_size(_home: &std::path::Path) -> u64 {
    0
}
