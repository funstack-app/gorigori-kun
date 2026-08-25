//! OAuth 対応のリモート HTTP MCP を共通の接続手順で扱う。
//!
//! このモジュールは登録・認証・切断・状態表示だけを担当する。各サービスの
//! ツール名や引数は実アカウントでの確認前に推測せず、専用生成 UI には配線しない。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::codex::mcp_direct::{
    call_tool, call_tool_with_timeout, list_mcp_server_status_page, reload_mcp_servers,
    ToolCallOutput,
};
use crate::codex::mcp_shared::{
    entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_capture,
};
use crate::state::AppState;

const STATUS_TIMEOUT_SECS: u64 = 30;
const LOGIN_TIMEOUT_SECS: u64 = 180;
const DISCOVERY_RAW_LIMIT_CHARS: usize = 4_000;
const DISCOVERY_RAW_RECORD_MAX_BYTES: usize = 64 * 1024;
const DISCOVERY_RAW_FILE_MAX_BYTES: u64 = 512 * 1024;
const DISCOVERY_DIR_NAME: &str = "provider-discovery";
const DISCOVERY_PROBE_TOOL: &str = "__gori_probe__";
const REMOTE_MCP_GEN_EVENT: &str = "remote-mcp-gen";
const IMAGE_GENERATION_TIMEOUT_SECS: u64 = 5 * 60;
const VIDEO_GENERATION_TIMEOUT_SECS: u64 = 15 * 60;
const REMOTE_QUERY_TIMEOUT_SECS: u64 = 60;
const REMOTE_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const REMOTE_DOWNLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;
const REMOTE_DOWNLOAD_REDIRECT_LIMIT: usize = 5;
const GENERATION_MESSAGE_LIMIT_CHARS: usize = 4_000;
const PROCESSING_FOLLOW_UP_DELAYS_SECS: [u64; 2] = [30, 60];
const MAX_REMOTE_COUNT: u32 = 30;
const REMOTE_DOWNLOAD_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const REMOTE_DOWNLOAD_RETRY_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36";
static REMOTE_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

/// app-server が返す MCP ツール定義のフロント向け最小形。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpToolDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema_json: String,
}

/// 1プロバイダ分の正規ツール一覧。provider-discovery/{id}.tools.json にも保存する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpToolList {
    pub provider_id: String,
    pub auth_status: String,
    pub tools: Vec<RemoteMcpToolDefinition>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMcpMediaKind {
    Image,
    Video,
}

impl RemoteMcpMediaKind {
    fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Self::Image => IMAGE_GENERATION_TIMEOUT_SECS,
            Self::Video => VIDEO_GENERATION_TIMEOUT_SECS,
        })
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Image => "画像",
            Self::Video => "動画",
        }
    }
}

fn clamp_remote_count(count: Option<u32>) -> u32 {
    count.unwrap_or(1).clamp(1, MAX_REMOTE_COUNT)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpGenerateResult {
    pub saved_paths: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpSlotResult {
    pub slot: u32,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// モデル一覧など、読み取り用途の tool/call 応答。ディスクには保存しない。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMcpQueryResult {
    pub content_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMcpGenerateEvent {
    request_id: String,
    provider_id: String,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot_results: Option<Vec<RemoteMcpSlotResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    errors: Option<Vec<String>>,
}

fn aggregate_slot_results(slots: &[RemoteMcpSlotResult]) -> (Vec<String>, Vec<String>) {
    let mut slots = slots.to_vec();
    slots.sort_by_key(|slot| slot.slot);

    let saved_paths = slots
        .iter()
        .filter(|slot| slot.status == "done")
        .filter_map(|slot| slot.saved_path.clone())
        .collect();
    let errors = slots
        .iter()
        .filter(|slot| slot.status == "failed")
        .map(|slot| {
            let error = slot.error.as_deref().unwrap_or("生成に失敗しました");
            sanitize_generation_message(&format!("枠{}: {error}", slot.slot))
        })
        .collect();

    (saved_paths, errors)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RemoteArtifactSource {
    InlineImage {
        mime_type: String,
        data_base64: String,
    },
    Url(String),
    LocalPath(String),
}

#[derive(Debug, Default)]
struct ArtifactSourceCandidates {
    preferred: Vec<RemoteArtifactSource>,
    fallback: Vec<RemoteArtifactSource>,
}

impl ArtifactSourceCandidates {
    fn push_preferred(&mut self, source: RemoteArtifactSource) {
        push_unique_source(&mut self.preferred, source);
    }

    fn push_fallback(&mut self, source: RemoteArtifactSource) {
        if !self.preferred.contains(&source) {
            push_unique_source(&mut self.fallback, source);
        }
    }

    fn into_best(self) -> Vec<RemoteArtifactSource> {
        if self.preferred.is_empty() {
            self.fallback
        } else {
            self.preferred
        }
    }
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

/// 統一生成一覧にだけ存在する専用接続も含め、生成ターンで使える MCP 名を検証する。
/// Magnific を `REMOTE_PROVIDERS` に足すと接続UIへ重複表示されるため、ここだけで扱う。
fn generation_provider(provider_id: &str) -> Result<(&'static str, &'static str), String> {
    if provider_id == "magnific" {
        return Ok(("magnific", "Magnific"));
    }
    provider_by_id(provider_id).map(|provider| (provider.id, provider.label))
}

/// 読み取り専用の候補だけを返す。生成系ツールは課金防止のため絶対に含めない。
fn discovery_tools(provider_id: &str) -> Vec<DiscoveryTool> {
    let (model_tools, balance_tools): (&[&str], &[&str]) = match provider_id {
        "krea" => (&["list_models"], &["account_balance", "balance"]),
        "pollo" => (
            &["pollo_list_models", "list_models", "models"],
            &[
                "pollo_show_plans_and_credits",
                "pollo_account_status",
                "balance",
                "credits",
            ],
        ),
        "bfl" => (
            &["list_models", "models_explore", "models_list"],
            &["get_credits", "credits", "balance"],
        ),
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

fn sanitize_discovery_raw(raw: &str, home: Option<&Path>) -> String {
    super::diagnostics::redact_text(raw, home)
}

fn bounded_raw_log_line(
    provider_id: &str,
    recorded_at_ms: u128,
    attempts: &[RemoteMcpDiscoveryAttempt],
) -> Result<Vec<u8>, String> {
    let mut bounded = Vec::new();
    for attempt in attempts {
        let mut attempt = attempt.clone();
        attempt.raw = truncate_raw(&attempt.raw);
        bounded.push(attempt);
        let candidate = serde_json::to_vec(&RawDiscoveryLog {
            provider_id,
            recorded_at_ms,
            attempts: &bounded,
        })
        .map_err(|error| format!("プロバイダ実測ログをJSON化できませんでした: {error}"))?;
        if candidate.len().saturating_add(1) > DISCOVERY_RAW_RECORD_MAX_BYTES {
            bounded.pop();
            break;
        }
    }

    let mut line = serde_json::to_vec(&RawDiscoveryLog {
        provider_id,
        recorded_at_ms,
        attempts: &bounded,
    })
    .map_err(|error| format!("プロバイダ実測ログをJSON化できませんでした: {error}"))?;
    line.push(b'\n');
    Ok(line)
}

fn discovery_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DISCOVERY_DIR_NAME))
        .map_err(|error| format!("プロバイダ実測結果の保存先を取得できませんでした: {error}"))
}

fn tool_list_from_server(provider_id: &str, server: &Value) -> Result<RemoteMcpToolList, String> {
    let auth_status = server
        .get("authStatus")
        .and_then(Value::as_str)
        .ok_or_else(|| "MCP 一覧の authStatus が不正です".to_string())?
        .to_string();
    let tool_map = server
        .get("tools")
        .and_then(Value::as_object)
        .ok_or_else(|| "MCP 一覧の tools が不正です".to_string())?;
    let mut tools = Vec::with_capacity(tool_map.len());
    for (map_name, tool) in tool_map {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| format!("MCP ツール {map_name} の name が不正です"))?;
        let input_schema = tool
            .get("inputSchema")
            .ok_or_else(|| format!("MCP ツール {name} に inputSchema がありません"))?;
        tools.push(RemoteMcpToolDefinition {
            name: name.to_string(),
            title: tool
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            input_schema_json: serde_json::to_string(input_schema).map_err(|error| {
                format!("MCP ツール {name} の inputSchema をJSON化できませんでした: {error}")
            })?,
        });
    }
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(RemoteMcpToolList {
        provider_id: provider_id.to_string(),
        auth_status,
        tools,
    })
}

fn persist_tool_list(app: &AppHandle, list: &RemoteMcpToolList) -> Result<(), String> {
    let dir = discovery_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("MCP ツール一覧の保存先を作成できませんでした: {error}"))?;
    let path = dir.join(format!("{}.tools.json", list.provider_id));
    let cache = serde_json::to_vec_pretty(list)
        .map_err(|error| format!("MCP ツール一覧をJSON化できませんでした: {error}"))?;
    fs::write(path, cache).map_err(|error| format!("MCP ツール一覧を保存できませんでした: {error}"))
}

fn should_persist_tool_list(list: &RemoteMcpToolList) -> bool {
    !list.tools.is_empty()
}

fn remove_tool_list_cache(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "保存済みのモデル情報を消去できませんでした: {error}"
        )),
    }
}

fn push_unique_source(sources: &mut Vec<RemoteArtifactSource>, source: RemoteArtifactSource) {
    if !sources.contains(&source) {
        sources.push(source);
    }
}

fn data_uri_source(value: &str) -> Option<RemoteArtifactSource> {
    let value = value.trim();
    let rest = value.strip_prefix("data:image/")?;
    let (subtype, data_base64) = rest.split_once(";base64,")?;
    if subtype.is_empty() || data_base64.trim().is_empty() {
        return None;
    }
    Some(RemoteArtifactSource::InlineImage {
        mime_type: format!("image/{subtype}"),
        data_base64: data_base64.trim().to_string(),
    })
}

/// 自由文に含まれる https URL を抽出する。ネットワークには触れない純粋な解析関数。
fn https_urls_in_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut offset = 0;
    while let Some(relative) = text[offset..].find("https://") {
        let start = offset + relative;
        let tail = &text[start..];
        let end = tail
            .char_indices()
            .skip(1)
            .find_map(|(index, character)| {
                (character.is_whitespace()
                    || matches!(
                        character,
                        '"' | '\'' | '<' | '>' | '`' | ')' | ']' | '}' | ',' | ';'
                    ))
                .then_some(index)
            })
            .unwrap_or(tail.len());
        let candidate = tail[..end].trim_end_matches(['.', ';', ':', '!', '?']);
        if let Ok(parsed) = reqwest::Url::parse(candidate) {
            if parsed.scheme() == "https" && parsed.host_str().is_some() {
                let normalized = parsed.to_string();
                if !urls.contains(&normalized) {
                    urls.push(normalized);
                }
            }
        }
        offset = start + end.max("https://".len());
    }
    urls
}

fn validated_https_url(value: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| "ダウンロードURLの形式が正しくありません".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("HTTPS以外のダウンロードURLは拒否しました".to_string());
    }
    Ok(parsed)
}

