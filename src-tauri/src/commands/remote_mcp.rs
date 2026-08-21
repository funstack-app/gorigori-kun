//! OAuth 対応のリモート HTTP MCP を共通の接続手順で扱う。
//!
//! このモジュールは登録・認証・切断・状態表示だけを担当する。各サービスの
//! ツール名や引数は実アカウントでの確認前に推測せず、専用生成 UI には配線しない。

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::codex::mcp_direct::reload_mcp_servers;
use crate::codex::mcp_shared::{
    entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_capture,
};
use crate::state::AppState;

const STATUS_TIMEOUT_SECS: u64 = 30;
const LOGIN_TIMEOUT_SECS: u64 = 180;

/// 接続可能なリモート MCP の正本。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProviderDef {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
}

pub static REMOTE_PROVIDERS: &[RemoteProviderDef] = &[
    RemoteProviderDef {
        id: "krea",
        label: "Krea",
        url: "https://api.krea.ai/mcp",
    },
    RemoteProviderDef {
        id: "runway",
        label: "Runway",
        url: "https://mcp.runwayml.com/mcp",
    },
    RemoteProviderDef {
        id: "bfl",
        label: "Black Forest Labs",
        url: "https://mcp.bfl.ai",
    },
    RemoteProviderDef {
        id: "ideogram",
        label: "Ideogram",
        url: "https://mcp.ideogram.ai/mcp",
    },
    RemoteProviderDef {
        id: "openart",
        label: "OpenArt",
        url: "https://mcp.openart.ai/mcp",
    },
    RemoteProviderDef {
        id: "pika",
        label: "Pika",
        url: "https://mcp.pika.me/api/mcp",
    },
    RemoteProviderDef {
        id: "kling",
        label: "Kling AI",
        url: "https://kling.ai/mcp",
    },
];

/// 1サービス分の接続状態。取得失敗時は全フィールド false に倒す。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpStatus {
    pub id: &'static str,
    pub registered: bool,
    pub authenticated: bool,
}

fn unavailable_statuses() -> Vec<RemoteMcpStatus> {
    REMOTE_PROVIDERS
        .iter()
        .map(|provider| RemoteMcpStatus {
            id: provider.id,
            registered: false,
            authenticated: false,
        })
        .collect()
}

fn statuses_from_stdout(stdout: &[u8]) -> Vec<RemoteMcpStatus> {
    REMOTE_PROVIDERS
        .iter()
        .map(|provider| {
            let entry = find_mcp_entry(stdout, provider.id);
            RemoteMcpStatus {
                id: provider.id,
                registered: entry.is_some(),
                authenticated: entry.as_ref().map(entry_is_authenticated).unwrap_or(false),
            }
        })
        .collect()
}

fn provider_by_id(provider_id: &str) -> Result<&'static RemoteProviderDef, String> {
    REMOTE_PROVIDERS
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("未対応のリモート MCP プロバイダです: {provider_id}"))
}

/// フロントへ接続可能なプロバイダ一覧を返す。
#[tauri::command]
pub fn remote_mcp_providers() -> Vec<RemoteProviderDef> {
    REMOTE_PROVIDERS.to_vec()
}

/// 全プロバイダの状態を、`codex mcp list --json` 1回の結果からまとめて返す。
/// codex 不在・spawn 失敗・タイムアウト・JSON 不正は、すべて未接続として扱う。
#[tauri::command]
pub async fn remote_mcp_status_all() -> Vec<RemoteMcpStatus> {
    let mut cmd = match gori_codex_command() {
        Ok(command) => command,
        Err(_) => return unavailable_statuses(),
    };
    cmd.args(["mcp", "list", "--json"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return unavailable_statuses(),
    };
    let output = match tokio::time::timeout(
        Duration::from_secs(STATUS_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => output,
        _ => return unavailable_statuses(),
    };

    statuses_from_stdout(&output.stdout)
}

async fn login_provider(provider_id: &str, state: &AppState) -> Result<String, String> {
    // 外部コマンドを起動する前に ID を検証する。未知 ID から任意の MCP 名を作らせない。
    let provider = provider_by_id(provider_id)?;

    // 既登録時の非ゼロ終了は握り、冪等に login まで進む。
    let add = run_codex_capture(
        &["mcp", "add", provider.id, "--url", provider.url],
        Duration::from_secs(STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| format!("{} MCP の登録に失敗しました: {error}", provider.label))?;
    if !add.0 {
        let lower = format!("{} {}", add.1, add.2).to_lowercase();
        let already_registered =
            lower.contains("already") || lower.contains("exist") || lower.contains("既に");
        if !already_registered {
            tracing::warn!(
                target: "remote_mcp",
                provider = provider.id,
                "mcp add 非ゼロ終了 (login で再試行): {}",
                add.2
            );
        }
    }

    let login = run_codex_capture(
        &["mcp", "login", provider.id],
        Duration::from_secs(LOGIN_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| format!("{} の認証に失敗しました: {error}", provider.label))?;

    if login.0 {
        reload_mcp_servers(state).await;
        Ok(if login.1.is_empty() {
            format!("{} の認証が完了しました。", provider.label)
        } else {
            login.1
        })
    } else if login.2.contains("missing required issuer") {
        Err(format!(
            "{} の認証に失敗しました。アプリ内の接続コンポーネントが見つからないか古い可能性があります。アプリを最新版に更新してから、もう一度お試しください。",
            provider.label
        ))
    } else if login.2.is_empty() {
        Err(format!(
            "{} の認証に失敗しました。ブラウザでのログインを完了したか確認してください。",
            provider.label
        ))
    } else {
        Err(format!(
            "{} の認証に失敗しました: {}",
            provider.label, login.2
        ))
    }
}

/// MCP を登録し、ブラウザ OAuth を開始する。
#[tauri::command]
pub async fn remote_mcp_login(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    login_provider(&provider_id, &state).await
}

/// MCP 登録を削除し、常駐 app-server の設定も読み直す。
#[tauri::command]
pub async fn remote_mcp_logout(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let provider = provider_by_id(&provider_id)?;
    let _ = run_codex_capture(
        &["mcp", "remove", provider.id],
        Duration::from_secs(STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| format!("{} の接続解除に失敗しました: {error}", provider.label))?;
    reload_mcp_servers(&state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_ids_are_unique() {
        let mut ids = HashSet::new();
        assert!(REMOTE_PROVIDERS
            .iter()
            .all(|provider| ids.insert(provider.id)));
    }

    #[test]
    fn registry_urls_are_https() {
        assert!(REMOTE_PROVIDERS
            .iter()
            .all(|provider| provider.url.starts_with("https://")));
    }

    #[tokio::test]
    async fn login_rejects_unknown_provider_before_spawning_codex() {
        let state = AppState::default();
        let result = login_provider("unknown-provider", &state).await;
        assert!(result.is_err());
    }
}
