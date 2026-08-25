//! Magnific オプショナル拡張 (2026-06-10 直接呼び出し版)。
//!
//! ## 設計の鉄則
//! - コア (codex/gpt-image-2) には一切手を入れない。これは全員が使う土台。
//! - Magnific は「持ってる人だけ」のオプショナル拡張。未接続なら存在しないかのように degrade する。
//! - 接続済みかどうかは `codex mcp list` の magnific 行で判定する。
//!
//! ## アーキテクチャ (LLM 仲介の全廃・higgsfield_mcp.rs と同方針)
//!
//! v1.1.0 までは `codex exec` で gpt-5.5 に「images_generate を呼んで URL だけ返して」と
//! お願いする LLM 仲介方式だった。確率的失敗 (ツール未呼び出し/URL 以外を返す) と
//! 30 秒超の余計な待ちが乗るため、app-server の `mcpServer/tool/call`
//! (crate::codex::mcp_direct) で **LLM を介さず決定論的に** ツールを呼ぶ。
//!
//! ## 実機で確定済みの事実 (PoC 2026-06-10、推測ゼロ)
//! - Magnific のツール arguments は **トップレベル直** (Higgsfield と違い params ラッパー無し)。
//! - `images_generate` {prompt, mode(モデル slug), aspectRatio, count(1-8), references[]}
//!   → structuredContent.creations[].identifier (status: "queued")。実測 5.6 秒で投入完了。
//! - `creations_wait` {identifiers[], timeoutSeconds(<=25)} → structuredContent.results[]
//!   .{identifier, status, results.url} + allTerminal。long-poll なのでクライアント sleep 最小。
//! - 参照画像 (ローカルファイル): `creations_request_upload` {mimeType} →
//!   {proxyUploadUrl, path} → その URL へ HTTP PUT (Content-Type 必須) →
//!   (2026-08-06 実測: 現行 MCP のキー名は **proxyUploadUrl**。PoC 当時の
//!    `directUploadUrl` はもう返らず、固定キー読みだと参照生成が全滅した)
//!   `creations_finalize_upload` {path} → {identifier} → images_generate の
//!   references: [{type: "image", identifier}]。
//! - `account_balance` {} → {plan: {tier, isUnlimitedMode}, credits: {available, ...}}。
//!   (v1.1.0 時点の「MCP が credit を返さない」は旧情報。現 MCP は残高を返す)

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::codex::mcp_direct::{
    call_tool, call_tool_once_with_timeout, call_tool_with_timeout, list_mcp_server_status_page,
    reload_mcp_servers,
};
use crate::codex::mcp_shared::{
    entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_capture,
};
use crate::state::AppState;

const MAGNIFIC_MCP_NAME: &str = "magnific";
const MAGNIFIC_MCP_URL: &str = "https://mcp.magnific.com";
const ORPHAN_CHARGE_GUIDANCE: &str = "サービス側では生成が完了している可能性があります（クレジット消費済みの場合あり）。再生成の前に各サービスの履歴をご確認ください";

fn with_orphan_charge_guidance(message: impl AsRef<str>) -> String {
    format!("{}。{ORPHAN_CHARGE_GUIDANCE}", message.as_ref())
}

/// Magnific 拡張の接続状態。未接続なら全 false で UI が degrade する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificStatus {
    /// config.toml に magnific MCP が登録されているか。
    pub registered: bool,
    /// OAuth 認証済みか (codex mcp list の Auth 列が OAuth かつ enabled)。
    pub authenticated: bool,
}

/// 全 false の未接続状態 (degrade 用)。codex 不在・実行失敗・JSON 解析失敗の
/// いずれでも起動を止めず、Magnific を「持っていない」扱いにする。
fn magnific_status_unavailable() -> MagnificStatus {
    MagnificStatus {
        registered: false,
        authenticated: false,
    }
}

/// `codex mcp list --json` の要素から magnific の認証状態を読み取る。
///
/// auth_status は "o_auth"(アンダースコア入り) のことがある (実機確認 2026-06-10)。
/// entry_is_authenticated が区切り文字を除去して "oauth" 系を一律で拾う。
fn parse_magnific_status(stdout: &[u8]) -> MagnificStatus {
    let Some(entry) = find_mcp_entry(stdout, MAGNIFIC_MCP_NAME) else {
        // magnific ノードが無い = 未登録 / JSON 解析失敗 (degrade)。
        return magnific_status_unavailable();
    };
    MagnificStatus {
        registered: true,
        authenticated: entry_is_authenticated(&entry),
    }
}

/// Magnific 拡張の接続状態を返す。失敗しても起動を止めず、未接続として degrade する。
#[tauri::command]
pub async fn magnific_status() -> Result<MagnificStatus, String> {
    let mut cmd = match gori_codex_command() {
        Ok(c) => c,
        // codex が無い環境では「未接続」として扱う (コアは別経路なので影響しない)。
        Err(_) => return Ok(magnific_status_unavailable()),
    };
    cmd.args(["mcp", "list", "--json"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return Ok(magnific_status_unavailable()),
    };
    // `mcp list` はローカル config を読むだけなので速いが、念のため上限を設ける。
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            // 実行失敗・タイムアウトとも未接続として degrade。
            _ => return Ok(magnific_status_unavailable()),
        };

    Ok(parse_magnific_status(&output.stdout))
}

/// `codex mcp login` の OAuth がブラウザ完了までブロックしうる上限。
const MAGNIFIC_LOGIN_TIMEOUT_SECS: u64 = 180;

/// Magnific MCP を登録し OAuth 認証を起動する。
///
/// ① 未登録なら add → ② login の 2 段階。成功時は稼働中 app-server に
/// config/mcpServer/reload を発行し、**アプリ再起動なしで** 直接呼び出し (生成・残高) が
/// 効くようにする。
#[tauri::command]
pub async fn magnific_login(state: State<'_, AppState>) -> Result<String, String> {
    // ① 登録 (mcp add)。既に登録済みだと codex が非ゼロ終了することがあるが、
    //    それはエラーにせず login に進む (冪等性)。
    //
    //    2026-08-15: 認可専用バイナリによる二段構えは撤去済み。issuer バグ修正が
    //    同梱 CLI (0.147.0 安定版) に入ったので、認可も日常実行も同じバイナリを使う。
    let add = run_codex_capture(
        &["mcp", "add", MAGNIFIC_MCP_NAME, "--url", MAGNIFIC_MCP_URL],
        std::time::Duration::from_secs(30),
    )
    .await?;
    if !add.0 {
        let lower = format!("{} {}", add.1, add.2).to_lowercase();
        let already_registered =
            lower.contains("already") || lower.contains("exist") || lower.contains("既に");
        if !already_registered {
            tracing::warn!(target: "magnific", "mcp add 非ゼロ終了 (login で再試行): {}", add.2);
        }
    }

    // ② OAuth 認証 (mcp login)。ブラウザが開き、ユーザーがログインする。
    let login = run_codex_capture(
        &["mcp", "login", MAGNIFIC_MCP_NAME],
        std::time::Duration::from_secs(MAGNIFIC_LOGIN_TIMEOUT_SECS),
    )
    .await?;

    if login.0 {
        // ③ 常駐 app-server に MCP 設定を再読込させる (再起動なしで生成可能に)。
        reload_mcp_servers(&state).await;
        Ok(if login.1.is_empty() {
            "Magnific の認証が完了しました。".to_string()
        } else {
            login.1
        })
    } else if login.2.contains("missing required issuer") {
        // 古い同梱 CLI (0.143〜0.146。OAuth コールバックの iss を捨てる) が使われた
        // 場合の症状。0.147.0 一本化 (2026-08-15) 以降は起きない想定だが、旧版の
        // アプリが残っている経路のために残す。ユーザーには「アプリを更新する」を示す。
        Err("Magnific の認証に失敗しました。アプリ内の接続コンポーネントが見つからないか古い可能性があります。アプリを最新版に更新してから、もう一度お試しください。".to_string())
    } else {
        Err(if login.2.is_empty() {
            "Magnific の認証に失敗しました。ブラウザでのログインを完了したか確認してください。"
                .to_string()
        } else {
            login.2
        })
    }
}