fn normalized_field_name(field_name: Option<&str>) -> String {
    field_name
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_download_field(field_name: Option<&str>) -> bool {
    normalized_field_name(field_name).contains("download")
}

fn is_direct_url_field(field_name: Option<&str>) -> bool {
    let field_name = normalized_field_name(field_name);
    if field_name.contains("web")
        || field_name.contains("share")
        || field_name.contains("preview")
        || field_name.contains("page")
    {
        return false;
    }
    matches!(field_name.as_str(), "url" | "uri" | "href" | "src") || field_name.ends_with("url")
}

fn has_known_media_extension(url: &str) -> bool {
    extension_from_url(RemoteMcpMediaKind::Image, url).is_some()
        || extension_from_url(RemoteMcpMediaKind::Video, url).is_some()
}

fn has_shared_page_path(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let path = parsed.path().to_ascii_lowercase();
    [
        "/creations/",
        "/creation/",
        "/share/",
        "/preview/",
        "/view/",
    ]
    .iter()
    .any(|pattern| path.contains(pattern))
}

fn is_likely_shared_page_url(url: &str) -> bool {
    has_shared_page_path(url) || !has_known_media_extension(url)
}

fn collect_url_candidates(
    text: &str,
    kind: RemoteMcpMediaKind,
    field_name: Option<&str>,
    candidates: &mut ArtifactSourceCandidates,
) {
    let download_field = is_download_field(field_name);
    let direct_url_field = is_direct_url_field(field_name);
    for url in https_urls_in_text(text) {
        let source = RemoteArtifactSource::Url(url.clone());
        if extension_from_url(kind, &url).is_some()
            || ((download_field || direct_url_field) && !has_shared_page_path(&url))
        {
            candidates.push_preferred(source);
        } else if !has_known_media_extension(&url) {
            // 拡張子の無いURLは共有ページかもしれないため、直リンクが無い場合だけ使う。
            candidates.push_fallback(source);
        }
        // 別メディア種別の明示的な拡張子は成果物ではないので採用しない。
    }
}

fn collect_value_sources(
    value: &Value,
    kind: RemoteMcpMediaKind,
    field_name: Option<&str>,
    candidates: &mut ArtifactSourceCandidates,
) {
    match value {
        Value::String(text) => {
            if kind == RemoteMcpMediaKind::Image {
                if let Some(source) = data_uri_source(text) {
                    candidates.push_preferred(source);
                }
            }
            collect_url_candidates(text, kind, field_name, candidates);
            if matches!(text.trim().as_bytes().first(), Some(b'{') | Some(b'[')) {
                if let Ok(nested) = serde_json::from_str::<Value>(text) {
                    collect_value_sources(&nested, kind, None, candidates);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_value_sources(value, kind, field_name, candidates);
            }
        }
        Value::Object(object) => {
            if kind == RemoteMcpMediaKind::Image
                && object.get("type").and_then(Value::as_str) == Some("image")
            {
                let data = object.get("data").and_then(Value::as_str);
                let mime_type = object
                    .get("mimeType")
                    .or_else(|| object.get("mime_type"))
                    .and_then(Value::as_str);
                if let (Some(data_base64), Some(mime_type)) = (data, mime_type) {
                    let source = data_uri_source(data_base64).unwrap_or_else(|| {
                        RemoteArtifactSource::InlineImage {
                            mime_type: mime_type.to_string(),
                            data_base64: data_base64.to_string(),
                        }
                    });
                    candidates.push_preferred(source);
                }
            }
            for (key, value) in object {
                collect_value_sources(value, kind, Some(key), candidates);
            }
        }
        _ => {}
    }
}

fn extension_from_local_path(kind: RemoteMcpMediaKind, path: &Path) -> Option<&'static str> {
    let extension = path.extension().and_then(|value| value.to_str())?;
    match (kind, extension.to_ascii_lowercase().as_str()) {
        (RemoteMcpMediaKind::Image, "png") => Some("png"),
        (RemoteMcpMediaKind::Image, "jpg" | "jpeg") => Some("jpg"),
        (RemoteMcpMediaKind::Image, "webp") => Some("webp"),
        (RemoteMcpMediaKind::Video, "mp4") => Some("mp4"),
        (RemoteMcpMediaKind::Video, "mov") => Some("mov"),
        (RemoteMcpMediaKind::Video, "webm") => Some("webm"),
        (RemoteMcpMediaKind::Video, "m4v") => Some("m4v"),
        _ => None,
    }
}

fn normalized_local_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn push_local_path_if_artifact(
    value: &str,
    kind: RemoteMcpMediaKind,
    excluded_paths: &std::collections::HashSet<String>,
    sources: &mut Vec<RemoteArtifactSource>,
) {
    let trimmed = value.trim().trim_matches(|character| {
        matches!(
            character,
            '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
        )
    });
    let path = if let Some(file_url) = trimmed.strip_prefix("file://") {
        Path::new(file_url)
    } else {
        Path::new(trimmed)
    };
    if !path.is_absolute() || !path.is_file() || extension_from_local_path(kind, path).is_none() {
        return;
    }
    let normalized = normalized_local_path(path);
    if !excluded_paths.contains(&normalized) {
        push_unique_source(sources, RemoteArtifactSource::LocalPath(normalized));
    }
}

fn collect_local_artifact_sources(
    value: &Value,
    kind: RemoteMcpMediaKind,
    excluded_paths: &std::collections::HashSet<String>,
    sources: &mut Vec<RemoteArtifactSource>,
) {
    match value {
        Value::String(text) => {
            push_local_path_if_artifact(text, kind, excluded_paths, sources);
            for token in text.split_whitespace() {
                push_local_path_if_artifact(token, kind, excluded_paths, sources);
            }
            if matches!(text.trim().as_bytes().first(), Some(b'{') | Some(b'[')) {
                if let Ok(nested) = serde_json::from_str::<Value>(text) {
                    collect_local_artifact_sources(&nested, kind, excluded_paths, sources);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_local_artifact_sources(value, kind, excluded_paths, sources);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_local_artifact_sources(value, kind, excluded_paths, sources);
            }
        }
        _ => {}
    }
}

fn provider_output_error(output: &ToolCallOutput) -> String {
    if !output.text.trim().is_empty() {
        return output.text.trim().to_string();
    }
    output
        .structured
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "プロバイダがエラーを返しました".to_string())
}

/// MCP content / resource / structuredContent から保存候補を優先度つきで取り出す。
fn extract_remote_artifact_candidates(
    output: &ToolCallOutput,
    kind: RemoteMcpMediaKind,
) -> Result<ArtifactSourceCandidates, String> {
    if output.is_error {
        return Err(provider_output_error(output));
    }

    let mut candidates = ArtifactSourceCandidates::default();
    for item in &output.content {
        if kind == RemoteMcpMediaKind::Image
            && item.get("type").and_then(Value::as_str) == Some("image")
        {
            let data = item.get("data").and_then(Value::as_str);
            let mime_type = item
                .get("mimeType")
                .or_else(|| item.get("mime_type"))
                .and_then(Value::as_str);
            if let (Some(data_base64), Some(mime_type)) = (data, mime_type) {
                let source = data_uri_source(data_base64).unwrap_or_else(|| {
                    RemoteArtifactSource::InlineImage {
                        mime_type: mime_type.to_string(),
                        data_base64: data_base64.to_string(),
                    }
                });
                candidates.push_preferred(source);
            }
        }
        collect_value_sources(item, kind, None, &mut candidates);
    }
    if let Some(structured) = output.structured.as_ref() {
        collect_value_sources(structured, kind, None, &mut candidates);
    }
    collect_value_sources(
        &Value::String(output.text.clone()),
        kind,
        None,
        &mut candidates,
    );

    if candidates.preferred.is_empty() && candidates.fallback.is_empty() {
        Err(format!(
            "MCP 応答に保存できる{}データまたは https URL がありませんでした",
            kind.noun()
        ))
    } else {
        Ok(candidates)
    }
}

/// 単独の tool/call では、直リンクが1件でもあれば共有ページ候補を捨てる。
fn extract_remote_artifacts(
    output: &ToolCallOutput,
    kind: RemoteMcpMediaKind,
) -> Result<Vec<RemoteArtifactSource>, String> {
    extract_remote_artifact_candidates(output, kind).map(ArtifactSourceCandidates::into_best)
}

fn tool_call_output_from_value(value: &Value) -> ToolCallOutput {
    if let Value::String(text) = value {
        if matches!(text.trim().as_bytes().first(), Some(b'{') | Some(b'[')) {
            if let Ok(nested) = serde_json::from_str::<Value>(text) {
                return tool_call_output_from_value(&nested);
            }
        }
        return ToolCallOutput {
            content: Vec::new(),
            structured: None,
            text: text.to_string(),
            is_error: false,
        };
    }

    let content = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let structured = value
        .get("structuredContent")
        .or_else(|| value.get("structured_content"))
        .cloned()
        .filter(|value| !value.is_null())
        .or_else(|| Some(value.clone()));
    let is_error = value
        .get("isError")
        .or_else(|| value.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ToolCallOutput {
        content,
        structured,
        text,
        is_error,
    }
}

fn is_provider_tool_item(item: &Value, provider_id: &str) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("mcpToolCall") => item
            .get("server")
            .and_then(Value::as_str)
            .map(|server| server.eq_ignore_ascii_case(provider_id))
            .unwrap_or(true),
        Some("dynamicToolCall") => item
            .get("tool")
            .or_else(|| item.get("name"))
            .and_then(Value::as_str)
            .map(|tool| {
                tool.to_ascii_lowercase()
                    .contains(&provider_id.to_ascii_lowercase())
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn is_completion_check_tool_item(item: &Value) -> bool {
    let tool_name = item
        .get("tool")
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default();
    ["wait", "result", "status"]
        .iter()
        .any(|marker| tool_name.contains(marker))
}

fn tool_result_values(item: &Value) -> Vec<&Value> {
    ["result", "output", "contentItems"]
        .into_iter()
        .filter_map(|key| item.get(key))
        .collect()
}

fn compact_tool_error(value: &Value) -> String {
    for key in ["message", "error", "text", "detail"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
        if let Some(nested) = value.get(key) {
            let text = compact_tool_error(nested);
            if !text.is_empty() {
                return text;
            }
        }
    }
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// app-server の item 列から、MCP ツール結果だけを機械的に走査する。
/// 引数や agentMessage は混ぜず、参照素材そのものを成果物と誤認しない。
fn extract_llm_tool_artifact_candidates(
    items: &[Value],
    provider_id: &str,
    kind: RemoteMcpMediaKind,
    reference_paths: &[String],
) -> (ArtifactSourceCandidates, Vec<String>) {
    let excluded_paths = reference_paths
        .iter()
        .map(Path::new)
        .map(normalized_local_path)
        .collect::<std::collections::HashSet<_>>();
    let mut candidates = ArtifactSourceCandidates::default();
    let mut completion_urls = Vec::new();
    let mut errors = Vec::new();

    for item in items
        .iter()
        .filter(|item| is_provider_tool_item(item, provider_id))
    {
        let completion_check_tool = is_completion_check_tool_item(item);
        let item_failed = item.get("status").and_then(Value::as_str) == Some("failed");
        let results = tool_result_values(item);
        if item_failed && results.is_empty() {
            let error = compact_tool_error(item);
            if !error.is_empty() && !errors.contains(&error) {
                errors.push(error);
            }
        }

        for result in results {
            let completion_result =
                completion_check_tool || value_has_explicit_completed_status(result);
            let output = tool_call_output_from_value(result);
            let result_failed = output.is_error
                || item_failed
                || result.get("error").is_some_and(|error| !error.is_null());
            if result_failed {
                let error = if output.text.trim().is_empty() {
                    compact_tool_error(result)
                } else {
                    provider_output_error(&output)
                };
                if !error.is_empty() && !errors.contains(&error) {
                    errors.push(error);
                }
                continue;
            }
            if let Ok(found) = extract_remote_artifact_candidates(&output, kind) {
                for source in found.preferred {
                    if completion_result && matches!(source, RemoteArtifactSource::Url(_)) {
                        push_unique_source(&mut completion_urls, source.clone());
                    }
                    candidates.push_preferred(source);
                }
                for source in found.fallback {
                    candidates.push_fallback(source);
                }
            }
            let mut local_sources = Vec::new();
            collect_local_artifact_sources(result, kind, &excluded_paths, &mut local_sources);
            for source in local_sources {
                candidates.push_preferred(source);
            }
        }
    }

    if !completion_urls.is_empty() {
        for source in std::mem::take(&mut candidates.preferred) {
            push_unique_source(&mut completion_urls, source);
        }
        candidates.preferred = completion_urls;
    }

    (candidates, errors)
}

fn extract_llm_tool_artifacts(
    items: &[Value],
    provider_id: &str,
    kind: RemoteMcpMediaKind,
    reference_paths: &[String],
) -> (Vec<RemoteArtifactSource>, Vec<String>) {
    let (candidates, errors) =
        extract_llm_tool_artifact_candidates(items, provider_id, kind, reference_paths);
    (candidates.into_best(), errors)
}

/// 既知のプロバイダ側エラーを日常語へ翻訳する（原文は詳細として残す）。
fn humanize_provider_failure(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("content_policy") || lower.contains("moderation") {
        return Some(
            "生成先サービスの安全フィルターが、この内容の生成を拒否しました。表現を変えて再試行してください",
        );
    }
    if lower.contains("insufficient") && lower.contains("credit") {
        return Some("生成先サービスのクレジット残高が不足しています");
    }
    if lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
    {
        return Some("生成先サービスの回数制限に達しました。少し待ってから再試行してください");
    }
    None
}

fn llm_failure_message(summary: &str, final_message: &str, tool_errors: &[String]) -> String {
    let mut parts = vec![summary.to_string()];
    let combined = format!("{final_message} {}", tool_errors.join(" "));
    if let Some(friendly) = humanize_provider_failure(&combined) {
        parts.push(friendly.to_string());
    }
    if !final_message.trim().is_empty() {
        parts.push(format!("詳細（AIの報告）: {}", final_message.trim()));
    }
    if !tool_errors.is_empty() {
        parts.push(format!("ツールエラー: {}", tool_errors.join(" / ")));
    }
    parts.join("\n")
}

fn apply_final_report_url_fallback(sources: &mut Vec<RemoteArtifactSource>, final_message: &str) {
    if !sources.is_empty() {
        return;
    }
    for url in https_urls_in_text(final_message) {
        push_unique_source(sources, RemoteArtifactSource::Url(url));
    }
}

fn final_report_url_candidates(
    final_message: &str,
    kind: RemoteMcpMediaKind,
) -> ArtifactSourceCandidates {
    let mut candidates = ArtifactSourceCandidates::default();
    collect_url_candidates(final_message, kind, None, &mut candidates);
    candidates
}

fn select_llm_artifact_sources(
    tool_candidates: ArtifactSourceCandidates,
    final_message: &str,
    kind: RemoteMcpMediaKind,
) -> Vec<RemoteArtifactSource> {
    let ArtifactSourceCandidates {
        preferred,
        fallback: tool_fallback,
    } = tool_candidates;
    if !preferred.is_empty() {
        return preferred;
    }
    let final_candidates = final_report_url_candidates(final_message, kind);
    if !final_candidates.preferred.is_empty() {
        final_candidates.preferred
    } else if !tool_fallback.is_empty() {
        tool_fallback
    } else {
        final_candidates.fallback
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LlmArtifactTurnEvaluation {
    Ready(RemoteArtifactSource),
    Processing {
        tool_errors: Vec<String>,
        identifier: ProviderJobIdentifier,
    },
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderJobIdentifier {
    field: &'static str,
    value: String,
}

fn is_processing_status_value(value: &str) -> bool {
    matches!(
        value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str(),
        "processing" | "pending" | "queued" | "in_progress" | "running" | "submitted"
    )
}

fn is_completed_status_value(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("completed")
}

fn is_terminal_failure_status_value(value: &str) -> bool {
    matches!(
        value
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str(),
        "failed" | "failure" | "rejected" | "cancelled" | "canceled" | "content_policy"
    )
}

fn status_field(key: &str) -> bool {
    matches!(
        normalized_field_name(Some(key)).as_str(),
        "status" | "state" | "phase" | "jobstatus" | "taskstatus"
    )
}

fn parsed_json_string(value: &str) -> Option<Value> {
    matches!(value.trim().as_bytes().first(), Some(b'{') | Some(b'['))
        .then(|| serde_json::from_str::<Value>(value).ok())
        .flatten()
}

fn value_has_explicit_processing_status(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            (status_field(key) && nested.as_str().is_some_and(is_processing_status_value))
                || value_has_explicit_processing_status(nested)
        }),
        Value::Array(values) => values.iter().any(value_has_explicit_processing_status),
        Value::String(text) => parsed_json_string(text)
            .as_ref()
            .is_some_and(value_has_explicit_processing_status),
        _ => false,
    }
}

fn value_has_explicit_completed_status(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            (status_field(key) && nested.as_str().is_some_and(is_completed_status_value))
                || value_has_explicit_completed_status(nested)
        }),
        Value::Array(values) => values.iter().any(value_has_explicit_completed_status),
        Value::String(text) => parsed_json_string(text)
            .as_ref()
            .is_some_and(value_has_explicit_completed_status),
        _ => false,
    }
}

fn identifier_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn extract_job_identifier(value: &Value) -> Option<ProviderJobIdentifier> {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let field = match normalized_field_name(Some(key)).as_str() {
                    "identifier" => Some("identifier"),
                    "jobid" => Some("jobId"),
                    "taskid" => Some("taskId"),
                    _ => None,
                };
                if let Some(field) = field {
                    if let Some(value) = identifier_value(value) {
                        return Some(ProviderJobIdentifier { field, value });
                    }
                }
            }
            object.values().find_map(extract_job_identifier)
        }
        Value::Array(values) => values.iter().find_map(extract_job_identifier),
        Value::String(text) => parsed_json_string(text)
            .as_ref()
            .and_then(extract_job_identifier),
        _ => None,
    }
}

