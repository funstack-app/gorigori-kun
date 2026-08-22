use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::codex::process::{enriched_path, no_window_flag, resolve_codex_cli_binary};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDiagnostic {
    pub status: String,
    pub path: Option<String>,
    pub version: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDiagnostic {
    pub status: String,
    pub free_bytes: Option<u64>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryStorageDiagnostic {
    pub status: String,
    pub total_bytes: Option<u64>,
    pub warning: bool,
    pub error_count: usize,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEnvironment {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub codex: CommandDiagnostic,
    pub ffmpeg: CommandDiagnostic,
    pub disk: DiskDiagnostic,
    pub temporary_storage: TemporaryStorageDiagnostic,
    /// クリップボードへそのまま使える、秘密情報を除いた環境部分。
    pub report_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEndpointDiagnostic {
    pub id: String,
    pub label: String,
    pub status: String,
    pub status_code: Option<u16>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticNetwork {
    pub codex: NetworkEndpointDiagnostic,
    pub updates: NetworkEndpointDiagnostic,
}

fn display_path_without_username(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home {
        if let Ok(relative) = path.strip_prefix(home) {
            if relative.as_os_str().is_empty() {
                return "~".to_string();
            }
            return format!("~{}{}", std::path::MAIN_SEPARATOR, relative.display());
        }
    }
    path.display().to_string()
}

pub(crate) fn redact_text(value: &str, home: Option<&Path>) -> String {
    let home_text = home.map(|path| path.display().to_string());
    value
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "sk-",
                "token",
                "api_key",
                "api-key",
                "api key",
                "apikey",
                "authorization",
                "bearer",
                "secret",
                "password",
                "credential",
            ]
            .iter()
            .any(|marker| lower.contains(marker))
            {
                return "[秘匿情報を除外]".to_string();
            }
            match home_text.as_deref() {
                Some(home) if !home.is_empty() => line.replace(home, "~"),
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn run_version_command(
    executable: PathBuf,
    args: &[&str],
    display_name: &str,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new(executable);
    command.args(args);
    command.env("PATH", enriched_path());
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    no_window_flag(&mut command);

    let output = match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(format!("{display_name} を開始できませんでした")),
        Err(_) => return Err(format!("{display_name} が10秒以内に応答しませんでした")),
    };
    if !output.status.success() {
        return Err(match output.status.code() {
            Some(code) => format!("{display_name} が終了コード {code} で失敗しました"),
            None => format!("{display_name} が正常に終了しませんでした"),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .ok_or_else(|| format!("{display_name} のバージョン出力が空でした"))
}

async fn diagnose_codex() -> CommandDiagnostic {
    match resolve_codex_cli_binary() {
        Ok(path) => {
            let shown_path = display_path_without_username(&path, dirs::home_dir().as_deref());
            match run_version_command(path, &["--version"], "Codex").await {
                Ok(version) => CommandDiagnostic {
                    status: "ok".to_string(),
                    path: Some(shown_path),
                    version,
                    reason: None,
                },
                Err(reason) => CommandDiagnostic {
                    status: "unavailable".to_string(),
                    path: Some(shown_path),
                    version: "unavailable".to_string(),
                    reason: Some(reason),
                },
            }
        }
        Err(_) => CommandDiagnostic {
            status: "unavailable".to_string(),
            path: None,
            version: "unavailable".to_string(),
            reason: Some("Codex の実行ファイルを見つけられませんでした".to_string()),
        },
    }
}

async fn diagnose_ffmpeg() -> CommandDiagnostic {
    let search_path = enriched_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let resolved = which::which_in(std::ffi::OsStr::new("ffmpeg"), Some(&search_path), &cwd);
    match resolved {
        Ok(path) => {
            let shown_path = display_path_without_username(&path, dirs::home_dir().as_deref());
            match run_version_command(path, &["-version"], "ffmpeg").await {
                Ok(version) => CommandDiagnostic {
                    status: "ok".to_string(),
                    path: Some(shown_path),
                    version,
                    reason: None,
                },
                Err(reason) => CommandDiagnostic {
                    status: "unavailable".to_string(),
                    path: Some(shown_path),
                    version: "unavailable".to_string(),
                    reason: Some(reason),
                },
            }
        }
        Err(_) => CommandDiagnostic {
            status: "unavailable".to_string(),
            path: None,
            version: "unavailable".to_string(),
            reason: Some("ffmpeg が見つかりませんでした".to_string()),
        },
    }
}

async fn diagnose_temporary_storage() -> TemporaryStorageDiagnostic {
    match super::storage_cleanup::storage_breakdown().await {
        Ok(breakdown) => {
            // 診断の「一時データ」は、画面から実際に削除できる量だけを合計する。
            // appData の作品・登録データや共通 ~/.codex は混ぜない。
            let total_bytes = deletable_temporary_storage_bytes(&breakdown);
            TemporaryStorageDiagnostic {
                status: "ok".to_string(),
                total_bytes: Some(total_bytes),
                warning: total_bytes > 10 * 1024 * 1024 * 1024,
                error_count: breakdown.errors.len(),
                reason: None,
            }
        }
        Err(_) => TemporaryStorageDiagnostic {
            status: "unavailable".to_string(),
            total_bytes: None,
            warning: false,
            error_count: 1,
            reason: Some("一時データを確認できませんでした".to_string()),
        },
    }
}

fn deletable_temporary_storage_bytes(breakdown: &crate::storage_cleanup::StorageBreakdown) -> u64 {
    [
        breakdown.sessions.deletable_bytes,
        breakdown.logs.deletable_bytes,
        breakdown.webview_cache.deletable_bytes,
        breakdown.backups.deletable_bytes,
        breakdown.broken_quarantine.deletable_bytes,
    ]
    .into_iter()
    .fold(0u64, u64::saturating_add)
}

fn format_environment_report(environment: &DiagnosticEnvironment, home: Option<&Path>) -> String {
    let path = environment.codex.path.as_deref().unwrap_or("unavailable");
    let storage_total = environment
        .temporary_storage
        .total_bytes
        .map(|bytes| bytes.to_string())
        .unwrap_or_else(|| "unsupported".to_string());
    let report = format!(
        "GORI GORI KUN 診断レポート\n\
         アプリ版: {}\n\
         OS: {} / {}\n\
         Codex: {}\n\
         Codexパス: {}\n\
         Codex理由: {}\n\
         ffmpeg: {}\n\
         ffmpeg理由: {}\n\
         ディスク空き容量: {}\n\
         一時データ(bytes): {}\n\
         一時データ確認エラー数: {}",
        environment.app_version,
        environment.os,
        environment.arch,
        environment.codex.version,
        path,
        environment.codex.reason.as_deref().unwrap_or("なし"),
        environment.ffmpeg.version,
        environment.ffmpeg.reason.as_deref().unwrap_or("なし"),
        environment.disk.status,
        storage_total,
        environment.temporary_storage.error_count,
    );
    redact_text(&report, home)
}

#[tauri::command]
pub async fn diag_environment(app: AppHandle) -> Result<DiagnosticEnvironment, String> {
    let (codex, ffmpeg, temporary_storage) = tokio::join!(
        diagnose_codex(),
        diagnose_ffmpeg(),
        diagnose_temporary_storage()
    );
    // Cargo.toml に空き容量を取得できる既存クレートが無いため、推測値は出さない。
    let disk = DiskDiagnostic {
        status: "unsupported".to_string(),
        free_bytes: None,
        reason: "この版では空き容量の取得に未対応です".to_string(),
    };
    let mut environment = DiagnosticEnvironment {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        codex,
        ffmpeg,
        disk,
        temporary_storage,
        report_text: String::new(),
    };
    environment.report_text = format_environment_report(&environment, dirs::home_dir().as_deref());
    Ok(environment)
}

async fn probe_endpoint(
    client: reqwest::Client,
    id: &str,
    label: &str,
    url: &str,
) -> NetworkEndpointDiagnostic {
    match client.head(url).send().await {
        Ok(response) => NetworkEndpointDiagnostic {
            id: id.to_string(),
            label: label.to_string(),
            status: "ok".to_string(),
            status_code: Some(response.status().as_u16()),
            reason: None,
        },
        Err(error) => NetworkEndpointDiagnostic {
            id: id.to_string(),
            label: label.to_string(),
            status: "unavailable".to_string(),
            status_code: None,
            reason: Some(if error.is_timeout() {
                "5秒以内に応答がありませんでした".to_string()
            } else if error.is_connect() {
                "接続できませんでした。オフラインまたはプロキシ設定の可能性があります".to_string()
            } else {
                "通信状態を確認できませんでした".to_string()
            }),
        },
    }
}

#[tauri::command]
pub async fn diag_network() -> Result<DiagnosticNetwork, String> {
    let client = reqwest::Client::builder()
        .timeout(NETWORK_TIMEOUT)
        .build()
        .map_err(|_| "ネットワーク診断を準備できませんでした".to_string())?;
    let (codex, updates) = tokio::join!(
        probe_endpoint(client.clone(), "codex", "Codex", "https://api.openai.com"),
        probe_endpoint(client, "updates", "更新", "https://github.com")
    );
    Ok(DiagnosticNetwork { codex, updates })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_report_hides_home_and_sensitive_values() {
        let home = Path::new("/Users/example-user");
        let environment = DiagnosticEnvironment {
            app_version: "2.5.3".to_string(),
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            codex: CommandDiagnostic {
                status: "unavailable".to_string(),
                path: Some("/Users/example-user/.cache/codex".to_string()),
                version: "unavailable".to_string(),
                reason: Some("token=sk-example-must-not-leak".to_string()),
            },
            ffmpeg: CommandDiagnostic {
                status: "ok".to_string(),
                path: Some("/opt/homebrew/bin/ffmpeg".to_string()),
                version: "ffmpeg version 7.1".to_string(),
                reason: None,
            },
            disk: DiskDiagnostic {
                status: "unsupported".to_string(),
                free_bytes: None,
                reason: "未対応".to_string(),
            },
            temporary_storage: TemporaryStorageDiagnostic {
                status: "ok".to_string(),
                total_bytes: Some(1024),
                warning: false,
                error_count: 0,
                reason: None,
            },
            report_text: String::new(),
        };

        let report = format_environment_report(&environment, Some(home));
        println!("{report}");
        let lower = report.to_ascii_lowercase();
        assert!(report.contains('~'));
        assert!(report.contains(".cache"));
        assert!(!report.contains("/Users/example-user"));
        assert!(!lower.contains("sk-"));
        assert!(!lower.contains("token"));
    }

    #[test]
    fn temporary_storage_total_excludes_non_deletable_app_data() {
        let mut breakdown = crate::storage_cleanup::StorageBreakdown::default();
        breakdown.sessions.deletable_bytes = 10;
        breakdown.logs.deletable_bytes = 20;
        breakdown.webview_cache.deletable_bytes = 30;
        breakdown.backups.deletable_bytes = 40;
        breakdown.broken_quarantine.deletable_bytes = 50;
        breakdown.app_data.bytes = 9_000;
        breakdown.common_codex.bytes = 8_000;
        breakdown.total_bytes = 17_150;

        assert_eq!(deletable_temporary_storage_bytes(&breakdown), 150);
    }
}