/// Magnific MCP の登録を解除する (codex mcp remove)。解除後は app-server にも
/// 再読込させ、直接呼び出し経路からも消す。
#[tauri::command]
pub async fn magnific_logout(state: State<'_, AppState>) -> Result<(), String> {
    let _ = run_codex_capture(
        &["mcp", "remove", MAGNIFIC_MCP_NAME],
        std::time::Duration::from_secs(30),
    )
    .await?;
    reload_mcp_servers(&state).await;
    Ok(())
}

/// Magnific の画像モデル一覧。接続済みのときだけモデル選択 UI に追加される。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificModel {
    pub id: String,
    pub name: String,
}

/// Magnific 生成の結果。コアの BatchGenResult と同じ形に揃えてフロントが区別不要にする。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificGenResult {
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificGenArgs {
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub ref_image_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificVideoModelsResult {
    pub content_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema_json: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificVideoGenArgs {
    pub params_json: String,
    #[serde(default)]
    pub local_image_paths: Vec<String>,
}

const MAGNIFIC_VIDEO_QUERY_TIMEOUT_SECS: u64 = 60;
const MAGNIFIC_VIDEO_GENERATION_TIMEOUT_SECS: u64 = 15 * 60;
const MAGNIFIC_VIDEO_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const MAGNIFIC_VIDEO_DOWNLOAD_MAX_BYTES: usize = 512 * 1024 * 1024;
const MAGNIFIC_VIDEO_ERROR_LIMIT_CHARS: usize = 4_000;

fn sanitize_magnific_video_message(message: &str) -> String {
    super::diagnostics::redact_text(message, dirs::home_dir().as_deref())
        .chars()
        .take(MAGNIFIC_VIDEO_ERROR_LIMIT_CHARS)
        .collect()
}

/// app-server の正規一覧から Magnific の1ツールの inputSchema を取る。
/// 取得不能でもモデル一覧自体は返し、UIでは仕様を「未取得」と表示する。
async fn magnific_tool_input_schema(
    state: &AppState,
    tool_name: &str,
) -> Result<Option<String>, String> {
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    loop {
        let page = list_mcp_server_status_page(state, cursor.as_deref()).await?;
        let servers = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "MCP 一覧の data が不正です".to_string())?;
        if let Some(server) = servers
            .iter()
            .find(|server| server.get("name").and_then(Value::as_str) == Some(MAGNIFIC_MCP_NAME))
        {
            let tools = server.get("tools").and_then(Value::as_object);
            let tool = tools.and_then(|tools| {
                tools.get(tool_name).or_else(|| {
                    tools
                        .values()
                        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name))
                })
            });
            return tool
                .and_then(|tool| tool.get("inputSchema"))
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| {
                    format!("{tool_name} の入力形式をJSON化できませんでした: {error}")
                });
        }

        let next = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let Some(next) = next else {
            return Ok(None);
        };
        if !seen.insert(next.clone()) {
            return Err("MCP 一覧のページ情報が循環しました".to_string());
        }
        cursor = Some(next);
    }
}

/// Magnific MCP の動画モデル一覧を保存せず、そのままフロントへ返す。
#[tauri::command]
pub async fn magnific_video_models_list(
    state: State<'_, AppState>,
) -> Result<MagnificVideoModelsResult, String> {
    let output = call_tool_with_timeout(
        &state,
        MAGNIFIC_MCP_NAME,
        "video_models_list",
        json!({}),
        Duration::from_secs(MAGNIFIC_VIDEO_QUERY_TIMEOUT_SECS),
    )
    .await
    .map_err(|error| sanitize_magnific_video_message(&error))?;
    if output.is_error {
        return Err(sanitize_magnific_video_message(
            if output.text.trim().is_empty() {
                "Magnific の動画モデル一覧を取得できませんでした"
            } else {
                &output.text
            },
        ));
    }

    let input_schema_json = match magnific_tool_input_schema(&state, "video_generate").await {
        Ok(schema) => schema,
        Err(error) => {
            tracing::warn!(target: "magnific", "video_generate の入力形式を取得できませんでした: {}", sanitize_magnific_video_message(&error));
            None
        }
    };
    Ok(MagnificVideoModelsResult {
        content_text: output.text,
        structured_content: output.structured,
        input_schema_json,
    })
}

/// ローカル参照画像の拡張子から Magnific が受け付ける MIME type を返す。
/// creations_request_upload の mimeType は enum 制約があるため、未対応形式は None。
fn magnific_mime_for_path(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
}

/// `creations_request_upload` の応答からアップロード先 URL を取り出す。
///
/// 2026-08-06: 固定キー `directUploadUrl` 読みを廃止した。現行 MCP は
/// **`proxyUploadUrl`** を返すため、固定キーだと参照つき生成が必ず全滅していた
/// (参照なしはこの関数を通らないので成功する = 「参照つけると失敗」の正体)。
///
/// `parse_magnific_credits` と同じ多キー・フォールバック方針で読む:
/// 現行 → 旧 PoC → 一般名 → 最後に「http で始まる文字列値」を拾う。
/// 見つからなければ `None` を返し、呼び出し側がキー構成付きでエラーにする
/// (推測で埋めない・無言 degrade しない)。
fn extract_upload_url(structured: &Value) -> Option<String> {
    for key in [
        "proxyUploadUrl",  // 現行 (2026-08-06 実測)
        "directUploadUrl", // 旧 PoC (2026-06-10)。復活・併存に備え残す
        "uploadUrl",
        "url",
        "putUrl",
        "signedUrl",
    ] {
        if let Some(v) = structured.get(key).and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                return Some(v.to_string());
            }
        }
    }
    // キー名が再び変わっても止まらないための最後の砦: トップレベルの
    // 「http(s) で始まる文字列値」を1つ拾う (path は URL ではないので当たらない)。
    structured.as_object().and_then(|obj| {
        obj.iter()
            .filter(|(k, _)| k.as_str() != "path")
            .find_map(|(_, v)| {
                v.as_str()
                    .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
                    .map(|s| s.to_string())
            })
    })
}

/// 参照画像 1 枚を request_upload → HTTP PUT → finalize_upload で creation identifier 化する。
/// (PoC 実証済みフロー。アップロード URL への PUT は Content-Type ヘッダ必須)
async fn upload_magnific_reference(
    state: &AppState,
    http: &reqwest::Client,
    path: &str,
) -> Result<String, String> {
    let mime = magnific_mime_for_path(path)
        .ok_or_else(|| format!("Magnific の参照画像は PNG / JPEG / WebP のみ対応です ({path})"))?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("参照画像を読み込めませんでした ({path}): {e}"))?;

    // ① アップロード URL + path を発行
    let out = call_tool(
        state,
        MAGNIFIC_MCP_NAME,
        "creations_request_upload",
        json!({ "mimeType": mime }),
    )
    .await?;
    if out.is_error {
        return Err(format!(
            "参照画像のアップロード準備に失敗しました: {}",
            out.text
        ));
    }
    let structured = out.structured.unwrap_or(Value::Null);
    // キー名が変わっても止まらないよう多キーで読む。読めなかったときは受信した
    // **キー構成だけ** を添える (値は出さない = 署名付き URL を漏らさない)。
    let upload_url = extract_upload_url(&structured).ok_or_else(|| {
        format!(
            "参照画像のアップロード先URLを取得できませんでした。受信したキー構成: {}",
            magnific_describe_shape(&structured)
        )
    })?;
    let upload_path = structured
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            format!(
                "参照画像のアップロード先パスを取得できませんでした。受信したキー構成: {}",
                magnific_describe_shape(&structured)
            )
        })?
        .to_string();

    // ② 発行 URL へ PUT (presigned URL は Content-Type が署名に含まれるため必須)
    let res = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("参照画像のアップロードに失敗しました: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "参照画像のアップロードに失敗しました (HTTP {})",
            res.status()
        ));
    }

    // ③ finalize して creation identifier を得る
    let out = call_tool(
        state,
        MAGNIFIC_MCP_NAME,
        "creations_finalize_upload",
        json!({ "path": upload_path }),
    )
    .await?;
    if out.is_error {
        return Err(format!("参照画像の確定に失敗しました: {}", out.text));
    }
    let identifier = out
        .structured
        .as_ref()
        .and_then(|s| s.get("identifier"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            format!(
                "参照画像の確定後、識別子を取得できませんでした。受信したキー構成: {}",
                magnific_describe_shape(out.structured.as_ref().unwrap_or(&Value::Null))
            )
        })?;
    // 参照経路は今まで完全に無音で、実機ログに痕跡が残らなかった (2026-08-06)。
    // ファイル名だけ出す (署名付き URL・画像の中身は出さない)。
    tracing::info!(
        target: "magnific",
        "参照画像をアップロードしました: {}",
        std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "(不明)".to_string())
    );
    Ok(identifier)
}

