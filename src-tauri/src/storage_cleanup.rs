//! ストレージ自動掃除モジュール
//!
//! 起動時 + 24時間ごとに、Codex の一時データを自動削除する。
//!
//! 削除対象 (GORI 専用 CODEX_HOME と 旧 ~/.codex の両方):
//! - <CODEX_HOME>/sessions/  : 3日以上前の .jsonl ファイル
//! - ~/.codex/generated_images/ : v0.2.7 以前の遺物、全削除
//!
//! FB#19 対応で GORI は専用 CODEX_HOME
//! (~/Library/Application Support/app.codexframefactory/codex-home) を使うように
//! なった。今後 GORI が吐く sessions はこの専用 HOME 配下に溜まるので、掃除対象に
//! 専用 HOME の sessions を加える。旧 ~/.codex/sessions も後方互換で掃除する。
//!
//! 絶対に触らないもの:
//! - ~/Pictures/GORI GORI/ (ユーザーの作品データ)
//! - ~/Library/Application Support/app.codexframefactory/ (プリセット/設定) ※ codex-home の sessions のみ掃除
//! - <CODEX_HOME>/generated_images/ (現行の生成画像。**消さない**)
//! - <CODEX_HOME>/skills/ / ~/.codex/skills/ (スキル本体)
//! - <CODEX_HOME>/auth.json / config.toml (認証・設定)

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
    /// Codex ログ (logs_2.sqlite*) と WebView キャッシュの解放バイト数。
    /// FB-A4: 掃除前 inspect で表示していたのに run_cleanup が消していなかった分。
    pub cache_bytes_freed: u64,
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

    // 掃除対象の sessions ディレクトリ候補:
    //   1. GORI 専用 CODEX_HOME/sessions (今後 GORI が吐く本体)
    //   2. 旧 ~/.codex/sessions (後方互換)
    // 同一パスになるケースは無いが、重複時の二重掃除を避けるため dedup する。
    let mut session_dirs: Vec<PathBuf> = Vec::new();
    if let Some(gori_home) = gori_codex_home_dir() {
        session_dirs.push(gori_home.join("sessions"));
    }
    if let Some(legacy_home) = legacy_codex_home_dir() {
        let legacy_sessions = legacy_home.join("sessions");
        if !session_dirs.iter().any(|d| d == &legacy_sessions) {
            session_dirs.push(legacy_sessions);
        }
    }
    if session_dirs.is_empty() {
        return Err("$HOME が解決できません".to_string());
    }

    // 1. 各 sessions/ 配下の古い .jsonl
    for sessions in &session_dirs {
        if sessions.exists() {
            match sweep_old_files(sessions, RETENTION_DAYS, Some("jsonl")).await {
                Ok((count, bytes)) => {
                    report.sessions_deleted += count;
                    report.sessions_bytes_freed += bytes;
                }
                Err(err) => report.errors.push(format!("sessions: {err}")),
            }
        }
    }

    // 2. 旧 ~/.codex/generated_images/ は v0.2.7 以前の遺物 → 全削除。
    //    **GORI 専用 CODEX_HOME/generated_images は現行の生成画像なので絶対に消さない。**
    //    ここは明示的に legacy_codex_home_dir() (= ~/.codex) のみを対象にする。
    if let Some(legacy_home) = legacy_codex_home_dir() {
        let legacy_images = legacy_home.join("generated_images");
        if legacy_images.exists() {
            match remove_dir_contents(&legacy_images).await {
                Ok((count, bytes)) => {
                    report.generated_images_deleted = count;
                    report.generated_images_bytes_freed = bytes;
                }
                Err(err) => report.errors.push(format!("generated_images: {err}")),
            }
        }
    }

    // 3. Codex ログ (logs_2.sqlite*) と WebView キャッシュ。
    //    FB-A4: これらは掃除前の inspect では合計に表示されていたのに run_cleanup が
    //    一切消していなかったため、「今すぐ整理する」を押しても合計がほとんど減らず
    //    「効かない」と見えていた。inspect が表示する一時データはすべて掃除対象にする。
    //    どちらも再生成される一時データなので削除して問題ない (ログは debug 用、
    //    WebView キャッシュは次回起動時に WebView が作り直す)。
    if let Some(home) = dirs::home_dir() {
        // Codex ログ (専用 CODEX_HOME と 旧 ~/.codex の両方)
        let mut log_homes: Vec<PathBuf> = Vec::new();
        if let Some(gori) = gori_codex_home_dir() {
            log_homes.push(gori);
        }
        if let Some(legacy) = legacy_codex_home_dir() {
            if !log_homes.iter().any(|h| h == &legacy) {
                log_homes.push(legacy);
            }
        }
        for ch in &log_homes {
            for name in ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm"] {
                report.cache_bytes_freed += remove_file_if_exists(&ch.join(name)).await;
            }
        }

        // WebView キャッシュ (macOS のみ実体あり。他 OS では候補が存在せず 0)
        for rel in ["Library/Caches/gori-gori-kun", "Library/WebKit/gori-gori-kun"] {
            let dir = home.join(rel);
            if dir.exists() {
                match remove_dir_contents(&dir).await {
                    Ok((_, bytes)) => report.cache_bytes_freed += bytes,
                    Err(err) => report.errors.push(format!("cache: {err}")),
                }
            }
        }
    }

    tracing::info!(
        target: "storage.cleanup",
        sessions = report.sessions_deleted,
        sessions_mb = report.sessions_bytes_freed / 1_000_000,
        generated = report.generated_images_deleted,
        generated_mb = report.generated_images_bytes_freed / 1_000_000,
        cache_mb = report.cache_bytes_freed / 1_000_000,
        "cleanup completed"
    );

    Ok(report)
}

/// ファイルが存在すれば削除し、解放したバイト数を返す。存在しない/失敗時は 0。
async fn remove_file_if_exists(path: &std::path::Path) -> u64 {
    let size = match fs::metadata(path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return 0,
    };
    if fs::remove_file(path).await.is_ok() {
        size
    } else {
        0
    }
}

/// 旧 ambient `~/.codex`。generated_images の遺物削除と sessions 後方互換掃除に使う。
fn legacy_codex_home_dir() -> Option<PathBuf> {
    crate::codex::home::legacy_codex_home()
}

/// GORI 専用 CODEX_HOME。今後 GORI が吐く sessions の掃除に使う。
/// パス解決のみ (作成・移行はしない)。
fn gori_codex_home_dir() -> Option<PathBuf> {
    crate::codex::home::gori_codex_home_path()
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
