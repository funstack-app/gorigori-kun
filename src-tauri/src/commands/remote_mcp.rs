//! OAuth 対応のリモート HTTP MCP を共通の接続手順で扱う。
//!
//! このモジュールは登録・認証・切断・状態表示だけを担当する。各サービスの
//! ツール名や引数は実アカウントでの確認前に推測せず、専用生成 UI には配線しない。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::codex::mcp_direct::{call_tool, reload_mcp_servers, ToolCallOutput};
use crate::codex::mcp_shared::{
    entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_capture,
};
use crate::state::AppState;

const STATUS_TIMEOUT_SECS: u64 = 30;
const LOGIN_TIMEOUT_SECS: u64 = 180;
const DISCOVERY_RAW_LIMIT_CHARS: usize = 4_000;
const DISCOVERY_DIR_NAME: &str = "provider-discovery";
const DISCOVERY_PROBE_TOOL: &str = "__gori_probe__";

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
    // 2026-08-22 追加調査分 (STΛCK候補5件のうちOAuth対応の2件。
    // Vidu/PixVerse はAPIキー式ローカルMCPのみ、TapNow はMCP自体なしで見送り)。
    // 両URLとも JSON-RPC initialize POST で 401 (=実在・OAuth保護) を実測確認済み。
    RemoteProviderDef {
        id: "pollo",
        label: "Pollo AI",
        url: "https://mcp.pollo.ai/mcp",
    },
    RemoteProviderDef {
        id: "topview",
        label: "TopView",
        url: "https://mcp.topview.ai/mcp",
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

/// 1回の実測結果。UI向けキャッシュでは raw を4,000文字までに抑える。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpDiscoveryAttempt {
    pub tool: String,
    pub ok: bool,
    pub raw: String,
}

/// MCP応答から、推測せずに読み取れたモデル名だけを保持する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpDiscoveredModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// 1プロバイダ分のディスカバリ結果。app data_dir に同じ形で保存する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpDiscovery {
    pub provider_id: String,
    pub attempts: Vec<RemoteMcpDiscoveryAttempt>,
    pub models: Vec<RemoteMcpDiscoveredModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscoveryLog<'a> {
    provider_id: &'a str,
    recorded_at_ms: u128,
    attempts: &'a [RemoteMcpDiscoveryAttempt],
}

#[derive(Debug, Clone, Copy)]
struct DiscoveryTool {
    name: &'static str,
    is_model_list: bool,
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

/// 読み取り専用の候補だけを返す。生成系ツールは課金防止のため絶対に含めない。
fn discovery_tools(provider_id: &str) -> Vec<DiscoveryTool> {
    let (model_tools, balance_tools): (&[&str], &[&str]) = match provider_id {
        "krea" => (&["list_models"], &["account_balance", "balance"]),
        "pollo" => (&["list_models", "models"], &["balance", "credits"]),
        "runway" => (
            &["list_models", "models", "get_models"],
            &["credits", "balance", "organization"],
        ),
        _ => (
            &["list_models", "models_explore", "models_list"],
            &["balance", "account_balance", "credits"],
        ),
    };

    model_tools
        .iter()
        .map(|name| DiscoveryTool {
            name,
            is_model_list: true,
        })
        .chain(balance_tools.iter().map(|name| DiscoveryTool {
            name,
            is_model_list: false,
        }))
        .collect()
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn first_field(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(scalar_string))
}

fn model_from_value(value: &Value) -> Option<RemoteMcpDiscoveredModel> {
    if let Some(value) = scalar_string(value) {
        return Some(RemoteMcpDiscoveredModel {
            id: value.clone(),
            name: value,
            label: None,
        });
    }

    let object = value.as_object()?;
    let id = first_field(
        object,
        &[
            "id",
            "modelId",
            "model_id",
            "slug",
            "value",
            "name",
            "displayName",
            "display_name",
            "label",
        ],
    );
    let name = first_field(
        object,
        &[
            "name",
            "displayName",
            "display_name",
            "label",
            "title",
            "id",
            "modelId",
            "model_id",
            "slug",
            "value",
        ],
    );
    let label = first_field(object, &["label", "displayName", "display_name", "title"]);
    let id = id.or_else(|| name.clone())?;
    let name = name.unwrap_or_else(|| id.clone());

    Some(RemoteMcpDiscoveredModel { id, name, label })
}

fn collect_model_values(value: &Value, models: &mut Vec<RemoteMcpDiscoveredModel>) {
    match value {
        Value::Array(values) => models.extend(values.iter().filter_map(model_from_value)),
        Value::Object(object) => {
            if let Some(model) = model_from_value(value) {
                models.push(model);
            }
            for key in ["models", "data", "results", "items"] {
                if let Some(nested) = object.get(key) {
                    collect_model_values(nested, models);
                }
            }
        }
        _ => {}
    }
}

/// models/data/results/items の多様な応答形から、明示された文字列だけを抽出する。
/// 説明文からモデル名を推測することはしない。
fn extract_models(value: &Value) -> Vec<RemoteMcpDiscoveredModel> {
    let mut models = Vec::new();
    match value {
        Value::Array(_) => collect_model_values(value, &mut models),
        Value::Object(object) => {
            for key in ["models", "data", "results", "items"] {
                if let Some(nested) = object.get(key) {
                    collect_model_values(nested, &mut models);
                }
            }
        }
        _ => {}
    }

    let mut unique = std::collections::HashSet::new();
    models.retain(|model| unique.insert((model.id.clone(), model.name.clone())));
    models
}

fn extract_models_from_output(output: &ToolCallOutput) -> Vec<RemoteMcpDiscoveredModel> {
    let mut models = output
        .structured
        .as_ref()
        .map(extract_models)
        .unwrap_or_default();
    if let Ok(text_json) = serde_json::from_str::<Value>(&output.text) {
        models.extend(extract_models(&text_json));
    }
    let mut unique = std::collections::HashSet::new();
    models.retain(|model| unique.insert((model.id.clone(), model.name.clone())));
    models
}

fn tool_output_raw(output: &ToolCallOutput) -> String {
    serde_json::to_string(&json!({
        "isError": output.is_error,
        "structuredContent": output.structured,
        "contentText": output.text,
    }))
    .unwrap_or_else(|error| format!("tool/call 応答のJSON化に失敗しました: {error}"))
}

fn truncate_raw(raw: &str) -> String {
    raw.chars().take(DISCOVERY_RAW_LIMIT_CHARS).collect()
}

fn discovery_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DISCOVERY_DIR_NAME))
        .map_err(|error| format!("プロバイダ実測結果の保存先を取得できませんでした: {error}"))
}