/// images_generate の応答 structuredContent.creations[] から identifier を集める。
fn extract_creation_ids(structured: Option<&Value>) -> Vec<String> {
    let from_array: Vec<String> = structured
        .and_then(|s| s.get("creations"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    c.get("identifier")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    if !from_array.is_empty() {
        return from_array;
    }
    // 編集系ツール (images_change_camera / images_relight / images_expand /
    // images_upscale) は `creation` (単数オブジェクト) で返す (2026-08-26 実測:
    // {"creation":{"identifier":"...","status":"processing",...}})。
    structured
        .and_then(|s| s.get("creation"))
        .and_then(|c| c.get("identifier"))
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

/// creations_wait の 1 エントリ。terminal (completed/failed) かどうかと結果 URL を返す。
struct WaitEntry {
    identifier: String,
    terminal: bool,
    url: Option<String>,
    error: Option<String>,
}

/// creations_wait 応答 structuredContent.results[] をパースする。
fn parse_wait_results(structured: Option<&Value>) -> Vec<WaitEntry> {
    let Some(results) = structured
        .and_then(|s| s.get("results"))
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };
    results
        .iter()
        .filter_map(|r| {
            let identifier = r.get("identifier").and_then(|v| v.as_str())?.to_string();
            let status = r
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let url = r
                .get("results")
                .and_then(|res| res.get("url"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let entry = match status.as_str() {
                "completed" => WaitEntry {
                    identifier,
                    terminal: true,
                    url,
                    error: None,
                },
                "failed" | "error" | "cancelled" | "canceled" | "nsfw" => WaitEntry {
                    identifier,
                    terminal: true,
                    url: None,
                    // 実 API は失敗理由を failureReason で返す (2026-08-26 実測:
                    // {"status":"failed","failureReason":"NSFW: Content detected"})。
                    // error は旧形の保険として残す。NSFW はそのまま出すと英語かつ
                    // 意味が伝わらないため、日本語の説明に置き換える。
                    error: Some(
                        r.get("failureReason")
                            .or_else(|| r.get("error"))
                            .and_then(|v| v.as_str())
                            .map(|reason| {
                                if reason.to_ascii_lowercase().contains("nsfw") {
                                    "画像の内容が Magnific の生成ポリシーに触れたため処理できませんでした".to_string()
                                } else {
                                    reason.to_string()
                                }
                            })
                            .unwrap_or_else(|| format!("生成が {status} で終了しました")),
                    ),
                },
                // queued / processing 等は未終端。
                _ => WaitEntry {
                    identifier,
                    terminal: false,
                    url: None,
                    error: None,
                },
            };
            Some(entry)
        })
        .collect()
}

const MAGNIFIC_IMAGE_EDIT_TIMEOUT_SECS: u64 = 300;
const MAGNIFIC_IMAGE_EDIT_ERROR_LIMIT_CHARS: usize = 700;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MagnificImageEditTool {
    Expand,
    Camera,
    Relight,
    Upscale,
}

impl MagnificImageEditTool {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "expand" => Ok(Self::Expand),
            "camera" => Ok(Self::Camera),
            "relight" => Ok(Self::Relight),
            "upscale" => Ok(Self::Upscale),
            _ => Err("Magnific の編集ツールが正しくありません".to_string()),
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Expand => "expand",
            Self::Camera => "camera",
            Self::Relight => "relight",
            Self::Upscale => "upscale",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Expand => "拡張",
            Self::Camera => "カメラ",
            Self::Relight => "ライティング",
            Self::Upscale => "高画質化",
        }
    }

    fn mcp_tool(self) -> &'static str {
        match self {
            Self::Expand => "images_expand",
            Self::Camera => "images_change_camera",
            Self::Relight => "images_relight",
            Self::Upscale => "images_upscale",
        }
    }
}

/// Magnific の生エラーからホームディレクトリ等を隠し、編集画面に収まる長さへ縮める。
fn sanitize_magnific_image_edit_message(message: &str) -> String {
    sanitize_magnific_video_message(message)
        .chars()
        .take(MAGNIFIC_IMAGE_EDIT_ERROR_LIMIT_CHARS)
        .collect()
}

fn short_magnific_image_edit_detail(message: &str) -> String {
    // rpc/transport の内部ダンプはユーザーに読ませない (2026-08-26 実害:
    // "rpc error -32603 ... Transport [rmcp::transport::worker::...]" が UI に全文出た)。
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("transport")
        || lowered.contains("rpc error")
        || lowered.contains("rmcp::")
    {
        return "Magnific との通信が途切れました。少し待ってからもう一度お試しください。".to_string();
    }
    sanitize_magnific_video_message(message)
        .chars()
        .take(240)
        .collect()
}

fn clamped_integer_param(params: &Value, key: &str, default: i64, min: i64, max: i64) -> i64 {
    params
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.round().clamp(min as f64, max as f64) as i64)
        .unwrap_or(default)
}

fn nearest_allowed(value: i64, allowed: &[i64]) -> i64 {
    allowed
        .iter()
        .copied()
        .min_by_key(|candidate| (value - candidate).abs())
        .unwrap_or(value)
}

/// フロントから受け取った params を、各 Magnific ツールの許可キーだけに組み直す。
/// 固定値もここで付与し、未知キーが MCP 側へ漏れないようにする。
fn build_magnific_image_edit_call(
    tool: MagnificImageEditTool,
    creation_identifier: &str,
    params: &Value,
) -> (&'static str, Value) {
    let arguments = match tool {
        MagnificImageEditTool::Expand => {
            let allowed_aspects = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
            let aspect_ratio = params
                .get("aspectRatio")
                .and_then(Value::as_str)
                .filter(|value| allowed_aspects.contains(value))
                .unwrap_or("16:9");
            let mut arguments = serde_json::Map::new();
            arguments.insert("creationIdentifier".to_string(), json!(creation_identifier));
            arguments.insert("aspectRatio".to_string(), json!(aspect_ratio));
            if let Some(prompt) = params
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                arguments.insert("prompt".to_string(), json!(prompt));
            }
            Value::Object(arguments)
        }
        MagnificImageEditTool::Camera => json!({
            "creationIdentifier": creation_identifier,
            "rotate": clamped_integer_param(params, "rotate", 45, 0, 360),
            "vertical": clamped_integer_param(params, "vertical", 0, -30, 90),
            "closeup": clamped_integer_param(params, "closeup", 5, 0, 10),
        }),
        MagnificImageEditTool::Relight => {
            let azimuth = nearest_allowed(
                clamped_integer_param(params, "azimuth", 0, -135, 180),
                &[-135, -90, -45, 0, 45, 90, 135, 180],
            );
            let elevation = nearest_allowed(
                clamped_integer_param(params, "elevation", 0, -90, 90),
                &[-90, -45, 0, 45, 90],
            );
            json!({
                "creationIdentifier": creation_identifier,
                "lights": [{
                    "azimuth": azimuth,
                    "elevation": elevation,
                    "intensity": clamped_integer_param(params, "intensity", 5, 1, 10),
                    "type": "neutral",
                }],
                "numImages": 1,
                "resolution": "2k",
            })
        }
        MagnificImageEditTool::Upscale => {
            let scale = params
                .get("scale")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "2x" | "4x"))
                .unwrap_or("2x");
            json!({
                "creationIdentifier": creation_identifier,
                "mode": "creative",
                "scale": scale,
            })
        }
    };
    (tool.mcp_tool(), arguments)
}