fn error_value_is_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
        Value::Number(_) => true,
    }
}

fn value_has_terminal_failure(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            let normalized = normalized_field_name(Some(key));
            (status_field(key)
                && nested
                    .as_str()
                    .is_some_and(is_terminal_failure_status_value))
                || (normalized == "iserror" && nested.as_bool() == Some(true))
                || (normalized == "error" && error_value_is_present(nested))
                || value_has_terminal_failure(nested)
        }),
        Value::Array(values) => values.iter().any(value_has_terminal_failure),
        Value::String(text) => {
            parsed_json_string(text)
                .as_ref()
                .is_some_and(value_has_terminal_failure)
                || text.to_ascii_lowercase().contains("content_policy")
        }
        _ => false,
    }
}

fn final_message_has_terminal_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("content_policy")
        || [
            "status: failed",
            "status=failed",
            "status: rejected",
            "status=rejected",
            "status: cancelled",
            "status=cancelled",
            "status: canceled",
            "status=canceled",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
}

fn inspect_provider_tool_progress(
    output: &crate::codex::gen_server::LlmToolTurnOutput,
    provider_id: &str,
) -> Result<Option<ProviderJobIdentifier>, String> {
    let mut processing = None;
    for item in output
        .completed_items
        .iter()
        .filter(|item| is_provider_tool_item(item, provider_id))
    {
        let item_failed = item
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(is_terminal_failure_status_value)
            || item.get("isError").and_then(Value::as_bool) == Some(true)
            || item.get("is_error").and_then(Value::as_bool) == Some(true);
        let results = tool_result_values(item);
        if item_failed && results.is_empty() {
            let error = compact_tool_error(item);
            return Err(if error.is_empty() {
                "生成先サービスが生成に失敗しました".to_string()
            } else {
                error
            });
        }

        for result in results {
            let tool_output = tool_call_output_from_value(result);
            if item_failed || tool_output.is_error || value_has_terminal_failure(result) {
                let error = if tool_output.text.trim().is_empty() {
                    compact_tool_error(result)
                } else {
                    provider_output_error(&tool_output)
                };
                return Err(if error.is_empty() {
                    "生成先サービスが生成に失敗しました".to_string()
                } else {
                    error
                });
            }
            if value_has_explicit_processing_status(result) {
                if let Some(identifier) = extract_job_identifier(result) {
                    processing = Some(identifier);
                }
            }
        }
    }
    Ok(processing)
}

fn evaluate_llm_artifact_turn(
    output: &crate::codex::gen_server::LlmToolTurnOutput,
    provider_id: &str,
    kind: RemoteMcpMediaKind,
    reference_paths: &[String],
) -> LlmArtifactTurnEvaluation {
    let (tool_candidates, tool_errors) = extract_llm_tool_artifact_candidates(
        &output.completed_items,
        provider_id,
        kind,
        reference_paths,
    );
    if let Some(error) = output.terminal_error.as_deref() {
        return LlmArtifactTurnEvaluation::Failed(llm_failure_message(
            error,
            &output.final_message,
            &tool_errors,
        ));
    }
    let processing = match inspect_provider_tool_progress(output, provider_id) {
        Ok(processing) => processing,
        Err(error) => {
            return LlmArtifactTurnEvaluation::Failed(llm_failure_message(
                "生成先サービスが生成に失敗しました",
                &output.final_message,
                &[error],
            ));
        }
    };
    if final_message_has_terminal_failure(&output.final_message) {
        return LlmArtifactTurnEvaluation::Failed(llm_failure_message(
            "生成先サービスが生成に失敗しました",
            &output.final_message,
            &tool_errors,
        ));
    }
    if kind == RemoteMcpMediaKind::Video {
        if let Some(identifier) = processing {
            return LlmArtifactTurnEvaluation::Processing {
                tool_errors,
                identifier,
            };
        }
    }
    if let Some(source) = select_llm_artifact_sources(tool_candidates, &output.final_message, kind)
        .into_iter()
        .next()
    {
        return LlmArtifactTurnEvaluation::Ready(source);
    }
    LlmArtifactTurnEvaluation::Failed(llm_failure_message(
        &format!(
            "Codex のツール実行結果に保存できる{}がありませんでした",
            kind.noun()
        ),
        &output.final_message,
        &tool_errors,
    ))
}

fn processing_retry_exhausted_message(
    kind: RemoteMcpMediaKind,
    output: &crate::codex::gen_server::LlmToolTurnOutput,
    tool_errors: &[String],
) -> String {
    llm_failure_message(
        &format!(
            "{}の処理がまだ完了していません。時間をおいて再生成してください",
            kind.noun()
        ),
        &output.final_message,
        tool_errors,
    )
}

fn processing_turn_context(
    output: &crate::codex::gen_server::LlmToolTurnOutput,
    provider_id: &str,
) -> String {
    let tool_results = output
        .completed_items
        .iter()
        .filter(|item| is_provider_tool_item(item, provider_id))
        .flat_map(tool_result_values)
        .cloned()
        .collect::<Vec<_>>();
    let raw = format!(
        "最終報告: {}\nツール結果: {}",
        output.final_message.trim(),
        serde_json::to_string(&tool_results).unwrap_or_else(|_| "[]".to_string())
    );
    super::diagnostics::redact_text(&raw, dirs::home_dir().as_deref())
        .chars()
        .take(GENERATION_MESSAGE_LIMIT_CHARS)
        .collect()
}

fn build_processing_follow_up_prompt(
    provider_label: &str,
    provider_id: &str,
    output: &crate::codex::gen_server::LlmToolTurnOutput,
    identifier: &ProviderJobIdentifier,
    attempt: usize,
) -> String {
    let context = processing_turn_context(output, provider_id);
    let identifier_value =
        serde_json::to_string(&identifier.value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "あなたは生成完了確認係。新しい生成ジョブは開始するな。次の専用ジョブ識別子を必ず引き継ぎ、tool_searchで{provider_label}の result / status / task / job / query / wait / get / history 等の完了確認ツールを検索・ロードせよ。{provider_label}以外のサービスと内蔵 image_gen は使用禁止。さっきのジョブの完了を確認し、完了まで待って、ツール結果の url フィールドにあるファイル直リンクを1件だけ返せ。共有ページ・プレビューURLは返すな。完了確認 {attempt}/{}。\n専用ジョブ識別子（{}）: {identifier_value}\n\n直前結果:\n{context}",
        PROCESSING_FOLLOW_UP_DELAYS_SECS.len(),
        identifier.field
    )
}