fn persist_discovery(
    app: &AppHandle,
    discovery: &RemoteMcpDiscovery,
    raw_attempts: &[RemoteMcpDiscoveryAttempt],
) -> Result<(), String> {
    let dir = discovery_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("プロバイダ実測結果の保存先を作成できませんでした: {error}"))?;

    let raw_path = dir.join(format!("{}.raw.jsonl", discovery.provider_id));
    let mut raw_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&raw_path)
        .map_err(|error| format!("プロバイダ実測ログを開けませんでした: {error}"))?;
    let recorded_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    serde_json::to_writer(
        &mut raw_file,
        &RawDiscoveryLog {
            provider_id: &discovery.provider_id,
            recorded_at_ms,
            attempts: raw_attempts,
        },
    )
    .map_err(|error| format!("プロバイダ実測ログをJSON化できませんでした: {error}"))?;
    raw_file
        .write_all(b"\n")
        .map_err(|error| format!("プロバイダ実測ログを保存できませんでした: {error}"))?;

    // 一次資料の追記に成功した後で、UI向けの短いキャッシュを差し替える。
    let cache_path = dir.join(format!("{}.json", discovery.provider_id));
    let cache = serde_json::to_vec_pretty(discovery)
        .map_err(|error| format!("プロバイダ実測結果をJSON化できませんでした: {error}"))?;
    fs::write(&cache_path, cache)
        .map_err(|error| format!("プロバイダ実測結果を保存できませんでした: {error}"))?;
    Ok(())
}