/// 編集中の1版を Magnific の専用画像ツールへ直接渡し、完成画像を新しいローカル版として保存する。
/// 課金を伴う編集 submit は自動再送せず、完了確認だけを long-poll する。
#[tauri::command]
pub async fn magnific_image_edit(
    state: State<'_, AppState>,
    source_path: String,
    tool: String,
    params: Value,
) -> Result<Vec<String>, String> {
    let result = async {
        // 未知ツールは画像アップロード前に止める。入力ミスで外部送信しないための allowlist。
        let edit_tool = MagnificImageEditTool::parse(tool.trim())?;
        if source_path.trim().is_empty() {
            return Err("編集する画像が選ばれていません".to_string());
        }

        let base = crate::images::watcher::generated_images_dir()
            .ok_or_else(|| "画像の保存先を準備できませんでした".to_string())?;
        let directory = base.join("magnific");
        std::fs::create_dir_all(&directory)
            .map_err(|_| "画像の保存先を作成できませんでした".to_string())?;
        let http = reqwest::Client::new();

        let creation_identifier = upload_magnific_reference(&state, &http, &source_path)
            .await
            .map_err(|error| {
                format!(
                    "Magnific に編集画像を渡せませんでした: {}",
                    short_magnific_image_edit_detail(&error)
                )
            })?;
        let (mcp_tool, arguments) =
            build_magnific_image_edit_call(edit_tool, &creation_identifier, &params);

        // 課金操作は once 経路。通信エラーやタイムアウトでも同じ編集を自動再送しない。
        let output = call_tool_once_with_timeout(
            &state,
            MAGNIFIC_MCP_NAME,
            mcp_tool,
            arguments,
            Duration::from_secs(MAGNIFIC_IMAGE_EDIT_TIMEOUT_SECS),
        )
        .await
        .map_err(|error| {
            with_orphan_charge_guidance(format!(
                "Magnific の{}を開始したか確認できませんでした: {}",
                edit_tool.label(),
                short_magnific_image_edit_detail(&error)
            ))
        })?;
        if output.is_error {
            return Err(format!(
                "Magnific の{}を開始できませんでした: {}",
                edit_tool.label(),
                short_magnific_image_edit_detail(&output.text)
            ));
        }

        let creation_ids = extract_creation_ids(output.structured.as_ref());
        if creation_ids.is_empty() {
            return Err(with_orphan_charge_guidance(format!(
                "Magnific の{}結果を追跡できませんでした",
                edit_tool.label()
            )));
        }

        let deadline = Instant::now() + Duration::from_secs(MAGNIFIC_IMAGE_EDIT_TIMEOUT_SECS);
        let mut pending = creation_ids;
        let mut completed_urls = Vec::new();
        while !pending.is_empty() {
            if Instant::now() >= deadline {
                return Err(with_orphan_charge_guidance(format!(
                    "Magnific の{}が5分以内に完了しませんでした",
                    edit_tool.label()
                )));
            }
            let wait = call_tool(
                &state,
                MAGNIFIC_MCP_NAME,
                "creations_wait",
                json!({ "identifiers": pending, "timeoutSeconds": 25 }),
            )
            .await
            .map_err(|error| {
                with_orphan_charge_guidance(format!(
                    "Magnific の{}完了を確認できませんでした: {}",
                    edit_tool.label(),
                    short_magnific_image_edit_detail(&error)
                ))
            })?;
            if wait.is_error {
                return Err(with_orphan_charge_guidance(format!(
                    "Magnific の{}完了を確認できませんでした: {}",
                    edit_tool.label(),
                    short_magnific_image_edit_detail(&wait.text)
                )));
            }

            let entries = parse_wait_results(wait.structured.as_ref());
            if entries.is_empty() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            for entry in entries {
                if !entry.terminal {
                    continue;
                }
                pending.retain(|identifier| identifier != &entry.identifier);
                if let Some(url) = entry.url {
                    completed_urls.push(url);
                } else {
                    return Err(with_orphan_charge_guidance(format!(
                        "Magnific の{}に失敗しました: {}",
                        edit_tool.label(),
                        short_magnific_image_edit_detail(
                            entry.error.as_deref().unwrap_or("結果URLがありません")
                        )
                    )));
                }
            }
        }

        if completed_urls.is_empty() {
            return Err(with_orphan_charge_guidance(format!(
                "Magnific の{}結果を取得できませんでした",
                edit_tool.label()
            )));
        }

        let mut saved_paths = Vec::new();
        for url in completed_urls {
            let response = http.get(&url).send().await.map_err(|_| {
                with_orphan_charge_guidance("Magnific の完成画像をダウンロードできませんでした")
            })?;
            if !response.status().is_success() {
                return Err(with_orphan_charge_guidance(format!(
                    "Magnific の完成画像を取得できませんでした (HTTP {})",
                    response.status()
                )));
            }
            let bytes = response.bytes().await.map_err(|_| {
                with_orphan_charge_guidance("Magnific の完成画像を読み取れませんでした")
            })?;
            if bytes.is_empty() {
                return Err(with_orphan_charge_guidance(
                    "Magnific の完成画像データが空でした",
                ));
            }
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let destination = directory.join(format!(
                "magnific-edit-{}-{timestamp}.png",
                edit_tool.slug()
            ));
            std::fs::write(&destination, &bytes).map_err(|_| {
                with_orphan_charge_guidance("Magnific の完成画像を保存できませんでした")
            })?;
            saved_paths.push(destination.to_string_lossy().into_owned());
        }

        Ok(saved_paths)
    }
    .await;

    result.map_err(|error| sanitize_magnific_image_edit_message(&error))
}