fn display_optional(value: Option<&str>) -> &str {
    value
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("指定なし")
}

fn build_remote_mcp_llm_prompt(
    provider_label: &str,
    kind: RemoteMcpMediaKind,
    instruction: &str,
    model: Option<&str>,
    duration_seconds: Option<f64>,
    aspect: Option<&str>,
    resolution: Option<&str>,
    reference_paths: &[String],
) -> String {
    let duration = duration_seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| format!("{value}秒"))
        .unwrap_or_else(|| "指定なし".to_string());
    let references = if reference_paths.is_empty() {
        "なし".to_string()
    } else {
        reference_paths.join("、")
    };
    let resolution_instruction = resolution
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|value| format!("\n解像度: {value} で生成せよ。"))
        .unwrap_or_default();
    format!(
        "あなたは生成実行係。まず tool_search で {provider_label} のツールを必ず検索・ロードしてから、tool_search は検索語に合うツールしか返さない。生成ツールに加えて、完了確認ツール（result / status / task / job / query / wait / get / history 等）も**検索語を変えて複数回**検索し、両方をロードしてから始めよ。{provider_label} のMCPツールで{}を生成せよ。**生成は1枚だけ**（count / numOutputs / num_images / n 等の枚数引数があれば 1 を指定し、複数枚を要求するな）。指示文: {instruction} / モデル: {} / 尺: {duration} / 比率: {} / 参照画像: {references}。必要なツールを自分で選び、正しい引数で呼べ。**{provider_label} 以外のサービスのツールと内蔵 image_gen の使用は禁止**（失敗したら代替生成せず、エラー内容だけを報告せよ）。指示文が日本語の場合、意味を変えずに英語へ翻訳してツールへ渡してよい（固有名詞は保持）。content_policy 等の審査拒否で失敗した場合は、意味を保った安全な英語の言い換えで**1回だけ**自動再試行し、それでも拒否されたら理由を報告せよ。ジョブが非同期（pending/queued）の場合は、完了ツール（wait/get/history等）で**完了するまでポーリングを続けよ**（数分かかる。途中で諦めるな）。完了したら、ツール結果の url フィールドにあるファイル直リンクのダウンロードURLを**1件だけ**報告せよ。共有ページ・プレビューURLは報告しない。ツール呼び出し以外の創作はするな{resolution_instruction}",
        kind.noun(),
        display_optional(model),
        display_optional(aspect),
    )
}

fn extension_from_mime(kind: RemoteMcpMediaKind, mime_type: &str) -> Option<&'static str> {
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or(mime_type)
        .trim()
        .to_ascii_lowercase();
    match (kind, mime_type.as_str()) {
        (RemoteMcpMediaKind::Image, "image/png") => Some("png"),
        (RemoteMcpMediaKind::Image, "image/jpeg" | "image/jpg") => Some("jpg"),
        (RemoteMcpMediaKind::Image, "image/webp") => Some("webp"),
        (RemoteMcpMediaKind::Video, "video/mp4") => Some("mp4"),
        (RemoteMcpMediaKind::Video, "video/quicktime") => Some("mov"),
        (RemoteMcpMediaKind::Video, "video/webm") => Some("webm"),
        (RemoteMcpMediaKind::Video, "video/x-m4v" | "video/m4v") => Some("m4v"),
        _ => None,
    }
}

fn extension_from_url(kind: RemoteMcpMediaKind, url: &str) -> Option<&'static str> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let extension = Path::new(parsed.path())
        .extension()
        .and_then(|value| value.to_str())?;
    match (kind, extension.to_ascii_lowercase().as_str()) {
        (RemoteMcpMediaKind::Image, "png") => Some("png"),
        (RemoteMcpMediaKind::Image, "jpg" | "jpeg") => Some("jpg"),
        (RemoteMcpMediaKind::Image, "webp") => Some("webp"),
        (RemoteMcpMediaKind::Video, "mp4") => Some("mp4"),
        (RemoteMcpMediaKind::Video, "mov") => Some("mov"),
        (RemoteMcpMediaKind::Video, "webm") => Some("webm"),
        (RemoteMcpMediaKind::Video, "m4v") => Some("m4v"),
        _ => None,
    }
}

fn extension_from_content_type_or_url(
    kind: RemoteMcpMediaKind,
    content_type: Option<&str>,
    url: &str,
) -> Option<&'static str> {
    content_type
        .and_then(|mime_type| extension_from_mime(kind, mime_type))
        .or_else(|| extension_from_url(kind, url))
}

fn https_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() != "https" {
            attempt.error("HTTPS以外へのリダイレクトを拒否しました")
        } else if attempt.previous().len() >= REMOTE_DOWNLOAD_REDIRECT_LIMIT {
            attempt.error("リダイレクト回数が上限を超えました")
        } else {
            attempt.follow()
        }
    })
}

fn download_accept_header(kind: RemoteMcpMediaKind) -> &'static str {
    match kind {
        RemoteMcpMediaKind::Image => "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        RemoteMcpMediaKind::Video => "video/mp4,video/webm,video/quicktime,video/*,*/*;q=0.8",
    }
}

fn should_retry_download_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    )
}

fn should_retry_transient_download_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND || status.is_server_error()
}

async fn send_download_request(
    http: &reqwest::Client,
    url: &reqwest::Url,
    kind: RemoteMcpMediaKind,
    user_agent: &'static str,
) -> Result<reqwest::Response, reqwest::Error> {
    http.get(url.clone())
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(reqwest::header::ACCEPT, download_accept_header(kind))
        // Referer は意図的に付けない。CDN が共有ページ由来の値を拒否する場合がある。
        .send()
        .await
}

async fn download_response(
    http: &reqwest::Client,
    url: &reqwest::Url,
    kind: RemoteMcpMediaKind,
) -> Result<reqwest::Response, reqwest::Error> {
    let first = send_download_request(http, url, kind, REMOTE_DOWNLOAD_USER_AGENT).await?;
    if should_retry_download_status(first.status()) {
        // 401/403だけ、Refererなし・別UAで一度だけ取り直す。二度目の結果は偽装しない。
        send_download_request(http, url, kind, REMOTE_DOWNLOAD_RETRY_USER_AGENT).await
    } else {
        Ok(first)
    }
}

async fn retry_transient_download<T, E, Fetch, FetchFuture, ShouldRetry, Sleep, SleepFuture>(
    mut fetch: Fetch,
    should_retry: ShouldRetry,
    mut sleep: Sleep,
) -> Result<T, E>
where
    Fetch: FnMut() -> FetchFuture,
    FetchFuture: std::future::Future<Output = Result<T, E>>,
    ShouldRetry: Fn(&T) -> bool,
    Sleep: FnMut(Duration) -> SleepFuture,
    SleepFuture: std::future::Future<Output = ()>,
{
    let mut response = fetch().await?;
    for delay_seconds in [2, 4, 8] {
        if !should_retry(&response) {
            break;
        }
        sleep(Duration::from_secs(delay_seconds)).await;
        response = fetch().await?;
    }
    Ok(response)
}

async fn download_response_with_transient_retry(
    http: &reqwest::Client,
    url: &reqwest::Url,
    kind: RemoteMcpMediaKind,
) -> Result<reqwest::Response, reqwest::Error> {
    retry_transient_download(
        || download_response(http, url, kind),
        |response: &reqwest::Response| should_retry_transient_download_status(response.status()),
        tokio::time::sleep,
    )
    .await
}

fn download_url_location(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let tail = parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back());
    Some(match tail {
        Some(tail) => format!("{host}/…/{tail}"),
        None => host.to_string(),
    })
}

fn http_download_failure_message(
    kind: RemoteMcpMediaKind,
    status: reqwest::StatusCode,
    url: &str,
) -> String {
    let mut message = format!("{}の取得に失敗しました (HTTP {status})", kind.noun());
    if let Some(location) = download_url_location(url) {
        message.push_str(&format!("。取得先: {location}"));
    }
    if should_retry_download_status(status) || is_likely_shared_page_url(url) {
        message.push_str(
            "。共有ページのURLの可能性があります。ファイル直リンクと有効期限を確認してください",
        );
    }
    message
}

async fn download_response_bytes(
    response: reqwest::Response,
    kind: RemoteMcpMediaKind,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > REMOTE_DOWNLOAD_MAX_BYTES)
    {
        return Err(format!(
            "{}が大きすぎます（1ファイル512MBまで）",
            kind.noun()
        ));
    }

    use futures::StreamExt;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| format!("{}データの受信が中断しました", kind.noun()))?;
        let next_length = (bytes.len() as u64).saturating_add(chunk.len() as u64);
        if next_length > REMOTE_DOWNLOAD_MAX_BYTES {
            return Err(format!(
                "{}が大きすぎます（1ファイル512MBまで）",
                kind.noun()
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(format!("{}データが空でした", kind.noun()));
    }
    Ok(bytes)
}

fn sanitize_filename_part(value: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for character in value.chars().take(64) {
        let safe = character.is_ascii_alphanumeric() || matches!(character, '-' | '_');
        if safe {
            out.push(character);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "request".to_string()
    } else {
        trimmed.to_string()
    }
}

fn write_remote_file(
    directory: &Path,
    provider_id: &str,
    request_id: &str,
    index: usize,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("生成物データが空でした".to_string());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let request_id = sanitize_filename_part(request_id);
    for _ in 0..100 {
        let sequence = REMOTE_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            "remote-{provider_id}-{request_id}-{timestamp}-{sequence}-{index}.{extension}"
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|error| format!("生成物を保存できませんでした: {error}"))?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("生成物の保存先を作れませんでした: {error}")),
        }
    }
    Err("生成物の重複しないファイル名を作れませんでした".to_string())
}

fn generation_output_dir(kind: RemoteMcpMediaKind) -> Result<std::path::PathBuf, String> {
    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗しました".to_string())?;
    // 動画は既存 Higgsfield 生成・video_concat と同じ保存経路へ合流させる。
    let directory = match kind {
        RemoteMcpMediaKind::Image => base,
        RemoteMcpMediaKind::Video => base.join("higgsfield"),
    };
    fs::create_dir_all(&directory)
        .map_err(|error| format!("生成物の保存先を作成できませんでした: {error}"))?;
    Ok(directory)
}

async fn save_remote_artifacts(
    provider_id: &str,
    request_id: &str,
    kind: RemoteMcpMediaKind,
    sources: Vec<RemoteArtifactSource>,
) -> Result<RemoteMcpGenerateResult, String> {
    save_remote_artifacts_from_index(provider_id, request_id, kind, sources, 1).await
}