fn remove_output_is_already_absent(stdout: &str, stderr: &str) -> bool {
    let output = format!("{stdout}\n{stderr}").to_lowercase();
    [
        "not found",
        "unknown",
        "does not exist",
        "doesn't exist",
        "not registered",
        "見つからない",
        "見つかりません",
        "存在しない",
        "未登録",
    ]
    .iter()
    .any(|message| output.contains(message))
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

/// 不正ツール名と読み取り専用候補を実際に call し、モデル一覧を推測なしで抽出する。
#[tauri::command]
pub async fn remote_mcp_discover(
    provider_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RemoteMcpDiscovery, String> {
    let provider = provider_by_id(&provider_id)?;
    let tools = std::iter::once(DiscoveryTool {
        name: DISCOVERY_PROBE_TOOL,
        is_model_list: false,
    })
    .chain(discovery_tools(provider.id));
    let mut attempts = Vec::new();
    let mut raw_attempts = Vec::new();
    let mut models = Vec::new();

    for tool in tools {
        let (ok, raw, extracted) = match call_tool(&state, provider.id, tool.name, json!({})).await
        {
            Ok(output) => {
                let ok = !output.is_error;
                let extracted = if ok && tool.is_model_list {
                    extract_models_from_output(&output)
                } else {
                    Vec::new()
                };
                (ok, tool_output_raw(&output), extracted)
            }
            Err(error) => (false, error, Vec::new()),
        };
        models.extend(extracted);
        raw_attempts.push(RemoteMcpDiscoveryAttempt {
            tool: tool.name.to_string(),
            ok,
            raw: raw.clone(),
        });
        attempts.push(RemoteMcpDiscoveryAttempt {
            tool: tool.name.to_string(),
            ok,
            raw: truncate_raw(&raw),
        });
    }

    let mut unique = std::collections::HashSet::new();
    models.retain(|model| unique.insert((model.id.clone(), model.name.clone())));
    let discovery = RemoteMcpDiscovery {
        provider_id,
        attempts,
        models,
    };
    persist_discovery(&app, &discovery, &raw_attempts)?;
    Ok(discovery)
}

/// 前回の実測キャッシュを返す。未実測なら null、壊れたキャッシュは明示エラーにする。
#[tauri::command]
pub fn remote_mcp_discovery_cached(
    provider_id: String,
    app: AppHandle,
) -> Result<Option<RemoteMcpDiscovery>, String> {
    let provider = provider_by_id(&provider_id)?;
    let path = discovery_dir(&app)?.join(format!("{}.json", provider.id));
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "{} の保存済み実測結果を読めませんでした: {error}",
                provider.label
            ))
        }
    };
    serde_json::from_slice(&raw).map(Some).map_err(|error| {
        format!(
            "{} の保存済み実測結果が壊れています: {error}",
            provider.label
        )
    })
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
    let remove = run_codex_capture(
        &["mcp", "remove", provider.id],
        Duration::from_secs(STATUS_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| format!("{} の接続解除に失敗しました: {error}", provider.label))?;

    if !remove.0 && !remove_output_is_already_absent(&remove.1, &remove.2) {
        let detail = if remove.2.trim().is_empty() {
            remove.1.trim()
        } else {
            remove.2.trim()
        };
        return Err(if detail.is_empty() {
            format!("{} の接続解除に失敗しました。", provider.label)
        } else {
            format!("{} の接続解除に失敗しました: {detail}", provider.label)
        });
    }

    reload_mcp_servers(&state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn discovered_model(id: &str, name: &str, label: Option<&str>) -> RemoteMcpDiscoveredModel {
        RemoteMcpDiscoveredModel {
            id: id.to_string(),
            name: name.to_string(),
            label: label.map(str::to_string),
        }
    }

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

    #[test]
    fn remove_absent_detection_keeps_logout_idempotent() {
        for message in [
            "MCP server not found",
            "Unknown MCP server",
            "登録が見つかりません",
            "プロバイダは存在しない",
        ] {
            assert!(remove_output_is_already_absent("", message));
        }
    }

    #[test]
    fn remove_absent_detection_does_not_hide_other_failures() {
        assert!(!remove_output_is_already_absent(
            "",
            "permission denied while updating config"
        ));
    }

    #[test]
    fn extract_models_supports_models_object_array() {
        assert_eq!(
            extract_models(&json!({"models": [{"id": "flux-1", "name": "FLUX 1"}]})),
            vec![discovered_model("flux-1", "FLUX 1", None)]
        );
    }

    #[test]
    fn extract_models_supports_data_array_and_alternate_keys() {
        assert_eq!(
            extract_models(&json!({"data": [{"model_id": "gen-4", "display_name": "Gen-4"}]})),
            vec![discovered_model("gen-4", "Gen-4", Some("Gen-4"))]
        );
    }

    #[test]
    fn extract_models_supports_string_arrays() {
        assert_eq!(
            extract_models(&json!(["model-a", "model-b"])),
            vec![
                discovered_model("model-a", "model-a", None),
                discovered_model("model-b", "model-b", None),
            ]
        );
    }

    #[test]
    fn extract_models_returns_empty_for_unknown_shape() {
        assert!(extract_models(&json!({"message": "no model list here"})).is_empty());
    }

    #[test]
    fn raw_response_is_truncated_by_unicode_character_count() {
        let raw = "餅".repeat(DISCOVERY_RAW_LIMIT_CHARS + 10);
        let truncated = truncate_raw(&raw);
        assert_eq!(truncated.chars().count(), DISCOVERY_RAW_LIMIT_CHARS);
        assert!(truncated.chars().all(|character| character == '餅'));
    }

    #[tokio::test]
    async fn login_rejects_unknown_provider_before_spawning_codex() {
        let state = AppState::default();
        let result = login_provider("unknown-provider", &state).await;
        assert!(result.is_err());
    }
}