/// Magnific MCP 経由で画像を生成し、結果 URL を generated_images/magnific/ に
/// ダウンロードする。コア(batch_gen)は触らず、Magnific モデルが選ばれたときだけこの経路を通る。
///
/// LLM を介さない直接呼び出し: 参照画像を identifier 化 → images_generate を 1 コールで
/// count 枚投入 → creations_wait (long-poll) で全件の終端を待つ → 完了 URL を DL 保存。
#[tauri::command]
pub async fn magnific_generate_batch(
    state: State<'_, AppState>,
    args: MagnificGenArgs,
) -> Result<MagnificGenResult, String> {
    if args.model.trim().is_empty() {
        return Err(
            "Magnific のモデルが未選択です。モデルを選んでから生成してください。".to_string(),
        );
    }
    // images_generate は 1 コールで最大 8 枚。フロントは従来どおり最大 4 を渡す。
    let count = args.count.unwrap_or(1).clamp(1, 8);
    let aspect = args
        .aspect
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("1:1");
    // Magnific 生成は MCP 往復 + クラウド生成。従来と同じ全体 300 秒で締め切る。
    let deadline = Instant::now() + Duration::from_secs(300);

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("magnific");
    std::fs::create_dir_all(&dir).map_err(|e| format!("magnific dir 作成失敗: {e}"))?;
    let http = reqwest::Client::new();

    let mut generated_paths: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // ① 参照画像を identifier 化
    let ref_paths: Vec<&String> = args
        .ref_image_paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .collect();
    let mut references: Vec<Value> = Vec::new();
    for path in &ref_paths {
        match upload_magnific_reference(&state, &http, path).await {
            Ok(identifier) => references.push(json!({ "type": "image", "identifier": identifier })),
            Err(e) => {
                // 参照画像が使えないまま生成すると意図と違う絵になるため即返す。
                // 2026-08-06: ここが「参照つけると全滅」の出口。無音だと実機ログから
                // 追えないので必ず残す (エラー文言に秘密値は入らない設計)。
                tracing::warn!(target: "magnific", "参照画像の準備に失敗したため生成を中止しました: {e}");
                return Ok(MagnificGenResult {
                    generated_paths,
                    failed_count: count,
                    errors: vec![e],
                });
            }
        }
    }

    // ② 1 コールで count 枚投入 (応答 creations[].identifier)
    let mut gen_args = serde_json::Map::new();
    gen_args.insert("prompt".into(), json!(args.prompt));
    gen_args.insert("mode".into(), json!(args.model));
    gen_args.insert("aspectRatio".into(), json!(aspect));
    gen_args.insert("count".into(), json!(count));
    if !references.is_empty() {
        gen_args.insert("references".into(), Value::Array(references));
    }
    let out = call_tool_once_with_timeout(
        &state,
        MAGNIFIC_MCP_NAME,
        "images_generate",
        Value::Object(gen_args),
        Duration::from_secs(300),
    )
    .await?;
    if out.is_error {
        return Ok(MagnificGenResult {
            generated_paths,
            failed_count: count,
            errors: vec![format!(
                "Magnific 画像生成の投入に失敗しました: {}",
                out.text
            )],
        });
    }
    let creation_ids = extract_creation_ids(out.structured.as_ref());
    if creation_ids.is_empty() {
        return Ok(MagnificGenResult {
            generated_paths,
            failed_count: count,
            errors: vec![format!(
                "Magnific 画像生成の creation ID を取得できませんでした: {}",
                out.text
            )],
        });
    }

    // ③ creations_wait (long-poll, サーバ側最大 25 秒) で全件の終端を待つ
    let mut pending: Vec<String> = creation_ids.clone();
    let mut completed_urls: Vec<String> = Vec::new();
    while !pending.is_empty() {
        if Instant::now() >= deadline {
            errors.push(with_orphan_charge_guidance(format!(
                "Magnific 生成がタイムアウトしました ({} 件未完了)",
                pending.len()
            )));
            break;
        }
        let out = call_tool(
            &state,
            MAGNIFIC_MCP_NAME,
            "creations_wait",
            json!({ "identifiers": pending, "timeoutSeconds": 25 }),
        )
        .await
        .map_err(with_orphan_charge_guidance)?;
        if out.is_error {
            errors.push(with_orphan_charge_guidance(format!(
                "Magnific 生成の完了待ちに失敗しました: {}",
                out.text
            )));
            break;
        }
        let entries = parse_wait_results(out.structured.as_ref());
        if entries.is_empty() {
            // 応答が読めない場合は少し待って再試行 (deadline で打ち切られる)。
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        for entry in entries {
            if !entry.terminal {
                continue;
            }
            pending.retain(|id| id != &entry.identifier);
            match (entry.url, entry.error) {
                (Some(url), _) => completed_urls.push(url),
                (None, Some(e)) => errors.push(e),
                (None, None) => errors.push(with_orphan_charge_guidance(
                    "生成は完了しましたが、結果URLを取得できませんでした",
                )),
            }
        }
    }

    // ④ 完了 URL を DL 保存
    for (i, url) in completed_urls.iter().enumerate() {
        match http.get(url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) if !bytes.is_empty() => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let dest = dir.join(format!("magnific-{ts}-{i}.png"));
                    if let Err(e) = std::fs::write(&dest, &bytes) {
                        errors.push(with_orphan_charge_guidance(format!("画像保存失敗: {e}")));
                    } else {
                        generated_paths.push(dest.to_string_lossy().into_owned());
                    }
                }
                _ => errors.push(with_orphan_charge_guidance("Magnific 画像データが空でした")),
            },
            Ok(res) => errors.push(with_orphan_charge_guidance(format!(
                "Magnific 画像取得に失敗 (HTTP {})",
                res.status()
            ))),
            Err(e) => errors.push(with_orphan_charge_guidance(format!(
                "Magnific 画像取得に失敗: {e}"
            ))),
        }
    }

    let failed_count = count.saturating_sub(generated_paths.len() as u32);
    Ok(MagnificGenResult {
        generated_paths,
        failed_count,
        errors,
    })
}

fn replace_local_image_paths(
    value: &mut Value,
    replacements: &std::collections::HashMap<String, String>,
) {
    match value {
        Value::String(text) => {
            if let Some(identifier) = replacements.get(text) {
                *text = identifier.clone();
            }
        }
        Value::Array(values) => {
            for value in values {
                replace_local_image_paths(value, replacements);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                replace_local_image_paths(value, replacements);
            }
        }
        _ => {}
    }
}

fn collect_video_creation_ids(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_video_creation_ids(value, into);
            }
        }
        Value::Object(object) => {
            for key in ["identifier", "creationId", "creation_id"] {
                if let Some(identifier) = object.get(key).and_then(Value::as_str) {
                    if !identifier.trim().is_empty() && !into.iter().any(|item| item == identifier)
                    {
                        into.push(identifier.to_string());
                    }
                }
            }
            for key in ["creations", "data", "results", "items"] {
                if let Some(nested) = object.get(key) {
                    collect_video_creation_ids(nested, into);
                }
            }
        }
        _ => {}
    }
}

fn looks_like_https_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn collect_video_urls(value: &Value, into: &mut Vec<String>, url_context: bool) {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            let has_video_extension = [".mp4", ".mov", ".webm", ".m4v"]
                .iter()
                .any(|extension| trimmed.to_ascii_lowercase().contains(extension));
            if (url_context || has_video_extension) && looks_like_https_url(trimmed) {
                if !into.iter().any(|item| item == trimmed) {
                    into.push(trimmed.to_string());
                }
            }
            if matches!(trimmed.as_bytes().first(), Some(b'{') | Some(b'[')) {
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    collect_video_urls(&parsed, into, false);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_video_urls(value, into, url_context);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                let child_context = url_context
                    || normalized.contains("url")
                    || normalized.contains("video")
                    || matches!(
                        normalized.as_str(),
                        "output" | "generated" | "result" | "results"
                    );
                collect_video_urls(value, into, child_context);
            }
        }
        _ => {}
    }
}

fn video_extension(content_type: Option<&str>, final_url: &str) -> Option<&'static str> {
    let mime = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "video/mp4" => return Some("mp4"),
        "video/quicktime" => return Some("mov"),
        "video/webm" => return Some("webm"),
        "video/x-m4v" | "video/m4v" => return Some("m4v"),
        _ => {}
    }
    let path = reqwest::Url::parse(final_url)
        .ok()?
        .path()
        .to_ascii_lowercase();
    ["mp4", "mov", "webm", "m4v"]
        .into_iter()
        .find(|extension| path.ends_with(&format!(".{extension}")))
}

fn requested_video_count(value: &Value) -> u32 {
    match value {
        Value::Object(object) => {
            for key in ["count", "n", "numVideos", "numberOfVideos"] {
                if let Some(value) = object.get(key).and_then(Value::as_u64) {
                    return value.clamp(1, 8) as u32;
                }
            }
            for nested in object.values() {
                let count = requested_video_count(nested);
                if count > 1 {
                    return count;
                }
            }
            1
        }
        _ => 1,
    }
}