async fn save_remote_artifacts_from_index(
    provider_id: &str,
    request_id: &str,
    kind: RemoteMcpMediaKind,
    sources: Vec<RemoteArtifactSource>,
    first_index: usize,
) -> Result<RemoteMcpGenerateResult, String> {
    let directory = generation_output_dir(kind)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(REMOTE_DOWNLOAD_TIMEOUT_SECS))
        .redirect(https_redirect_policy())
        .build()
        .map_err(|error| format!("生成物ダウンロードの準備に失敗しました: {error}"))?;
    let mut saved_paths = Vec::new();
    let mut errors = Vec::new();

    for (offset, source) in sources.into_iter().enumerate() {
        let index = first_index + offset;
        let source_label = match &source {
            RemoteArtifactSource::InlineImage { .. } => "base64画像",
            RemoteArtifactSource::Url(_) => "HTTPS URL",
            RemoteArtifactSource::LocalPath(_) => "ローカル保存先",
        };
        let result = match source {
            RemoteArtifactSource::InlineImage {
                mime_type,
                data_base64,
            } => {
                let extension = extension_from_mime(RemoteMcpMediaKind::Image, &mime_type)
                    .ok_or_else(|| format!("未対応の画像形式です: {mime_type}"));
                match extension {
                    Ok(extension) => match general_purpose::STANDARD.decode(data_base64.trim()) {
                        Ok(bytes) => write_remote_file(
                            &directory,
                            provider_id,
                            request_id,
                            index,
                            extension,
                            &bytes,
                        ),
                        Err(error) => Err(format!("base64 画像を読み取れませんでした: {error}")),
                    },
                    Err(error) => Err(error),
                }
            }
            RemoteArtifactSource::Url(url) => match validated_https_url(&url) {
                Err(error) => Err(error),
                Ok(url) => match download_response_with_transient_retry(&http, &url, kind).await {
                    Ok(response) if response.status().is_success() => {
                        let content_type = response
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_string);
                        let final_url = response.url().to_string();
                        match extension_from_content_type_or_url(
                            kind,
                            content_type.as_deref(),
                            &final_url,
                        ) {
                            Some(extension) => {
                                match download_response_bytes(response, kind).await {
                                    Ok(bytes) => write_remote_file(
                                        &directory,
                                        provider_id,
                                        request_id,
                                        index,
                                        extension,
                                        &bytes,
                                    ),
                                    Err(error) => Err(error),
                                }
                            }
                            None => Err(format!(
                                "ダウンロード結果が未対応の{}形式でした",
                                kind.noun()
                            )),
                        }
                    }
                    Ok(response) => Err(http_download_failure_message(
                        kind,
                        response.status(),
                        response.url().as_str(),
                    )),
                    Err(error) if error.is_timeout() => Err(format!(
                        "{}のダウンロードが120秒以内に完了しませんでした",
                        kind.noun()
                    )),
                    Err(error) if error.is_redirect() => Err(format!(
                        "{}のリダイレクトが安全条件（HTTPS・5回まで）を満たしませんでした",
                        kind.noun()
                    )),
                    Err(_) => Err(format!("{}のダウンロード通信に失敗しました", kind.noun())),
                },
            },
            RemoteArtifactSource::LocalPath(path) => {
                let source_path = Path::new(&path);
                match extension_from_local_path(kind, source_path) {
                    None => Err(format!("未対応の{}形式です", kind.noun())),
                    Some(extension) => match fs::metadata(source_path) {
                        Ok(metadata) if metadata.len() > REMOTE_DOWNLOAD_MAX_BYTES => Err(format!(
                            "{}が大きすぎます（1ファイル512MBまで）",
                            kind.noun()
                        )),
                        Ok(_) => match fs::read(source_path) {
                            Ok(bytes) => write_remote_file(
                                &directory,
                                provider_id,
                                request_id,
                                index,
                                extension,
                                &bytes,
                            ),
                            Err(error) => Err(format!(
                                "{}のローカル保存先を読み取れませんでした: {error}",
                                kind.noun()
                            )),
                        },
                        Err(error) => Err(format!(
                            "{}のローカル保存先を確認できませんでした: {error}",
                            kind.noun()
                        )),
                    },
                }
            }
        };
        match result {
            Ok(path) => saved_paths.push(path),
            Err(error) => errors.push(format!("保存対象 {index}（{source_label}）: {error}")),
        }
    }

    if saved_paths.is_empty() {
        Err(if errors.is_empty() {
            format!("{}を1件も保存できませんでした", kind.noun())
        } else {
            errors.join("\n")
        })
    } else {
        Ok(RemoteMcpGenerateResult {
            saved_paths,
            errors,
        })
    }
}

fn sanitize_generation_message(message: &str) -> String {
    let sanitized = super::diagnostics::redact_text(message, dirs::home_dir().as_deref());
    let mut without_urls = sanitized;
    for url in https_urls_in_text(&without_urls) {
        without_urls = without_urls.replace(&url, "[URLを除外]");
    }
    without_urls
        .chars()
        .take(GENERATION_MESSAGE_LIMIT_CHARS)
        .collect()
}

fn emit_generation_event(
    app: &AppHandle,
    request_id: &str,
    provider_id: &str,
    phase: &'static str,
    message: Option<String>,
    saved_paths: Option<Vec<String>>,
    count: Option<u32>,
    slot_results: Option<Vec<RemoteMcpSlotResult>>,
    errors: Option<Vec<String>>,
) {
    let _ = app.emit(
        REMOTE_MCP_GEN_EVENT,
        RemoteMcpGenerateEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            phase,
            message,
            saved_paths,
            count,
            slot_results,
            errors,
        },
    );
}

async fn update_remote_slot(
    app: &AppHandle,
    request_id: &str,
    provider_id: &str,
    slots: &Arc<Mutex<Vec<RemoteMcpSlotResult>>>,
    slot_number: u32,
    status: &'static str,
    saved_path: Option<String>,
    error: Option<String>,
) {
    let snapshot = {
        let mut slots = slots.lock().await;
        if let Some(slot) = slots.iter_mut().find(|slot| slot.slot == slot_number) {
            slot.status = status;
            slot.saved_path = saved_path;
            slot.error = error;
        }
        slots.clone()
    };
    emit_generation_event(
        app,
        request_id,
        provider_id,
        "running",
        None,
        None,
        Some(snapshot.len() as u32),
        Some(snapshot),
        None,
    );
}

fn persist_discovery(
    app: &AppHandle,
    discovery: &RemoteMcpDiscovery,
    raw_attempts: &[RemoteMcpDiscoveryAttempt],
) -> Result<(), String> {
    let dir = discovery_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("プロバイダ実測結果の保存先を作成できませんでした: {error}"))?;

    let recorded_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let raw_line = bounded_raw_log_line(&discovery.provider_id, recorded_at_ms, raw_attempts)?;
    let raw_path = dir.join(format!("{}.raw.jsonl", discovery.provider_id));
    let existing_len = match fs::symlink_metadata(&raw_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("プロバイダ実測ログが通常ファイルではありません".to_string());
        }
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(format!(
                "プロバイダ実測ログの情報を確認できませんでした: {error}"
            ));
        }
    };
    let reset_log =
        existing_len.saturating_add(raw_line.len() as u64) > DISCOVERY_RAW_FILE_MAX_BYTES;
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if reset_log {
        options.truncate(true);
    } else {
        options.append(true);
    }
    let mut raw_file = options
        .open(&raw_path)
        .map_err(|error| format!("プロバイダ実測ログを開けませんでした: {error}"))?;
    raw_file
        .write_all(&raw_line)
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
    let home = dirs::home_dir();

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
        let raw = sanitize_discovery_raw(&raw, home.as_deref());
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

/// app-server v2 の正規 API から、指定プロバイダが公開しているツール一覧を取得する。
#[tauri::command]
pub async fn remote_mcp_list_tools(
    provider_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RemoteMcpToolList, String> {
    let provider = provider_by_id(&provider_id)?;
    let mut cursor: Option<String> = None;
    let mut seen_cursors = std::collections::HashSet::new();

    loop {
        let page = list_mcp_server_status_page(&state, cursor.as_deref()).await?;
        let servers = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "mcpServerStatus/list の応答に data がありません".to_string())?;
        if let Some(server) = servers
            .iter()
            .find(|server| server.get("name").and_then(Value::as_str) == Some(provider.id))
        {
            let list = tool_list_from_server(provider.id, server)?;
            if should_persist_tool_list(&list) {
                persist_tool_list(&app, &list)?;
            }
            return Ok(list);
        }

        let next_cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let Some(next_cursor) = next_cursor else {
            return Err(format!(
                "{} の MCP サーバーが app-server の一覧にありません。先に接続を確認してください。",
                provider.label
            ));
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err("MCP ツール一覧のページ情報が循環したため中止しました".to_string());
        }
        cursor = Some(next_cursor);
    }
}

/// 前回成功した正規ツール一覧キャッシュを返す。未取得なら null。
#[tauri::command]
pub fn remote_mcp_list_tools_cached(
    provider_id: String,
    invalidate: Option<bool>,
    app: AppHandle,
) -> Result<Option<RemoteMcpToolList>, String> {
    let provider = provider_by_id(&provider_id)?;
    let path = discovery_dir(&app)?.join(format!("{}.tools.json", provider.id));
    if invalidate.unwrap_or(false) {
        remove_tool_list_cache(&path)?;
        return Ok(None);
    }
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "{} の保存済みツール一覧を読めませんでした: {error}",
                provider.label
            ))
        }
    };
    serde_json::from_slice(&raw).map(Some).map_err(|error| {
        format!(
            "{} の保存済みツール一覧が壊れています: {error}",
            provider.label
        )
    })
}

/// モデル一覧などの読み取り系ツールを LLM なしで直接呼ぶ。
/// 成功応答は加工・保存せず返し、失敗文だけ既存の伏せ字と長さ制限を通す。
#[tauri::command]
pub async fn remote_mcp_query(
    provider_id: String,
    tool_name: String,
    params_json: String,
    state: State<'_, AppState>,
) -> Result<RemoteMcpQueryResult, String> {
    let result = async {
        let provider = provider_by_id(&provider_id)?;
        let tool_name = tool_name.trim();
        if tool_name.is_empty() {
            return Err("toolName が空です".to_string());
        }
        let arguments: Value = serde_json::from_str(&params_json)
            .map_err(|error| format!("paramsJson が正しいJSONではありません: {error}"))?;
        if !arguments.is_object() {
            return Err("paramsJson はJSONオブジェクトで指定してください".to_string());
        }

        let output = call_tool_with_timeout(
            &state,
            provider.id,
            tool_name,
            arguments,
            Duration::from_secs(REMOTE_QUERY_TIMEOUT_SECS),
        )
        .await?;
        if output.is_error {
            return Err(if output.text.trim().is_empty() {
                format!("{} の {tool_name} がエラーを返しました", provider.label)
            } else {
                output.text
            });
        }
        Ok(RemoteMcpQueryResult {
            content_text: output.text,
            structured_content: output.structured,
        })
    }
    .await;

    result.map_err(|error| sanitize_generation_message(&error))
}

async fn run_llm_tool_turn_before_deadline(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    kind: RemoteMcpMediaKind,
    deadline: tokio::time::Instant,
) -> Result<crate::codex::gen_server::LlmToolTurnOutput, String> {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err(format!(
            "{}の生成確認が{}分でタイムアウトしました",
            kind.noun(),
            kind.timeout().as_secs() / 60
        ));
    }
    tokio::time::timeout(
        remaining,
        crate::codex::gen_server::run_llm_tool_turn(app, state, prompt, remaining),
    )
    .await
    .map_err(|_| {
        format!(
            "{}の生成確認が{}分でタイムアウトしました",
            kind.noun(),
            kind.timeout().as_secs() / 60
        )
    })?
}

fn slot_deadline_message(kind: RemoteMcpMediaKind) -> String {
    format!(
        "{}の生成と保存が{}分でタイムアウトしました",
        kind.noun(),
        kind.timeout().as_secs() / 60
    )
}

