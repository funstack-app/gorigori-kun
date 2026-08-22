use crate::storage_cleanup::{
    cleanup_storage_categories, inspect_storage_breakdown, run_cleanup, CleanupReport,
    StorageBreakdown, StorageCleanupCategoriesReport,
};

/// 手動でストレージ掃除を実行する。
/// 設定画面の「ストレージ管理」タブから呼ばれる想定。
#[tauri::command]
pub async fn storage_cleanup_run() -> Result<CleanupReport, String> {
    run_cleanup().await
}

/// 現在のキャッシュ使用量を取得する (掃除前に表示する用)。
///
/// FB#19: run_cleanup と整合させる。sessions/logs は GORI 専用 CODEX_HOME と
/// 旧 ~/.codex の両方を集計し、generated_images は run_cleanup が削除する
/// 旧 ~/.codex/generated_images のみを表示する (専用 HOME の生成画像は消さないため
/// 集計しない)。
#[tauri::command]
pub async fn storage_cleanup_inspect() -> Result<CleanupInspection, String> {
    use std::path::PathBuf;

    let home = dirs::home_dir().ok_or_else(|| "$HOME 解決失敗".to_string())?;

    // 集計対象は run_cleanup と同じ正本を使う (codex-home / codex-home-gen / ~/.codex)。
    // 2026-07-25: ここに手書きで列挙していたため codex-home-gen が漏れ、実測 2.5GB が
    // 「一時データ」の合計に1バイトも出てこなかった。掃除側と集計側で必ず同じ列挙を使う。
    let homes: Vec<PathBuf> = crate::codex::home::cleanup_target_codex_homes();

    let mut sessions_bytes = 0u64;
    let mut logs_bytes = 0u64;
    for ch in &homes {
        sessions_bytes += dir_size(&ch.join("sessions")).await;
        logs_bytes += file_size(&ch.join("logs_2.sqlite")).await
            + file_size(&ch.join("logs_2.sqlite-wal")).await
            + file_size(&ch.join("logs_2.sqlite-shm")).await;
    }

    // 掃除対象は旧 ~/.codex/generated_images のみ (専用 HOME の生成画像は保持)。
    let generated_bytes = match crate::codex::home::legacy_codex_home() {
        Some(legacy) => dir_size(&legacy.join("generated_images")).await,
        None => 0,
    };
    let thumbnail_bytes = match crate::storage_cleanup::thumbnail_cache_dir() {
        Some(dir) => dir_size(&dir).await,
        None => 0,
    };
    let cache_bytes = mac_cache_size(&home).await + thumbnail_bytes;

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

// 2026-07-25 修正: ディレクトリ名は bundle identifier (app.codexframefactory)。
// 以前は "gori-gori-kun" をハードコードしており、実体 (WebKit/app.codexframefactory)
// を見ていなかったため表示が常に 0B だった。掃除側 (storage_cleanup.rs) と同じ
// 組み立て方に揃える。旧名は空ディレクトリが残る環境向けに加算しても無害。
#[cfg(target_os = "macos")]
async fn mac_cache_size(home: &std::path::Path) -> u64 {
    let service = crate::secrets::SERVICE_NAME;
    let mut total = 0u64;
    for rel in [
        format!("Library/Caches/{service}"),
        format!("Library/WebKit/{service}"),
        "Library/Caches/gori-gori-kun".to_string(),
        "Library/WebKit/gori-gori-kun".to_string(),
    ] {
        total += dir_size(&home.join(rel)).await;
    }
    total
}

#[cfg(not(target_os = "macos"))]
async fn mac_cache_size(_home: &std::path::Path) -> u64 {
    0
}
