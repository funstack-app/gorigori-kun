//! ストレージ自動掃除モジュール
//!
//! 起動時 + 24時間ごとに、Codex CLI の一時データを自動削除する。
//!
//! 削除対象:
//! - ~/.codex/sessions/  : 3日以上前の .jsonl ファイル
//! - ~/.codex/logs_2.sqlite-wal : 3日以上前なら削除
//! - ~/.codex/generated_images/ : v0.2.7 以前の遺物、全削除
//!
//! 絶対に触らないもの:
//! - ~/Pictures/GORI GORI/ (ユーザーの作品データ)
//! - ~/Library/Application Support/app.codexframefactory/ (プリセット/設定)
//! - ~/.codex/skills/ (スキル本体)

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::fs;
use tokio::time::interval;

/// 3日間
const RETENTION_DAYS: u64 = 3;
/// 24時間ごと
const SWEEP_INTERVAL_HOURS: u64 = 24;

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub sessions_deleted: u64,
    pub sessions_bytes_freed: u64,
    pub generated_images_deleted: u64,
    pub generated_images_bytes_freed: u64,
    pub errors: Vec<String>,
}

/// バックグラウンド掃除タスクを起動する。
///
/// アプリ起動時に1度呼ぶ。内部で `tokio::spawn` するので非ブロッキング。
/// 初回は起動直後、その後は24時間ごとに自動実行。
pub fn spawn_background_cleanup() {
    // Tauri の setup フック内では Tokio runtime がまだ起動していないため、
    // `tokio::spawn` を直接呼ぶと panic する。
    // `tauri::async_runtime::spawn` を使うことで、Tauri が用意した runtime に
    // 安全にタスクを乗せられる。
    tauri::async_runtime::spawn(async {
        // 初回: 起動5秒後 (アプリ起動を妨げない)
        tokio::time::sleep(Duration::from_secs(5)).await;
        if let Err(err) = run_cleanup().await {
            tracing::warn!(target: "storage.cleanup", "initial cleanup failed: {err}");
        }

        // 以降: 24時間ごと
        let mut ticker = interval(Duration::from_secs(SWEEP_INTERVAL_HOURS * 3600));
        ticker.tick().await; // 初回 tick はすぐ完了するので捨てる
        loop {
            ticker.tick().await;
            if let Err(err) = run_cleanup().await {
                tracing::warn!(target: "storage.cleanup", "scheduled cleanup failed: {err}");
            }
        }
    });
}

/// 1回分の掃除処理。テストや手動実行から呼べる。
pub async fn run_cleanup() -> Result<CleanupReport, String> {
    let mut report = CleanupReport::default();
    let codex_home = match codex_home_dir() {
        Some(path) => path,
        None => return Err("$HOME が解決できません".to_string()),
    };

    // 1. ~/.codex/sessions/ 配下の古い .jsonl
    let sessions = codex_home.join("sessions");
    if sessions.exists() {
        match sweep_old_files(&sessions, RETENTION_DAYS, Some("jsonl")).await {
            Ok((count, bytes)) => {
                report.sessions_deleted = count;
                report.sessions_bytes_freed = bytes;
            }
            Err(err) => report.errors.push(format!("sessions: {err}")),
        }
    }

    // 2. ~/.codex/generated_images/ は v0.2.7 以前の遺物 → 全削除
    //    現在の保存先は ~/Pictures/GORI GORI/ に移行済み
    let legacy_images = codex_home.join("generated_images");
    if legacy_images.exists() {
        match remove_dir_contents(&legacy_images).await {
            Ok((count, bytes)) => {
                report.generated_images_deleted = count;
                report.generated_images_bytes_freed = bytes;
            }
            Err(err) => report.errors.push(format!("generated_images: {err}")),
        }
    }

    tracing::info!(
        target: "storage.cleanup",
        sessions = report.sessions_deleted,
        sessions_mb = report.sessions_bytes_freed / 1_000_000,
        generated = report.generated_images_deleted,
        generated_mb = report.generated_images_bytes_freed / 1_000_000,
        "cleanup completed"
    );

    Ok(report)
}

fn codex_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

/// 指定ディレクトリ配下の、指定日数より古いファイルを削除する。
/// `extension_filter` を指定すると拡張子マッチのみ削除。
async fn sweep_old_files(
    dir: &std::path::Path,
    retention_days: u64,
    extension_filter: Option<&str>,
) -> Result<(u64, u64), String> {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(retention_days * 86_400))
        .ok_or_else(|| "cutoff 計算に失敗".to_string())?;
    let cutoff_unix = cutoff
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let meta = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if let Some(filter) = extension_filter {
                if path.extension().and_then(|e| e.to_str()) != Some(filter) {
                    continue;
                }
            }
            let mtime_unix = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(u64::MAX);
            if mtime_unix < cutoff_unix {
                let size = meta.len();
                if fs::remove_file(&path).await.is_ok() {
                    count += 1;
                    bytes += size;
                }
            }
        }
    }

    Ok((count, bytes))
}

/// ディレクトリの中身を全削除(ディレクトリ自体は残す)
async fn remove_dir_contents(dir: &std::path::Path) -> Result<(u64, u64), String> {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut entries = fs::read_dir(dir)
        .await
        .map_err(|e| format!("read_dir: {e}"))?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            let dir_size = dir_size_recursive(&path).await;
            if fs::remove_dir_all(&path).await.is_ok() {
                count += 1;
                bytes += dir_size;
            }
        } else {
            let size = meta.len();
            if fs::remove_file(&path).await.is_ok() {
                count += 1;
                bytes += size;
            }
        }
    }
    Ok((count, bytes))
}

async fn dir_size_recursive(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
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