async fn save_magnific_video_urls(urls: &[String]) -> Result<(Vec<String>, Vec<String>), String> {
    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗しました".to_string())?;
    // F8 の既存動画 (Higgsfield / リモートMCP動画) と同じ合流先。
    let directory = base.join("higgsfield");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("動画保存先を作成できませんでした: {error}"))?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(MAGNIFIC_VIDEO_DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("動画ダウンロードの準備に失敗しました: {error}"))?;
    let mut generated_paths = Vec::new();
    let mut errors = Vec::new();

    for (index, url) in urls.iter().enumerate() {
        if !looks_like_https_url(url) {
            errors.push(format!("動画 {} のURLがHTTPSではありません", index + 1));
            continue;
        }
        let result = async {
            let response = http
                .get(url)
                .send()
                .await
                .map_err(|_| "動画のダウンロード通信に失敗しました".to_string())?;
            if !response.status().is_success() {
                return Err(format!(
                    "動画の取得に失敗しました (HTTP {})",
                    response.status()
                ));
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAGNIFIC_VIDEO_DOWNLOAD_MAX_BYTES as u64)
            {
                return Err("動画が保存上限の512MBを超えています".to_string());
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let final_url = response.url().to_string();
            let extension = video_extension(content_type.as_deref(), &final_url)
                .ok_or_else(|| "動画形式を確認できませんでした".to_string())?;
            let bytes = response
                .bytes()
                .await
                .map_err(|_| "動画データを読み取れませんでした".to_string())?;
            if bytes.is_empty() {
                return Err("動画データが空でした".to_string());
            }
            if bytes.len() > MAGNIFIC_VIDEO_DOWNLOAD_MAX_BYTES {
                return Err("動画が保存上限の512MBを超えています".to_string());
            }
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let destination = directory.join(format!(
                "magnific-video-{timestamp}-{}.{extension}",
                index + 1
            ));
            std::fs::write(&destination, &bytes)
                .map_err(|error| format!("動画を保存できませんでした: {error}"))?;
            Ok(destination.to_string_lossy().into_owned())
        }
        .await;
        match result {
            Ok(path) => generated_paths.push(path),
            Err(error) => errors.push(format!("動画 {}: {error}", index + 1)),
        }
    }
    Ok((generated_paths, errors))
}

/// 選択した Magnific 動画モデルで生成し、F8 の既存動画保存先へ合流する。
#[tauri::command]
pub async fn magnific_video_generate(
    state: State<'_, AppState>,
    args: MagnificVideoGenArgs,
) -> Result<MagnificGenResult, String> {
    let result = async {
        let mut arguments: Value = serde_json::from_str(&args.params_json)
            .map_err(|error| format!("paramsJson が正しいJSONではありません: {error}"))?;
        if !arguments.is_object() {
            return Err("paramsJson はJSONオブジェクトで指定してください".to_string());
        }
        let count = requested_video_count(&arguments);
        let http = reqwest::Client::new();
        let mut replacements = std::collections::HashMap::new();
        for path in args
            .local_image_paths
            .iter()
            .filter(|path| !path.trim().is_empty())
        {
            if replacements.contains_key(path) {
                continue;
            }
            let identifier = upload_magnific_reference(&state, &http, path).await?;
            replacements.insert(path.clone(), identifier);
        }
        replace_local_image_paths(&mut arguments, &replacements);

        let output = call_tool_with_timeout(
            &state,
            MAGNIFIC_MCP_NAME,
            "video_generate",
            arguments,
            Duration::from_secs(MAGNIFIC_VIDEO_GENERATION_TIMEOUT_SECS),
        )
        .await?;
        if output.is_error {
            return Err(if output.text.trim().is_empty() {
                "Magnific 動画生成がエラーで終了しました".to_string()
            } else {
                output.text
            });
        }

        let mut urls = Vec::new();
        if let Some(structured) = output.structured.as_ref() {
            collect_video_urls(structured, &mut urls, false);
        }
        for content in &output.content {
            collect_video_urls(content, &mut urls, false);
        }
        collect_video_urls(&Value::String(output.text.clone()), &mut urls, false);

        let mut creation_ids = Vec::new();
        if let Some(structured) = output.structured.as_ref() {
            collect_video_creation_ids(structured, &mut creation_ids);
        }
        if !creation_ids.is_empty() && urls.len() < count as usize {
            let deadline =
                Instant::now() + Duration::from_secs(MAGNIFIC_VIDEO_GENERATION_TIMEOUT_SECS);
            let mut pending = creation_ids;
            while !pending.is_empty() && Instant::now() < deadline {
                let wait = call_tool(
                    &state,
                    MAGNIFIC_MCP_NAME,
                    "creations_wait",
                    json!({ "identifiers": pending, "timeoutSeconds": 25 }),
                )
                .await?;
                if wait.is_error {
                    return Err(if wait.text.trim().is_empty() {
                        "Magnific 動画生成の完了待ちに失敗しました".to_string()
                    } else {
                        wait.text
                    });
                }
                let entries = parse_wait_results(wait.structured.as_ref());
                if entries.is_empty() {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
                for entry in entries {
                    if !entry.terminal {
                        continue;
                    }
                    pending.retain(|identifier| identifier != &entry.identifier);
                    if let Some(url) = entry.url {
                        if !urls.contains(&url) {
                            urls.push(url);
                        }
                    } else if let Some(error) = entry.error {
                        return Err(error);
                    }
                }
            }
            if !pending.is_empty() {
                return Err(format!(
                    "Magnific 動画生成が15分以内に完了しませんでした ({}件処理中)",
                    pending.len()
                ));
            }
        }
        if urls.is_empty() {
            return Err("Magnific 動画生成の結果URLを取得できませんでした".to_string());
        }

        let (generated_paths, errors) = save_magnific_video_urls(&urls).await?;
        if generated_paths.is_empty() {
            return Err(if errors.is_empty() {
                "Magnific の動画を保存できませんでした".to_string()
            } else {
                errors.join("\n")
            });
        }
        let failed_count = count.saturating_sub(generated_paths.len() as u32);
        Ok(MagnificGenResult {
            generated_paths,
            failed_count,
            errors: errors
                .into_iter()
                .map(|error| sanitize_magnific_video_message(&error))
                .collect(),
        })
    }
    .await;

    result.map_err(|error| sanitize_magnific_video_message(&error))
}

/// Magnific のアカウント残高。フロントの接続カードでクレジット表示に使う。
/// (v1.1.0 計画の「models.ts に静的クレジット値」は不要になった —
///  account_balance が実残高を返すため動的表示に切り替え)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnificAccount {
    /// 利用可能クレジット数。
    pub credits: f64,
    /// プラン名 (例: "Business")。取得できなければ None。
    pub plan: Option<String>,
    /// 無制限モードか (business プラン等)。
    pub unlimited: bool,
}

/// JSON 値からクレジット数を取り出す (higgsfield_mcp.rs の `json_to_number` と同方針)。
///
/// MCP 側のレスポンス構造が変わっても静かに 0 にならないよう、数値直・文字列数値・
/// オブジェクトの代表キーを順に試す。見つからなければ `None` を返し、呼び出し側で
/// エラーにする (`unwrap_or(0.0)` による無言 degrade を禁止する)。
fn magnific_json_to_number(value: &Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    if let Some(s) = value.as_str() {
        if let Ok(n) = s.trim().parse::<f64>() {
            return Some(n);
        }
    }
    if let Some(obj) = value.as_object() {
        for key in [
            "available",
            "remaining",
            "balance",
            "credits_available",
            "creditsAvailable",
            "credits_remaining",
            "creditsRemaining",
            "credits",
            "amount",
            "value",
            "total",
        ] {
            if let Some(found) = obj.get(key).and_then(magnific_json_to_number) {
                return Some(found);
            }
        }
    }
    None
}