/// 生成専用 Codex に MCP ツール選択を任せ、成果物を既存保存経路へ合流する。
#[allow(clippy::too_many_arguments)]
async fn run_remote_mcp_slot(
    app: &AppHandle,
    state: &AppState,
    request_id: &str,
    provider_id: &str,
    llm_prompt: &str,
    kind: RemoteMcpMediaKind,
    reference_paths: &[String],
    slots: &Arc<Mutex<Vec<RemoteMcpSlotResult>>>,
    slot_number: u32,
) {
    update_remote_slot(
        app,
        request_id,
        provider_id,
        slots,
        slot_number,
        "running",
        None,
        None,
    )
    .await;

    let deadline = tokio::time::Instant::now() + kind.timeout();
    let result = tokio::time::timeout_at(deadline, async {
        let mut output =
            run_llm_tool_turn_before_deadline(app, state, llm_prompt, kind, deadline).await?;
        let (_, provider_label) = generation_provider(provider_id)?;
        let mut follow_up_count = 0usize;

        // 1枠は必ず1ファイル。processing の間だけ同じジョブを最大2回追いかける。
        let source = loop {
            match evaluate_llm_artifact_turn(&output, provider_id, kind, reference_paths) {
                LlmArtifactTurnEvaluation::Ready(source) => break source,
                LlmArtifactTurnEvaluation::Failed(error) => return Err(error),
                LlmArtifactTurnEvaluation::Processing {
                    tool_errors,
                    identifier,
                } => {
                    let Some(delay_seconds) = PROCESSING_FOLLOW_UP_DELAYS_SECS
                        .get(follow_up_count)
                        .copied()
                    else {
                        return Err(processing_retry_exhausted_message(
                            kind,
                            &output,
                            &tool_errors,
                        ));
                    };
                    let delay = Duration::from_secs(delay_seconds);
                    let now = tokio::time::Instant::now();
                    if deadline.saturating_duration_since(now) <= delay {
                        return Err(processing_retry_exhausted_message(
                            kind,
                            &output,
                            &tool_errors,
                        ));
                    }
                    tokio::time::sleep(delay).await;
                    let follow_up_prompt = build_processing_follow_up_prompt(
                        provider_label,
                        provider_id,
                        &output,
                        &identifier,
                        follow_up_count + 1,
                    );
                    output = run_llm_tool_turn_before_deadline(
                        app,
                        state,
                        &follow_up_prompt,
                        kind,
                        deadline,
                    )
                    .await?;
                    follow_up_count += 1;
                }
            }
        };

        update_remote_slot(
            app,
            request_id,
            provider_id,
            slots,
            slot_number,
            "saving",
            None,
            None,
        )
        .await;
        let saved = save_remote_artifacts_from_index(
            provider_id,
            request_id,
            kind,
            vec![source],
            slot_number as usize,
        )
        .await?;
        saved
            .saved_paths
            .into_iter()
            .next()
            .ok_or_else(|| format!("{}を1件も保存できませんでした", kind.noun()))
    })
    .await
    .unwrap_or_else(|_| Err(slot_deadline_message(kind)));

    match result {
        Ok(saved_path) => {
            update_remote_slot(
                app,
                request_id,
                provider_id,
                slots,
                slot_number,
                "done",
                Some(saved_path),
                None,
            )
            .await;
        }
        Err(error) => {
            update_remote_slot(
                app,
                request_id,
                provider_id,
                slots,
                slot_number,
                "failed",
                None,
                Some(sanitize_generation_message(&error)),
            )
            .await;
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_mcp_generate(
    request_id: String,
    provider_id: String,
    prompt: String,
    model: Option<String>,
    duration_seconds: Option<f64>,
    aspect: Option<String>,
    resolution: Option<String>,
    reference_paths: Vec<String>,
    kind: RemoteMcpMediaKind,
    count: Option<u32>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RemoteMcpGenerateResult, String> {
    let count = clamp_remote_count(count);
    let slots = Arc::new(Mutex::new(
        (1..=count)
            .map(|slot| RemoteMcpSlotResult {
                slot,
                status: "pending",
                saved_path: None,
                error: None,
            })
            .collect::<Vec<_>>(),
    ));
    let initial_slots = slots.lock().await.clone();
    emit_generation_event(
        &app,
        &request_id,
        &provider_id,
        "running",
        None,
        None,
        Some(count),
        Some(initial_slots),
        None,
    );

    let result = async {
        let (provider_id, provider_label) = generation_provider(&provider_id)?;
        if request_id.trim().is_empty() {
            return Err("requestId が空です".to_string());
        }
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("プロンプトが空です。作りたい内容を入力してください。".to_string());
        }
        let reference_paths = reference_paths
            .into_iter()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect::<Vec<_>>();
        let llm_prompt = build_remote_mcp_llm_prompt(
            provider_label,
            kind,
            prompt,
            model.as_deref(),
            duration_seconds,
            aspect.as_deref(),
            resolution.as_deref(),
            &reference_paths,
        );

        let jobs = (1..=count).map(|slot_number| {
            run_remote_mcp_slot(
                &app,
                &state,
                &request_id,
                provider_id,
                &llm_prompt,
                kind,
                &reference_paths,
                &slots,
                slot_number,
            )
        });
        futures::future::join_all(jobs).await;

        Ok::<_, String>(slots.lock().await.clone())
    }
    .await;

    match result {
        Ok(slot_results) => {
            let (saved_paths, errors) = aggregate_slot_results(&slot_results);
            let message = (!errors.is_empty()).then(|| errors.join("\n"));
            let phase = if saved_paths.is_empty() {
                "error"
            } else {
                "done"
            };
            let message = if phase == "error" && message.is_none() {
                Some(format!("{}を1件も保存できませんでした", kind.noun()))
            } else {
                message
            };
            emit_generation_event(
                &app,
                &request_id,
                &provider_id,
                phase,
                message,
                (!saved_paths.is_empty()).then(|| saved_paths.clone()),
                Some(count),
                Some(slot_results),
                Some(errors.clone()),
            );
            Ok(RemoteMcpGenerateResult {
                saved_paths,
                errors,
            })
        }
        Err(error) => {
            let error = sanitize_generation_message(&error);
            for slot_number in 1..=count {
                update_remote_slot(
                    &app,
                    &request_id,
                    &provider_id,
                    &slots,
                    slot_number,
                    "failed",
                    None,
                    Some(error.clone()),
                )
                .await;
            }
            let slot_results = slots.lock().await.clone();
            let (saved_paths, errors) = aggregate_slot_results(&slot_results);
            let message = if errors.is_empty() {
                format!("{}を1件も保存できませんでした", kind.noun())
            } else {
                errors.join("\n")
            };
            emit_generation_event(
                &app,
                &request_id,
                &provider_id,
                "error",
                Some(message),
                None,
                Some(count),
                Some(slot_results),
                Some(errors.clone()),
            );
            Ok(RemoteMcpGenerateResult {
                saved_paths,
                errors,
            })
        }
    }
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
    fn remote_count_is_clamped_to_supported_range() {
        assert_eq!(clamp_remote_count(None), 1);
        assert_eq!(clamp_remote_count(Some(0)), 1);
        assert_eq!(clamp_remote_count(Some(4)), 4);
        assert_eq!(clamp_remote_count(Some(99)), 30);
    }

    #[test]
    fn slot_results_are_aggregated_in_slot_order() {
        let slots = vec![
            RemoteMcpSlotResult {
                slot: 3,
                status: "done",
                saved_path: Some("p3".to_string()),
                error: None,
            },
            RemoteMcpSlotResult {
                slot: 2,
                status: "failed",
                saved_path: None,
                error: Some("失敗理由".to_string()),
            },
            RemoteMcpSlotResult {
                slot: 1,
                status: "done",
                saved_path: Some("p1".to_string()),
                error: None,
            },
        ];

        let (saved_paths, errors) = aggregate_slot_results(&slots);

        assert_eq!(saved_paths, vec!["p1".to_string(), "p3".to_string()]);
        assert_eq!(errors, vec!["枠2: 失敗理由".to_string()]);
    }

    #[test]
    fn generation_event_serializes_slot_fields_as_camel_case_and_skips_none() {
        let event = RemoteMcpGenerateEvent {
            request_id: "request-1".to_string(),
            provider_id: "krea".to_string(),
            phase: "done",
            message: None,
            saved_paths: None,
            count: Some(1),
            slot_results: Some(vec![RemoteMcpSlotResult {
                slot: 1,
                status: "done",
                saved_path: Some("/tmp/p1.png".to_string()),
                error: None,
            }]),
            errors: Some(Vec::new()),
        };

        let value = serde_json::to_value(event).expect("event JSON");
        assert_eq!(value["count"], 1);
        assert_eq!(value["slotResults"][0]["savedPath"], "/tmp/p1.png");
        assert_eq!(value["errors"], json!([]));
        assert!(value.get("message").is_none());
        assert!(value.get("savedPaths").is_none());
        assert!(value["slotResults"][0].get("error").is_none());
    }

    #[test]
    fn discovery_tools_include_pollo_and_bfl_specific_names() {
        let pollo = discovery_tools("pollo")
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(pollo.contains(&"pollo_list_models"));
        assert!(pollo.contains(&"pollo_show_plans_and_credits"));

        let bfl = discovery_tools("bfl")
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert!(bfl.contains(&"get_credits"));
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

    #[test]
    fn discovery_raw_hides_secrets_and_home_path() {
        let home = Path::new("/Users/example-user");
        let raw = "file=/Users/example-user/work/output.json\ntoken=sk-must-not-leak\nAPI key: must-not-leak";
        let sanitized = sanitize_discovery_raw(raw, Some(home));
        let lower = sanitized.to_ascii_lowercase();

        assert!(sanitized.contains("~/work/output.json"));
        assert!(!sanitized.contains("/Users/example-user"));
        assert!(!lower.contains("token"));
        assert!(!lower.contains("sk-"));
    }

    #[test]
    fn raw_log_record_has_a_hard_size_limit() {
        let attempts: Vec<RemoteMcpDiscoveryAttempt> = (0..100)
            .map(|index| RemoteMcpDiscoveryAttempt {
                tool: format!("tool-{index}"),
                ok: false,
                raw: "餅".repeat(DISCOVERY_RAW_LIMIT_CHARS * 2),
            })
            .collect();
        let line = bounded_raw_log_line("runway", 1, &attempts).expect("bounded log");

        assert!(line.len() <= DISCOVERY_RAW_RECORD_MAX_BYTES);
        let value: serde_json::Value = serde_json::from_slice(&line).expect("valid JSONL record");
        assert!(
            value["attempts"].as_array().expect("attempts").len() < attempts.len(),
            "上限を超える応答は記録から切り詰める"
        );
    }

    fn tool_output(
        content: Vec<Value>,
        structured: Option<Value>,
        text: &str,
        is_error: bool,
    ) -> ToolCallOutput {
        ToolCallOutput {
            content,
            structured,
            text: text.to_string(),
            is_error,
        }
    }

    #[test]
    fn content_parser_accepts_base64_image() {
        let output = tool_output(
            vec![json!({
                "type": "image",
                "data": "aW1hZ2U=",
                "mimeType": "image/png"
            })],
            None,
            "",
            false,
        );
        assert_eq!(
            extract_remote_artifacts(&output, RemoteMcpMediaKind::Image).unwrap(),
            vec![RemoteArtifactSource::InlineImage {
                mime_type: "image/png".to_string(),
                data_base64: "aW1hZ2U=".to_string(),
            }]
        );
    }

    #[test]
    fn content_parser_collects_text_resource_and_structured_urls() {
        let output = tool_output(
            vec![
                json!({"type": "text", "text": "結果: https://cdn.example.com/a.png"}),
                json!({
                    "type": "resource",
                    "resource": {"uri": "https://cdn.example.com/b.png"}
                }),
            ],
            Some(json!({
                "results": [
                    {"url": "https://cdn.example.com/c.png"},
                    {"url": "https://cdn.example.com/a.png"}
                ]
            })),
            "結果: https://cdn.example.com/a.png",
            false,
        );
        assert_eq!(
            extract_remote_artifacts(&output, RemoteMcpMediaKind::Image).unwrap(),
            vec![
                RemoteArtifactSource::Url("https://cdn.example.com/a.png".to_string()),
                RemoteArtifactSource::Url("https://cdn.example.com/b.png".to_string()),
                RemoteArtifactSource::Url("https://cdn.example.com/c.png".to_string()),
            ]
        );
    }

    #[test]
    fn content_parser_prefers_download_field_over_shared_page() {
        let output = tool_output(
            Vec::new(),
            Some(json!({
                "result": {
                    "webUrl": "https://studio.example.com/creations/123",
                    "downloadUrl": "https://signed.example.com/download?id=123"
                }
            })),
            "",
            false,
        );

        assert_eq!(
            extract_remote_artifacts(&output, RemoteMcpMediaKind::Video).unwrap(),
            vec![RemoteArtifactSource::Url(
                "https://signed.example.com/download?id=123".to_string()
            )]
        );
    }

    #[test]
    fn content_parser_accepts_extensionless_url_field_but_not_web_url() {
        let output = tool_output(
            Vec::new(),
            Some(json!({
                "webUrl": "https://studio.example.com/creations/123",
                "url": "https://signed.example.com/asset?id=123&signature=abc"
            })),
            "",
            false,
        );

        assert_eq!(
            extract_remote_artifacts(&output, RemoteMcpMediaKind::Video).unwrap(),
            vec![RemoteArtifactSource::Url(
                "https://signed.example.com/asset?id=123&signature=abc".to_string()
            )]
        );
    }

    #[test]
    fn url_parser_accepts_only_https_and_trims_sentence_punctuation() {
        let urls = https_urls_in_text(
            "http://cdn.example.com/unsafe.png https://cdn.example.com/result.webp).",
        );
        assert_eq!(
            urls,
            vec!["https://cdn.example.com/result.webp".to_string()]
        );
        assert!(validated_https_url("https://cdn.example.com/result.webp").is_ok());
        assert!(validated_https_url("http://cdn.example.com/unsafe.png").is_err());
    }

    #[test]
    fn download_format_prefers_content_type_then_falls_back_to_url() {
        assert_eq!(
            extension_from_content_type_or_url(
                RemoteMcpMediaKind::Image,
                Some("image/png; charset=binary"),
                "https://cdn.example.com/result.webp",
            ),
            Some("png")
        );
        assert_eq!(
            extension_from_content_type_or_url(
                RemoteMcpMediaKind::Video,
                Some("application/octet-stream"),
                "https://cdn.example.com/result.MOV?download=1",
            ),
            Some("mov")
        );
        assert_eq!(
            extension_from_content_type_or_url(
                RemoteMcpMediaKind::Video,
                None,
                "https://cdn.example.com/result.bin",
            ),
            None
        );
        assert_eq!(
            extension_from_content_type_or_url(
                RemoteMcpMediaKind::Video,
                Some("video/m4v"),
                "https://cdn.example.com/result.bin",
            ),
            Some("m4v")
        );
    }

    #[test]
    fn content_parser_supports_multiple_data_urls_in_structured_json() {
        let output = tool_output(
            Vec::new(),
            Some(json!({
                "images": [
                    "data:image/png;base64,YQ==",
                    "data:image/webp;base64,Yg=="
                ]
            })),
            "",
            false,
        );
        assert_eq!(
            extract_remote_artifacts(&output, RemoteMcpMediaKind::Image)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn llm_artifact_parser_uses_matching_mcp_tool_result_only() {
        let items = vec![
            json!({
                "type": "agentMessage",
                "text": "https://cdn.example.com/final-fallback.png"
            }),
            json!({
                "type": "mcpToolCall",
                "server": "runway",
                "tool": "generate",
                "status": "completed",
                "result": {"structuredContent": {"url": "https://cdn.example.com/wrong.mp4"}}
            }),
            json!({
                "type": "mcpToolCall",
                "server": "krea",
                "tool": "generate",
                "status": "completed",
                "result": {"structuredContent": {"url": "https://cdn.example.com/tool.png"}}
            }),
        ];
        let (sources, errors) =
            extract_llm_tool_artifacts(&items, "krea", RemoteMcpMediaKind::Image, &[]);

        assert_eq!(
            sources,
            vec![RemoteArtifactSource::Url(
                "https://cdn.example.com/tool.png".to_string()
            )]
        );
        assert!(errors.is_empty());
    }

    #[test]
    fn llm_artifact_parser_prefers_wait_result_direct_url_across_tool_calls() {
        let items = vec![
            json!({
                "type": "mcpToolCall",
                "server": "magnific",
                "tool": "images_generate",
                "status": "completed",
                "result": {
                    "structuredContent": {
                        "webUrl": "https://magnific.example/creations/123"
                    }
                }
            }),
            json!({
                "type": "mcpToolCall",
                "server": "magnific",
                "tool": "creations_wait",
                "status": "completed",
                "result": {
                    "structuredContent": {
                        "downloadUrl": "https://cdn.example.com/final.mp4"
                    }
                }
            }),
        ];

        let (sources, errors) =
            extract_llm_tool_artifacts(&items, "magnific", RemoteMcpMediaKind::Video, &[]);
        assert_eq!(
            sources,
            vec![RemoteArtifactSource::Url(
                "https://cdn.example.com/final.mp4".to_string()
            )]
        );
        assert!(errors.is_empty());
    }

    #[test]
    fn completion_tool_direct_url_beats_generation_tool_direct_url() {
        let output = crate::codex::gen_server::LlmToolTurnOutput {
            completed_items: vec![
                json!({
                    "type": "mcpToolCall",
                    "server": "krea",
                    "tool": "videos_generate",
                    "status": "completed",
                    "result": {
                        "structuredContent": {
                            "url": "https://cdn.example.com/generation-start.mp4"
                        }
                    }
                }),
                json!({
                    "type": "mcpToolCall",
                    "server": "krea",
                    "tool": "creations_wait",
                    "status": "completed",
                    "result": {
                        "structuredContent": {
                            "url": "https://cdn.example.com/completed.mp4"
                        }
                    }
                }),
            ],
            final_message: String::new(),
            terminal_error: None,
        };

        assert_eq!(
            evaluate_llm_artifact_turn(&output, "krea", RemoteMcpMediaKind::Video, &[]),
            LlmArtifactTurnEvaluation::Ready(RemoteArtifactSource::Url(
                "https://cdn.example.com/completed.mp4".to_string()
            ))
        );
    }

    #[test]
    fn final_direct_url_beats_tool_shared_page_as_last_resort() {
        let mut tool_candidates = ArtifactSourceCandidates::default();
        tool_candidates.push_fallback(RemoteArtifactSource::Url(
            "https://studio.example.com/creations/123".to_string(),
        ));
        let sources = select_llm_artifact_sources(
            tool_candidates,
            "https://cdn.example.com/final.webm",
            RemoteMcpMediaKind::Video,
        );

        assert_eq!(
            sources,
            vec![RemoteArtifactSource::Url(
                "https://cdn.example.com/final.webm".to_string()
            )]
        );
    }

    #[test]
    fn llm_artifact_parser_reads_base64_and_tool_errors() {
        let items = vec![
            json!({
                "type": "mcpToolCall",
                "server": "krea",
                "tool": "generate",
                "status": "failed",
                "result": {
                    "isError": true,
                    "content": [{"type": "text", "text": "残高が不足しています"}]
                }
            }),
            json!({
                "type": "mcpToolCall",
                "server": "krea",
                "tool": "generate",
                "status": "completed",
                "result": {
                    "content": [{
                        "type": "image",
                        "data": "aW1hZ2U=",
                        "mimeType": "image/png"
                    }]
                }
            }),
        ];
        let (sources, errors) =
            extract_llm_tool_artifacts(&items, "krea", RemoteMcpMediaKind::Image, &[]);

        assert_eq!(
            sources,
            vec![RemoteArtifactSource::InlineImage {
                mime_type: "image/png".to_string(),
                data_base64: "aW1hZ2U=".to_string(),
            }]
        );
        assert_eq!(errors, vec!["残高が不足しています".to_string()]);
    }

    #[test]
    fn llm_artifact_parser_reads_local_path_but_excludes_reference() {
        let path = std::env::temp_dir().join(format!(
            "gori-remote-mcp-{}-{}.png",
            std::process::id(),
            REMOTE_FILE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::write(&path, b"image").expect("temporary image");
        let path_text = path.to_string_lossy().into_owned();
        let items = vec![json!({
            "type": "mcpToolCall",
            "server": "krea",
            "status": "completed",
            "result": {
                "content": [{"type": "text", "text": format!("保存先: {path_text}")}]
            }
        })];

        let (sources, _) =
            extract_llm_tool_artifacts(&items, "krea", RemoteMcpMediaKind::Image, &[]);
        assert_eq!(
            sources,
            vec![RemoteArtifactSource::LocalPath(normalized_local_path(
                &path
            ))]
        );

        let (excluded, _) = extract_llm_tool_artifacts(
            &items,
            "krea",
            RemoteMcpMediaKind::Image,
            std::slice::from_ref(&path_text),
        );
        assert!(excluded.is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn final_report_url_is_only_a_fallback() {
        let mut tool_sources = vec![RemoteArtifactSource::Url(
            "https://cdn.example.com/tool.png".to_string(),
        )];
        apply_final_report_url_fallback(&mut tool_sources, "https://cdn.example.com/final.png");
        assert_eq!(tool_sources.len(), 1);

        let mut empty = Vec::new();
        apply_final_report_url_fallback(&mut empty, "https://cdn.example.com/final.png");
        assert_eq!(
            empty,
            vec![RemoteArtifactSource::Url(
                "https://cdn.example.com/final.png".to_string()
            )]
        );
    }

    #[test]
    fn llm_prompt_requires_tool_search_and_fixed_generation_contract() {
        let prompt = build_remote_mcp_llm_prompt(
            "Krea",
            RemoteMcpMediaKind::Video,
            "白い餅が跳ねる",
            Some("Flux 3 Video"),
            Some(5.0),
            Some("16:9"),
            None,
            &["/tmp/reference.png".to_string()],
        );

        // 2026-08-23 実測で強化した契約（AIの手抜き4パターン対策）を固定する。
        assert!(prompt.contains("tool_search で Krea のツールを必ず検索・ロード"));
        assert!(prompt.contains("検索語を変えて複数回"));
        assert!(prompt.contains("Krea のMCPツールで動画を生成せよ"));
        assert!(prompt.contains("生成は1枚だけ"));
        assert!(prompt.contains("指示文: 白い餅が跳ねる"));
        assert!(prompt.contains("モデル: Flux 3 Video / 尺: 5秒 / 比率: 16:9"));
        assert!(prompt.contains("Krea 以外のサービスのツールと内蔵 image_gen の使用は禁止"));
        assert!(prompt.contains("完了するまでポーリングを続けよ"));
        assert!(prompt.contains(
            "ツール結果の url フィールドにあるファイル直リンクのダウンロードURLを**1件だけ**報告せよ"
        ));
        assert!(prompt.contains("共有ページ・プレビューURLは報告しない"));
        assert!(prompt.ends_with("ツール呼び出し以外の創作はするな"));

        let resolution_prompt = build_remote_mcp_llm_prompt(
            "Krea",
            RemoteMcpMediaKind::Video,
            "白い餅が跳ねる",
            Some("Flux 3 Video"),
            Some(5.0),
            Some("16:9"),
            Some("1080p"),
            &[],
        );
        assert!(resolution_prompt.ends_with("\n解像度: 1080p で生成せよ。"));
        assert_eq!(resolution_prompt.matches("解像度:").count(), 1);
    }

    fn mock_video_turn(
        status: &str,
        url: Option<&str>,
    ) -> crate::codex::gen_server::LlmToolTurnOutput {
        let mut structured = json!({
            "status": status,
            "identifier": "job-123"
        });
        if let Some(url) = url {
            structured["url"] = Value::String(url.to_string());
        }
        crate::codex::gen_server::LlmToolTurnOutput {
            completed_items: vec![json!({
                "type": "mcpToolCall",
                "server": "krea",
                "tool": "video_status",
                "status": "completed",
                "result": { "structuredContent": structured }
            })],
            final_message: format!("状態: {status}"),
            terminal_error: None,
        }
    }

    #[test]
    fn processing_turn_uses_one_follow_up_mock_and_accepts_its_url() {
        let mut mock_turns = std::collections::VecDeque::from([
            mock_video_turn("processing", None),
            mock_video_turn("completed", Some("https://cdn.example.com/final.mp4")),
        ]);
        let mut output = mock_turns.pop_front().expect("initial turn");
        let mut follow_ups = 0usize;

        let source = loop {
            match evaluate_llm_artifact_turn(&output, "krea", RemoteMcpMediaKind::Video, &[]) {
                LlmArtifactTurnEvaluation::Ready(source) => break source,
                LlmArtifactTurnEvaluation::Processing { identifier, .. } => {
                    output.final_message = "x".repeat(GENERATION_MESSAGE_LIMIT_CHARS + 100);
                    let prompt = build_processing_follow_up_prompt(
                        "Krea",
                        "krea",
                        &output,
                        &identifier,
                        follow_ups + 1,
                    );
                    assert!(prompt.contains("新しい生成ジョブは開始するな"));
                    assert!(prompt.contains("専用ジョブ識別子（identifier）"));
                    assert!(prompt.contains("job-123"));
                    output = mock_turns.pop_front().expect("follow-up turn");
                    follow_ups += 1;
                }
                LlmArtifactTurnEvaluation::Failed(error) => panic!("unexpected failure: {error}"),
            }
        };

        assert_eq!(follow_ups, 1);
        assert_eq!(
            source,
            RemoteArtifactSource::Url("https://cdn.example.com/final.mp4".to_string())
        );
    }

    #[test]
    fn processing_turn_with_job_id_and_url_requires_follow_up() {
        assert!(matches!(
            evaluate_llm_artifact_turn(
                &mock_video_turn(
                    "processing",
                    Some("https://cdn.example.com/not-ready-yet.mp4"),
                ),
                "krea",
                RemoteMcpMediaKind::Video,
                &[],
            ),
            LlmArtifactTurnEvaluation::Processing {
                identifier: ProviderJobIdentifier { ref value, .. },
                ..
            } if value == "job-123"
        ));
    }

    #[test]
    fn job_identifier_is_extracted_mechanically_from_supported_fields() {
        assert_eq!(
            extract_job_identifier(&json!({"result": {"identifier": "id-1"}})),
            Some(ProviderJobIdentifier {
                field: "identifier",
                value: "id-1".to_string(),
            })
        );
        assert_eq!(
            extract_job_identifier(&json!({"structuredContent": {"job_id": 42}})),
            Some(ProviderJobIdentifier {
                field: "jobId",
                value: "42".to_string(),
            })
        );
        assert_eq!(
            extract_job_identifier(&Value::String(r#"{"taskId":"task-9"}"#.to_string())),
            Some(ProviderJobIdentifier {
                field: "taskId",
                value: "task-9".to_string(),
            })
        );
        assert_eq!(extract_job_identifier(&json!({"id": "too-broad"})), None);
    }

    #[test]
    fn processing_follow_up_requires_successful_explicit_status_and_identifier() {
        assert!(matches!(
            evaluate_llm_artifact_turn(
                &mock_video_turn("processing", None),
                "krea",
                RemoteMcpMediaKind::Video,
                &[],
            ),
            LlmArtifactTurnEvaluation::Processing { .. }
        ));

        let missing_identifier = crate::codex::gen_server::LlmToolTurnOutput {
            completed_items: vec![json!({
                "type": "mcpToolCall",
                "server": "krea",
                "status": "completed",
                "result": {"structuredContent": {"status": "processing"}}
            })],
            final_message: "状態: processing".to_string(),
            terminal_error: None,
        };
        assert!(matches!(
            evaluate_llm_artifact_turn(&missing_identifier, "krea", RemoteMcpMediaKind::Video, &[],),
            LlmArtifactTurnEvaluation::Failed(_)
        ));

        let report_only = crate::codex::gen_server::LlmToolTurnOutput {
            completed_items: vec![],
            final_message: "status: processing / identifier: job-report-only".to_string(),
            terminal_error: None,
        };
        assert!(matches!(
            evaluate_llm_artifact_turn(&report_only, "krea", RemoteMcpMediaKind::Video, &[],),
            LlmArtifactTurnEvaluation::Failed(_)
        ));

        assert!(matches!(
            evaluate_llm_artifact_turn(
                &mock_video_turn("failed", None),
                "krea",
                RemoteMcpMediaKind::Video,
                &[],
            ),
            LlmArtifactTurnEvaluation::Failed(_)
        ));

        let is_error = crate::codex::gen_server::LlmToolTurnOutput {
            completed_items: vec![json!({
                "type": "mcpToolCall",
                "server": "krea",
                "status": "completed",
                "result": {
                    "isError": true,
                    "structuredContent": {
                        "status": "processing",
                        "jobId": "must-not-follow"
                    }
                }
            })],
            final_message: "処理中".to_string(),
            terminal_error: None,
        };
        assert!(matches!(
            evaluate_llm_artifact_turn(&is_error, "krea", RemoteMcpMediaKind::Video, &[],),
            LlmArtifactTurnEvaluation::Failed(_)
        ));
    }

    #[test]
    fn processing_turn_stops_after_two_follow_ups_with_retry_later_message() {
        assert_eq!(PROCESSING_FOLLOW_UP_DELAYS_SECS, [30, 60]);
        let mut mock_follow_ups = std::collections::VecDeque::from([
            mock_video_turn("processing", None),
            mock_video_turn("processing", None),
        ]);
        let mut output = mock_video_turn("processing", None);
        let mut follow_ups = 0usize;

        let error = loop {
            match evaluate_llm_artifact_turn(&output, "krea", RemoteMcpMediaKind::Video, &[]) {
                LlmArtifactTurnEvaluation::Processing { tool_errors, .. } => {
                    if follow_ups == PROCESSING_FOLLOW_UP_DELAYS_SECS.len() {
                        break processing_retry_exhausted_message(
                            RemoteMcpMediaKind::Video,
                            &output,
                            &tool_errors,
                        );
                    }
                    output = mock_follow_ups.pop_front().expect("bounded follow-up");
                    follow_ups += 1;
                }
                other => panic!("unexpected evaluation: {other:?}"),
            }
        };

        assert_eq!(follow_ups, 2);
        assert!(error.contains("時間をおいて再生成してください"));
    }

    #[test]
    fn download_retries_only_auth_failures_and_mentions_shared_page_risk() {
        assert!(should_retry_download_status(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert!(should_retry_download_status(reqwest::StatusCode::FORBIDDEN));
        assert!(!should_retry_download_status(
            reqwest::StatusCode::NOT_FOUND
        ));

        let message = http_download_failure_message(
            RemoteMcpMediaKind::Video,
            reqwest::StatusCode::FORBIDDEN,
            "https://studio.example.com/creations/123",
        );
        assert!(message.contains("HTTP 403 Forbidden"));
        assert!(message.contains("共有ページのURLの可能性"));
    }

    #[tokio::test]
    async fn transient_download_retries_404_after_two_seconds_and_stops_after_three_retries() {
        let mut statuses = std::collections::VecDeque::from([
            reqwest::StatusCode::NOT_FOUND,
            reqwest::StatusCode::OK,
        ]);
        let mut delays = Vec::new();
        let status = retry_transient_download(
            || std::future::ready(Ok::<_, ()>(statuses.pop_front().expect("mock response"))),
            |status| should_retry_transient_download_status(*status),
            |delay| {
                delays.push(delay);
                std::future::ready(())
            },
        )
        .await
        .unwrap();
        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(delays, vec![Duration::from_secs(2)]);

        let mut attempts = 0;
        let mut permanent_delays = Vec::new();
        let status = retry_transient_download(
            || {
                attempts += 1;
                std::future::ready(Ok::<_, ()>(reqwest::StatusCode::NOT_FOUND))
            },
            |status| should_retry_transient_download_status(*status),
            |delay| {
                permanent_delays.push(delay);
                std::future::ready(())
            },
        )
        .await
        .unwrap();
        assert_eq!(status, reqwest::StatusCode::NOT_FOUND);
        assert_eq!(attempts, 4);
        assert_eq!(
            permanent_delays,
            vec![
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
            ]
        );
    }

    #[test]
    fn download_failure_mentions_host_and_path_tail_without_query() {
        let message = http_download_failure_message(
            RemoteMcpMediaKind::Video,
            reqwest::StatusCode::NOT_FOUND,
            "https://cdn.example.com/private/jobs/final.mp4?X-Amz-Signature=secret",
        );
        assert!(message.contains("HTTP 404 Not Found"));
        assert!(message.contains("cdn.example.com/…/final.mp4"));
        assert!(!message.contains("X-Amz-Signature"));
        assert!(!message.contains("secret"));
    }

    #[test]
    fn content_parser_returns_provider_error_instead_of_success() {
        let output = tool_output(
            vec![json!({"type": "text", "text": "残高が不足しています"})],
            None,
            "残高が不足しています",
            true,
        );
        let error = extract_remote_artifacts(&output, RemoteMcpMediaKind::Image).unwrap_err();
        assert!(error.contains("残高が不足"));
    }

    #[test]
    fn generation_error_is_redacted_and_truncated() {
        let raw = format!(
            "token=sk-must-not-leak\n{}",
            "長".repeat(GENERATION_MESSAGE_LIMIT_CHARS + 100)
        );
        let sanitized = sanitize_generation_message(&raw);
        assert!(!sanitized.contains("sk-must-not-leak"));
        assert!(sanitized.chars().count() <= GENERATION_MESSAGE_LIMIT_CHARS);
    }

    #[test]
    fn tool_list_uses_official_input_schema() {
        let list = tool_list_from_server(
            "runway",
            &json!({
                "authStatus": "oAuth",
                "tools": {
                    "generate": {
                        "name": "generate",
                        "title": "Generate",
                        "description": "動画を生成",
                        "inputSchema": {"type": "object", "required": ["prompt"]}
                    }
                }
            }),
        )
        .unwrap();
        assert_eq!(list.auth_status, "oAuth");
        assert_eq!(list.tools[0].name, "generate");
        assert_eq!(
            list.tools[0].input_schema_json,
            r#"{"required":["prompt"],"type":"object"}"#
        );
    }

    #[test]
    fn empty_tool_list_is_not_persisted_and_cache_can_be_invalidated() {
        let empty = tool_list_from_server(
            "krea",
            &json!({
                "authStatus": "oAuth",
                "tools": {}
            }),
        )
        .unwrap();
        assert!(!should_persist_tool_list(&empty));

        let path = std::env::temp_dir().join(format!(
            "gori-remote-mcp-tools-{}-{}.json",
            std::process::id(),
            REMOTE_FILE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::write(&path, b"cached tools").expect("temporary tool cache");
        remove_tool_list_cache(&path).expect("cache invalidation");
        assert!(!path.exists());
        remove_tool_list_cache(&path).expect("missing cache is already invalidated");
    }

    #[tokio::test]
    async fn login_rejects_unknown_provider_before_spawning_codex() {
        let state = AppState::default();
        let result = login_provider("unknown-provider", &state).await;
        assert!(result.is_err());
    }
}