/// テキスト全体から最初の数値トークンを拾うフォールバック
/// (structuredContent が無い版で text "Credits: 445.77 ..." だけ返る場合に備える)。
fn magnific_extract_first_number(text: &str) -> Option<f64> {
    let mut buf = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() || c == '.' || (buf.is_empty() && c == '-') {
            buf.push(c);
        } else if !buf.is_empty() {
            if let Ok(n) = buf.parse::<f64>() {
                return Some(n);
            }
            buf.clear();
        }
    }
    if !buf.is_empty() {
        if let Ok(n) = buf.parse::<f64>() {
            return Some(n);
        }
    }
    None
}

/// `account_balance` の structuredContent からクレジット数を解釈する。
///
/// 想定する形 (どれでも読める):
/// - `{credits: {available: 100}}` (PoC 2026-06-10 実測の形)
/// - `{credits: {remaining: 100}}` / `{credits: {balance: 100}}` 等のキー名変更
/// - `{credits: 100}` (数値直置き)
/// - `{credits: "100"}` (文字列数値)
/// - `{available: 100}` / `{balance: 100}` (トップレベル直)
///
/// どれにも当てはまらなければ `None`。呼び出し側は 0 で埋めずエラーにする。
fn parse_magnific_credits(structured: &Value) -> Option<f64> {
    // credits サブオブジェクト/数値を最優先で見る (トップレベルの無関係な数値を
    // 誤って残高と解釈しないため)。
    if let Some(found) = structured.get("credits").and_then(magnific_json_to_number) {
        return Some(found);
    }
    // credits キー自体が無い形 (トップレベルに available / balance 等) に対応。
    magnific_json_to_number(structured)
}

/// 解釈に失敗したときの調査用に、受信 JSON の**キー名だけ**を列挙する (値は含めない)。
/// 残高や個人情報をログ・UI に出さないための制約。
fn magnific_describe_shape(structured: &Value) -> String {
    match structured {
        Value::Object(map) => {
            let mut parts: Vec<String> = map
                .iter()
                .map(|(k, v)| match v {
                    Value::Object(inner) => {
                        let mut inner_keys: Vec<&str> = inner.keys().map(|s| s.as_str()).collect();
                        inner_keys.sort_unstable();
                        format!("{k}{{{}}}", inner_keys.join(","))
                    }
                    Value::Array(_) => format!("{k}[]"),
                    Value::Null => format!("{k}:null"),
                    Value::Bool(_) => format!("{k}:bool"),
                    Value::Number(_) => format!("{k}:number"),
                    Value::String(_) => format!("{k}:string"),
                })
                .collect();
            parts.sort();
            parts.join(", ")
        }
        Value::Array(_) => "(トップレベルが配列)".to_string(),
        Value::Null => "(null)".to_string(),
        other => format!(
            "(トップレベルが {} 型)",
            match other {
                Value::Bool(_) => "bool",
                Value::Number(_) => "number",
                Value::String(_) => "string",
                _ => "unknown",
            }
        ),
    }
}

/// Magnific MCP の `account_balance` で残高 + プランを取得する (実測 1 秒前後)。
///
/// 2026-07-28: 固定パス `credits.available` + `unwrap_or(0.0)` を廃止した。
/// MCP 側のレスポンス構造が変わると**無言で 0 クレジット表示**になり、「本当に残高が
/// 無い」と区別できなかったため。多キー・多形状のフォールバックで読み、どれでも
/// 解釈できなければ 0 を返さずエラーにして UI に理由を出す。
#[tauri::command]
pub async fn magnific_account(state: State<'_, AppState>) -> Result<MagnificAccount, String> {
    let out = call_tool(&state, MAGNIFIC_MCP_NAME, "account_balance", json!({})).await?;
    if out.is_error {
        return Err(format!("Magnific 残高の取得に失敗しました: {}", out.text));
    }
    let Some(structured) = out.structured.as_ref() else {
        // structuredContent が無いバージョン差に備え、text の数値だけでも拾う。
        let credits = magnific_extract_first_number(&out.text).ok_or_else(|| {
            "Magnific 残高の形式を解釈できませんでした (structuredContent なし)".to_string()
        })?;
        return Ok(MagnificAccount {
            credits,
            plan: None,
            unlimited: false,
        });
    };

    let credits = match parse_magnific_credits(structured) {
        Some(n) => n,
        // 最後の砦: text 側 ("Credits: 123 ...") からの数値抽出。
        None => magnific_extract_first_number(&out.text).ok_or_else(|| {
            format!(
                "Magnific 残高の形式を解釈できませんでした。受信したキー構成: {}",
                magnific_describe_shape(structured)
            )
        })?,
    };

    let plan = structured
        .get("plan")
        .and_then(|p| {
            p.get("productName")
                .or_else(|| p.get("tier"))
                .or_else(|| p.get("name"))
                .or_else(|| p.get("planName"))
                // plan が文字列直置きの形にも対応。
                .or(Some(p))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let unlimited = structured
        .get("plan")
        .and_then(|p| {
            p.get("isUnlimitedMode")
                .or_else(|| p.get("unlimited"))
                .or_else(|| p.get("is_unlimited_mode"))
        })
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(MagnificAccount {
        credits,
        plan,
        unlimited,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_creation_ids_reads_creations() {
        let s = json!({"creations": [
            {"identifier": "abc", "status": "queued"},
            {"identifier": "def", "status": "queued"},
            {"status": "queued"}
        ]});
        assert_eq!(extract_creation_ids(Some(&s)), vec!["abc", "def"]);
        assert!(extract_creation_ids(None).is_empty());
    }

    #[test]
    fn parse_wait_results_classifies_status() {
        let s = json!({"results": [
            {"identifier": "a", "status": "completed", "results": {"url": "https://x/r.png"}},
            {"identifier": "b", "status": "failed", "error": "quota exceeded"},
            {"identifier": "c", "status": "queued"}
        ], "allTerminal": false});
        let entries = parse_wait_results(Some(&s));
        assert_eq!(entries.len(), 3);
        assert!(entries[0].terminal);
        assert_eq!(entries[0].url.as_deref(), Some("https://x/r.png"));
        assert!(entries[1].terminal);
        assert_eq!(entries[1].error.as_deref(), Some("quota exceeded"));
        assert!(!entries[2].terminal);
    }

    #[test]
    fn extract_creation_ids_reads_singular_creation() {
        // 編集系ツールの実測応答形 (2026-08-26)。
        let s = json!({"creation": {"identifier": "xyz", "status": "processing", "tool": "relight"}});
        assert_eq!(extract_creation_ids(Some(&s)), vec!["xyz".to_string()]);
    }

    #[test]
    fn short_detail_replaces_transport_dump_with_japanese() {
        let raw = "rpc error -32603: tool call failed for `magnific/images_expand`: Transport send error: Transport [rmcp::transport::worker::WorkerTransport]";
        let out = short_magnific_image_edit_detail(raw);
        assert!(out.contains("通信が途切れました"), "got: {out}");
        assert!(!out.contains("rpc"));
    }

    #[test]
    fn parse_wait_results_reads_failure_reason_and_translates_nsfw() {
        // 実 API 応答の実測形 (2026-08-26): failureReason フィールドで返る。
        let s = json!({"results": [
            {"identifier": "a", "status": "failed", "failureReason": "NSFW: Content detected"},
            {"identifier": "b", "status": "failed", "failureReason": "internal error"}
        ], "allTerminal": true});
        let entries = parse_wait_results(Some(&s));
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].error.as_deref(),
            Some("画像の内容が Magnific の生成ポリシーに触れたため処理できませんでした")
        );
        assert_eq!(entries[1].error.as_deref(), Some("internal error"));
    }

    #[test]
    fn image_edit_expand_keeps_only_allowed_arguments() {
        let (tool, arguments) = build_magnific_image_edit_call(
            MagnificImageEditTool::Expand,
            "creation-1",
            &json!({
                "aspectRatio": "21:9",
                "prompt": "  森をつなげる  ",
                "unexpected": "must-not-leak"
            }),
        );
        assert_eq!(tool, "images_expand");
        assert_eq!(
            arguments,
            json!({
                "creationIdentifier": "creation-1",
                "aspectRatio": "21:9",
                "prompt": "森をつなげる"
            })
        );
    }

    #[test]
    fn image_edit_camera_clamps_numeric_arguments() {
        let (tool, arguments) = build_magnific_image_edit_call(
            MagnificImageEditTool::Camera,
            "creation-2",
            &json!({ "rotate": 999, "vertical": -999, "closeup": 4.6, "scale": "4x" }),
        );
        assert_eq!(tool, "images_change_camera");
        assert_eq!(
            arguments,
            json!({
                "creationIdentifier": "creation-2",
                "rotate": 360,
                "vertical": -30,
                "closeup": 5
            })
        );
    }

    #[test]
    fn image_edit_relight_snaps_direction_and_fixes_output_shape() {
        let (tool, arguments) = build_magnific_image_edit_call(
            MagnificImageEditTool::Relight,
            "creation-3",
            &json!({ "azimuth": -999, "elevation": 44, "intensity": 99, "numImages": 8 }),
        );
        assert_eq!(tool, "images_relight");
        assert_eq!(
            arguments,
            json!({
                "creationIdentifier": "creation-3",
                "lights": [{
                    "azimuth": -135,
                    "elevation": 45,
                    "intensity": 10,
                    "type": "neutral"
                }],
                "numImages": 1,
                "resolution": "2k"
            })
        );
    }

    #[test]
    fn image_edit_upscale_defaults_invalid_scale_and_tool_is_allowlisted() {
        let (tool, arguments) = build_magnific_image_edit_call(
            MagnificImageEditTool::Upscale,
            "creation-4",
            &json!({ "scale": "8x", "mode": "unsafe" }),
        );
        assert_eq!(tool, "images_upscale");
        assert_eq!(
            arguments,
            json!({
                "creationIdentifier": "creation-4",
                "mode": "creative",
                "scale": "2x"
            })
        );
        assert!(MagnificImageEditTool::parse("unknown").is_err());
    }

    /// 2026-08-06 の実害 (参照つき生成が全滅) を固定するテスト。
    /// 現行 MCP の実応答キー `proxyUploadUrl` を読めることが本丸。
    #[test]
    fn extract_upload_url_reads_current_proxy_key() {
        // 2026-08-06 に実 MCP から受け取った応答の形 (値はダミー化)。
        let s = json!({
            "proxyUploadUrl": "https://ak-data.magnific.com/app/api/mcp/uploads/proxy/x.png?sig=y",
            "path": "temp-files/x.png",
            "mimeType": "image/png",
            "expiresAt": "2026-08-05T16:22:25+00:00",
            "instructions": "..."
        });
        assert_eq!(
            extract_upload_url(&s).as_deref(),
            Some("https://ak-data.magnific.com/app/api/mcp/uploads/proxy/x.png?sig=y")
        );
    }

    #[test]
    fn extract_upload_url_keeps_legacy_and_generic_keys() {
        // 旧 PoC の形 (後方互換。復活・併存しても壊れない)。
        assert_eq!(
            extract_upload_url(&json!({"directUploadUrl": "https://a/b", "path": "p"})).as_deref(),
            Some("https://a/b")
        );
        // 一般名。
        assert_eq!(
            extract_upload_url(&json!({"uploadUrl": "https://c/d"})).as_deref(),
            Some("https://c/d")
        );
        // 現行キーは旧キーより優先される (両方来ても現行を使う)。
        assert_eq!(
            extract_upload_url(&json!({
                "directUploadUrl": "https://old/x",
                "proxyUploadUrl": "https://new/x"
            }))
            .as_deref(),
            Some("https://new/x")
        );
        // 未知のキー名でも http 値なら拾う (次にキー名が変わっても止まらない)。
        assert_eq!(
            extract_upload_url(&json!({"somethingBrandNew": "https://e/f", "path": "p"}))
                .as_deref(),
            Some("https://e/f")
        );
    }

    #[test]
    fn extract_upload_url_returns_none_without_url() {
        // URL がどこにも無ければ None (呼び出し側がキー構成付きで Err にする)。
        assert_eq!(
            extract_upload_url(&json!({"path": "temp-files/x.png"})),
            None
        );
        assert_eq!(extract_upload_url(&json!({})), None);
        // path が URL っぽくない文字列でも誤って拾わない。
        assert_eq!(
            extract_upload_url(&json!({"path": "temp-files/https-not-a-url.png"})),
            None
        );
    }

    #[test]
    fn magnific_mime_rejects_unsupported() {
        assert_eq!(magnific_mime_for_path("/a/b.PNG"), Some("image/png"));
        assert_eq!(magnific_mime_for_path("/a/b.jpeg"), Some("image/jpeg"));
        assert_eq!(magnific_mime_for_path("/a/b.webp"), Some("image/webp"));
        assert_eq!(magnific_mime_for_path("/a/b.gif"), None);
    }

    #[test]
    fn orphan_charge_guidance_tells_user_to_check_service_history() {
        let message = with_orphan_charge_guidance("Magnific 生成の完了待ちに失敗しました");
        assert!(message.contains("クレジット消費済みの場合あり"));
        assert!(message.contains("各サービスの履歴をご確認ください"));
    }

    #[test]
    fn parse_credits_reads_multiple_shapes() {
        // PoC 2026-06-10 実測の形 (現行)。
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"available": 445.77}})),
            Some(445.77)
        );
        // キー名変更 (available → remaining / balance)。
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"remaining": 100}})),
            Some(100.0)
        );
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"balance": 12.5}})),
            Some(12.5)
        );
        // credits に数値直置き。
        assert_eq!(parse_magnific_credits(&json!({"credits": 88})), Some(88.0));
        // 文字列数値。
        assert_eq!(
            parse_magnific_credits(&json!({"credits": "77.5"})),
            Some(77.5)
        );
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"available": "64"}})),
            Some(64.0)
        );
        // トップレベル直 (credits キーが無い形)。
        assert_eq!(parse_magnific_credits(&json!({"available": 5})), Some(5.0));
        assert_eq!(parse_magnific_credits(&json!({"balance": 9})), Some(9.0));
        assert_eq!(
            parse_magnific_credits(&json!({"creditsRemaining": 3})),
            Some(3.0)
        );
        // 0 は「取れなかった」ではなく「本当に 0」として通す。
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"available": 0}})),
            Some(0.0)
        );
    }

    #[test]
    fn parse_credits_returns_none_for_unknown_shape() {
        // 数値がどこにも無い形は None (呼び出し側が Err にする。0 で埋めない)。
        assert_eq!(
            parse_magnific_credits(&json!({"plan": {"tier": "business"}})),
            None
        );
        assert_eq!(parse_magnific_credits(&json!({})), None);
        assert_eq!(
            parse_magnific_credits(&json!({"credits": {"unit": "usd"}})),
            None
        );
        assert_eq!(parse_magnific_credits(&json!("no numbers here")), None);
    }

    #[test]
    fn describe_shape_lists_keys_without_values() {
        let shape = magnific_describe_shape(&json!({
            "credits": {"unit": "usd", "note": "x"},
            "plan": {"tier": "business"},
            "token": "secret-value-must-not-leak"
        }));
        // キー名と型だけが出る。値そのものは含まれない。
        assert!(shape.contains("credits{note,unit}"), "got: {shape}");
        assert!(shape.contains("plan{tier}"), "got: {shape}");
        assert!(shape.contains("token:string"), "got: {shape}");
        assert!(
            !shape.contains("secret-value-must-not-leak"),
            "got: {shape}"
        );
        assert!(!shape.contains("business"), "got: {shape}");
    }

    #[test]
    fn extract_first_number_reads_text_fallback() {
        assert_eq!(
            magnific_extract_first_number("Credits: 445.77 | Plan: creator"),
            Some(445.77)
        );
        assert_eq!(magnific_extract_first_number("no digits"), None);
    }
}
