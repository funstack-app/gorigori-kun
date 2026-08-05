//! Higgsfield リモート HTTP MCP 拡張 (2026-06-10 直接呼び出し版)。
//!
//! ## アーキテクチャ (v1.1.0 からの作り直し・LLM 仲介の全廃)
//!
//! v1.1.0 までは「`codex exec` で gpt-5.5 に『MCP ツールを呼んで結果だけ返して』と
//! お願いする」LLM 仲介方式だった。配布後の実ユーザー障害で以下が判明:
//! - モデル一覧の取得に 30〜180 秒 (LLM 1 ターン分の往復が毎回乗る)
//! - LLM がツールを呼ばず指示文の例文をそのまま返す事故が確率的に発生
//!   (「JSON を取得できませんでした (stderr: 例: [...])」)
//! - 生成も同様に確率的に失敗する (「4件すべて失敗」)
//!
//! 現在は codex app-server の `mcpServer/tool/call` (crate::codex::mcp_direct) で
//! **LLM を介さず決定論的に** ツールを呼ぶ。実測: models_explore 1.1 秒 / balance
//! 0.8 秒 / 生成投入 10 秒 → job_status(sync) で完了 URL 取得。
//!
//! ## 実機で確定済みの事実 (PoC 2026-06-10、推測ゼロ)
//! - `generate_image` / `generate_video` の arguments は `{"params": {...}}` ラッパー。
//!   モデル固有パラメータ (resolution / mode / genre / sound / duration) も params 直下。
//! - 投入は非同期: 応答 structuredContent.results[].id が job id (status: "pending")。
//! - `job_status` は **トップレベル直** `{jobId, sync: true}`。sync はサーバ側で最大
//!   約 25 秒ポーリングして終端状態で返す。完了時 structuredContent.generation
//!   .results.rawUrl に成果物 URL。
//! - 参照画像: `media_upload` {filename, content_type} → structuredContent.uploads[0]
//!   .{upload_url, media_id} → その URL へ HTTP PUT (Content-Type 必須) →
//!   `media_confirm` {type, media_id} → 生成ツールの medias: [{value: media_id, role}]。
//!   medias.value は media_id / 過去 job_id / https:// URL のいずれも可。
//! - `models_explore` {action:"list", type, limit} → structuredContent.items[]
//!   .{id, name, output_type, medias[].roles, aspect_ratios, parameters}。
//! - `balance` {} → structuredContent.{credits, subscription_plan_type}。
//! - get_cost: true で実生成なしのコスト見積もり → structuredContent.cost
//!   .{credits, credits_exact}。
//!
//! 接続 (mcp add + OAuth login) はブラウザを開く必要があるため引き続き codex CLI で行い、
//! 成功後に `config/mcpServer/reload` で常駐 app-server に設定を再読込させる
//! (再起動なしで直接呼び出しが有効になる)。

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::codex::mcp_direct::{call_tool, reload_mcp_servers};
use crate::codex::mcp_shared::{
    entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_auth_capture,
    run_codex_capture,
};
use crate::state::AppState;

const HIGGSFIELD_MCP_NAME: &str = "higgsfield";
const HIGGSFIELD_MCP_URL: &str = "https://mcp.higgsfield.ai/mcp";

/// JSON 値から数値 (クレジット数・コスト) を取り出す。トップレベルが数値ならそれを、
/// オブジェクトなら credits / cost / value / amount 等の代表キーを順に探す。
fn json_to_number(value: &Value) -> Option<f64> {
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
            "credits_exact",
            "credits",
            "cost",
            "credit_cost",
            "amount",
            "value",
            "total",
        ] {
            if let Some(found) = obj.get(key).and_then(json_to_number) {
                return Some(found);
            }
        }
    }
    None
}

/// テキスト全体から最初の数値トークンを拾うフォールバック (balance の text
/// "Credits: 445.77 | Plan: creator" 等)。小数・整数の両方に対応。
fn extract_first_number(text: &str) -> Option<f64> {
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

/// Higgsfield MCP 拡張の接続状態。未接続なら全 false で UI が degrade する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpStatus {
    /// config.toml に higgsfield MCP が登録されているか。
    pub registered: bool,
    /// OAuth 認証済みか (codex mcp list の auth_status が OAuth 系)。
    pub authenticated: bool,
}

/// 全 false の未接続状態 (degrade 用)。codex 不在・実行失敗・JSON 解析失敗の
/// いずれでも起動を止めず、Higgsfield を「持っていない」扱いにする。
fn higgsfield_mcp_status_unavailable() -> HiggsfieldMcpStatus {
    HiggsfieldMcpStatus {
        registered: false,
        authenticated: false,
    }
}

/// Higgsfield MCP 拡張の接続状態を返す。失敗しても起動を止めず、未接続として degrade する。
///
/// `codex mcp list --json` はローカル config を読むだけなので app-server に依存せず、
/// アプリ起動直後 (app-server 未起動) でも接続タブが状態を出せる。
#[tauri::command]
pub async fn higgsfield_mcp_status() -> Result<HiggsfieldMcpStatus, String> {
    let mut cmd = match gori_codex_command() {
        Ok(c) => c,
        // codex が無い環境では「未接続」として扱う (コアは別経路なので影響しない)。
        Err(_) => return Ok(higgsfield_mcp_status_unavailable()),
    };
    cmd.args(["mcp", "list", "--json"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return Ok(higgsfield_mcp_status_unavailable()),
    };
    // `mcp list` はローカル config を読むだけなので速いが、念のため上限を設ける。
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(30), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            // 実行失敗・タイムアウトとも未接続として degrade。
            _ => return Ok(higgsfield_mcp_status_unavailable()),
        };

    let Some(entry) = find_mcp_entry(&output.stdout, HIGGSFIELD_MCP_NAME) else {
        return Ok(higgsfield_mcp_status_unavailable());
    };
    Ok(HiggsfieldMcpStatus {
        registered: true,
        authenticated: entry_is_authenticated(&entry),
    })
}

/// `codex mcp login` の OAuth がブラウザ完了までブロックしうる上限。
/// ユーザーがブラウザでログインを終えるまで子プロセスが生きるので、待ち時間を長めに取る。
const HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS: u64 = 180;

/// Higgsfield MCP を登録し OAuth 認証を起動する。
///
/// 実機確認 (2026-06-10): `codex mcp add higgsfield --url ...` だけで OAuth が自動完了する。
/// ただし Magnific の add→login 2 段階と同じ構造で実装し、add 後に login も **冪等に**
/// 試みる。最後に status を再確認して結果を返す。
///
/// 成功時は稼働中 app-server に config/mcpServer/reload を発行し、**アプリ再起動なしで**
/// 直接呼び出し (モデル一覧・生成) が効くようにする。
#[tauri::command]
pub async fn higgsfield_mcp_login(state: State<'_, AppState>) -> Result<String, String> {
    // ① 登録 (mcp add)。実機ではこの段階で OAuth が自動完了する。既に登録済みだと
    //    codex が非ゼロ終了することがあるが、それはエラーにせず login に進む (冪等性)。
    //    認可 2 操作 (add / login) だけ codex-auth (0.147.0-alpha.4) で実行する。
    //    Higgsfield は add 段階で OAuth が自動起動するため add も対象。Magnific と
    //    同じ rmcp コールバック処理を通るので、iss 広告が入った時点で同じバグを踏む。
    let add = run_codex_auth_capture(
        &[
            "mcp",
            "add",
            HIGGSFIELD_MCP_NAME,
            "--url",
            HIGGSFIELD_MCP_URL,
        ],
        std::time::Duration::from_secs(HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS),
    )
    .await?;
    if !add.0 {
        // 「already exists」系は無視して login に進む。それ以外の本当の失敗で login が
        // また失敗すれば、下で status 確認時にエラーが返るので二重に止めない。
        let lower = format!("{} {}", add.1, add.2).to_lowercase();
        let already_registered =
            lower.contains("already") || lower.contains("exist") || lower.contains("既に");
        if !already_registered {
            tracing::warn!(target: "higgsfield_mcp", "mcp add 非ゼロ終了 (login で再試行): {}", add.2);
        }
    }

    // ② OAuth 認証 (mcp login)。add で既に完了している場合も冪等に試みる。
    //    login が失敗しても add で認証済みなら status 確認で救えるので、ここでは止めない。
    let login = run_codex_auth_capture(
        &["mcp", "login", HIGGSFIELD_MCP_NAME],
        std::time::Duration::from_secs(HIGGSFIELD_MCP_LOGIN_TIMEOUT_SECS),
    )
    .await;
    if let Err(e) = &login {
        tracing::warn!(target: "higgsfield_mcp", "mcp login 失敗 (add で認証済みの可能性・status で再確認): {e}");
    }

    // ③ 認証済みかを status で最終確認する。add だけで完了するケース・login で完了する
    //    ケースの両方を、実際の auth_status で判定する (推測しない)。
    let status = higgsfield_mcp_status().await?;
    // 配布版で codex-auth (0.147.0-alpha.4) が bundle から欠落し、フォールバックで
    // 0.146.0 が使われた場合の唯一の症状。ユーザーには「アプリを更新する」を示す。
    let issuer_error = login
        .as_ref()
        .map(|(_, _, stderr)| stderr.contains("missing required issuer"))
        .unwrap_or(false);
    if status.authenticated {
        // ④ 常駐 app-server に MCP 設定を再読込させる (再起動なしで生成可能に)。
        reload_mcp_servers(&state).await;
        Ok("Higgsfield の認証が完了しました。".to_string())
    } else if issuer_error {
        Err("HiggsField の認証に失敗しました。アプリ内の接続コンポーネントが見つからないか古い可能性があります。アプリを最新版に更新してから、もう一度お試しください。".to_string())
    } else if status.registered {
        Err("Higgsfield を登録しましたが、認証が完了していません。ブラウザでのログインを完了してから、もう一度「接続」を押してください。".to_string())
    } else {
        // 登録すらできていない = add が本当に失敗した。login の stderr があれば添える。
        let detail = login
            .ok()
            .map(|(_, _, stderr)| stderr)
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        Err(if detail.is_empty() {
            "Higgsfield MCP の登録に失敗しました。codex が利用可能か確認してください。".to_string()
        } else {
            format!("Higgsfield MCP の登録に失敗しました: {detail}")
        })
    }
}

/// Higgsfield MCP の登録を解除する (codex mcp remove)。解除後は app-server にも
/// 再読込させ、直接呼び出し経路からも消す。
#[tauri::command]
pub async fn higgsfield_mcp_logout(state: State<'_, AppState>) -> Result<(), String> {
    let _ = run_codex_capture(
        &["mcp", "remove", HIGGSFIELD_MCP_NAME],
        std::time::Duration::from_secs(30),
    )
    .await?;
    reload_mcp_servers(&state).await;
    Ok(())
}

/// Higgsfield 生成の結果。コアの BatchGenResult / MagnificGenResult と同じ形に揃えて
/// フロントが区別不要にする。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpGenResult {
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
    pub errors: Vec<String>,
}

/// 画像 / 動画の分岐。フロントの `MediaType` ("image" | "video") と鏡映。
/// 未指定 (None) は image 扱い (画像生成と後方互換)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HiggsfieldMcpMediaType {
    Image,
    Video,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpGenArgs {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub ref_image_paths: Vec<String>,
    /// "image" | "video"。未指定なら image (後方互換)。
    #[serde(default)]
    pub media_type: Option<HiggsfieldMcpMediaType>,
    // ── 以下は media_type=video のときだけ意味を持つ動画パラメータ ──
    /// 秒数 (例: 5)。generate_video の duration。
    #[serde(default)]
    pub duration: Option<u32>,
    /// 描画モード (例: seedance std/fast)。
    #[serde(default)]
    pub mode: Option<String>,
    /// 解像度 (例: seedance 480p/720p/1080p)。
    #[serde(default)]
    pub resolution: Option<String>,
    /// 効果音 (例: kling on/off)。
    #[serde(default)]
    pub sound: Option<String>,
    /// ジャンル (例: seedance auto/action/horror/comedy/noir/drama/epic)。
    #[serde(default)]
    pub genre: Option<String>,
    /// モデルのバリアント。
    #[serde(default)]
    pub model_variant: Option<String>,
}

impl HiggsfieldMcpGenArgs {
    fn is_video(&self) -> bool {
        matches!(self.media_type, Some(HiggsfieldMcpMediaType::Video))
    }
}

/// generate_image / generate_video の arguments (`{"params": {...}}` ラッパー) を組む。
/// モデル固有パラメータ (duration / mode / resolution / sound / genre / model_variant) も
/// params 直下に置く (PoC 実証済み。inputSchema は additionalProperties 許容)。
#[allow(clippy::too_many_arguments)]
fn build_gen_arguments(
    model: &str,
    prompt: &str,
    aspect: &str,
    count: u32,
    duration: Option<u32>,
    mode: Option<&str>,
    resolution: Option<&str>,
    sound: Option<&str>,
    genre: Option<&str>,
    model_variant: Option<&str>,
    medias: &[Value],
    get_cost: bool,
) -> Value {
    let mut p = serde_json::Map::new();
    p.insert("model".into(), json!(model));
    p.insert("prompt".into(), json!(prompt));
    p.insert("aspect_ratio".into(), json!(aspect));
    p.insert("count".into(), json!(count));
    if let Some(d) = duration {
        p.insert("duration".into(), json!(d));
    }
    let mut push_opt = |key: &str, v: Option<&str>| {
        if let Some(s) = v.filter(|s| !s.trim().is_empty()) {
            p.insert(key.into(), json!(s));
        }
    };
    push_opt("mode", mode);
    push_opt("resolution", resolution);
    push_opt("sound", sound);
    push_opt("genre", genre);
    push_opt("model_variant", model_variant);
    if !medias.is_empty() {
        p.insert("medias".into(), Value::Array(medias.to_vec()));
    }
    if get_cost {
        p.insert("get_cost".into(), json!(true));
    }
    json!({ "params": Value::Object(p) })
}

/// 結果 URL から保存に使う拡張子を決める。URL のクエリを除いたパスの末尾拡張子を
/// 優先し、無ければ media_type のデフォルト (video=mp4 / image=png) にフォールバックする。
fn extension_for(url: &str, is_video: bool) -> String {
    // クエリ・フラグメントを落としてからパスの拡張子を見る。
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, e)| e))
        .map(|e| e.to_ascii_lowercase());
    let known = [
        "mp4", "mov", "webm", "m4v", // 動画
        "png", "jpg", "jpeg", "webp", "gif", // 画像
    ];
    match ext {
        Some(e) if known.contains(&e.as_str()) => e,
        // 拡張子が無い / 未知の場合は media_type で決める。
        _ => {
            if is_video {
                "mp4".to_string()
            } else {
                "png".to_string()
            }
        }
    }
}

/// ローカルファイルの拡張子から Content-Type を推定する (media_upload 用)。
fn content_type_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".mp4") || lower.ends_with(".m4v") {
        "video/mp4"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else {
        // Higgsfield 側は filename からも推定するので、未知拡張子は octet-stream で送る。
        "application/octet-stream"
    }
}

/// 参照画像 1 枚を media_upload → HTTP PUT → media_confirm で media_id 化する。
/// (PoC 実証済みフロー。upload_url への PUT は Content-Type ヘッダ必須)
async fn upload_reference(
    state: &AppState,
    http: &reqwest::Client,
    path: &str,
) -> Result<String, String> {
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "reference.png".to_string());
    let content_type = content_type_for_path(path);

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("参照画像を読み込めませんでした ({path}): {e}"))?;

    // ① アップロード URL + media_id を発行
    let out = call_tool(
        state,
        HIGGSFIELD_MCP_NAME,
        "media_upload",
        json!({ "filename": filename, "content_type": content_type }),
    )
    .await?;
    if out.is_error {
        return Err(format!(
            "参照画像のアップロード準備に失敗しました: {}",
            out.text
        ));
    }
    let upload = out
        .structured
        .as_ref()
        .and_then(|s| s.get("uploads"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .cloned()
        .ok_or_else(|| "media_upload の応答に uploads がありません".to_string())?;
    let upload_url = upload
        .get("upload_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "media_upload の応答に upload_url がありません".to_string())?
        .to_string();
    let media_id = upload
        .get("media_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "media_upload の応答に media_id がありません".to_string())?
        .to_string();

    // ② 発行 URL へ PUT (presigned URL は Content-Type が署名に含まれるため必須)
    let res = http
        .put(&upload_url)
        .header(reqwest::header::CONTENT_TYPE, content_type)
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

    // ③ confirm して media_id を有効化
    let media_kind = if content_type.starts_with("video") {
        "video"
    } else {
        "image"
    };
    let out = call_tool(
        state,
        HIGGSFIELD_MCP_NAME,
        "media_confirm",
        json!({ "type": media_kind, "media_id": media_id }),
    )
    .await?;
    if out.is_error {
        return Err(format!("参照画像の確定に失敗しました: {}", out.text));
    }
    Ok(media_id)
}

/// 参照画像に付ける role をモデルカタログから引く。models_explore(action:get) の
/// medias[].roles を見て、"image" があればそれ、無ければ最初の role。取得に失敗したら
/// "image" (サーバ側に auto-coerce があるため致命にならない)。
async fn resolve_media_role(state: &AppState, model: &str) -> String {
    let fallback = "image".to_string();
    let Ok(out) = call_tool(
        state,
        HIGGSFIELD_MCP_NAME,
        "models_explore",
        json!({ "action": "get", "model_id": model }),
    )
    .await
    else {
        return fallback;
    };
    let Some(s) = out.structured.as_ref() else {
        return fallback;
    };
    // 応答が item / items[0] / 直下のどれでも拾えるようにする。
    let item = s
        .get("item")
        .or_else(|| s.get("items").and_then(|v| v.get(0)))
        .unwrap_or(s);
    let Some(medias) = item.get("medias").and_then(|v| v.as_array()) else {
        return fallback;
    };
    let mut first_role: Option<String> = None;
    for media in medias {
        if let Some(roles) = media.get("roles").and_then(|v| v.as_array()) {
            for role in roles.iter().filter_map(|r| r.as_str()) {
                if role == "image" {
                    return "image".to_string();
                }
                if first_role.is_none() {
                    first_role = Some(role.to_string());
                }
            }
        }
    }
    first_role.unwrap_or(fallback)
}

/// 投入応答 structuredContent.results[] から job id を集める。
fn extract_job_ids(structured: Option<&Value>) -> Vec<String> {
    structured
        .and_then(|s| s.get("results"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 1 つの job を完了までポーリングし、成果物 URL を返す。
///
/// job_status は sync: true でサーバ側が最大約 25 秒待ってから返すため、クライアント側の
/// sleep は最小限 (1 秒) で良い。deadline を超えたらタイムアウトエラー。
async fn poll_higgsfield_job(
    state: &AppState,
    job_id: &str,
    deadline: Instant,
) -> Result<String, String> {
    loop {
        let out = call_tool(
            state,
            HIGGSFIELD_MCP_NAME,
            "job_status",
            json!({ "jobId": job_id, "sync": true }),
        )
        .await?;
        if out.is_error {
            return Err(format!("生成状況の取得に失敗しました: {}", out.text));
        }
        let gen = out
            .structured
            .as_ref()
            .and_then(|s| s.get("generation"))
            .cloned()
            .unwrap_or(Value::Null);
        let status = gen
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        match status.as_str() {
            "completed" => {
                let url = gen
                    .get("results")
                    .and_then(|r| r.get("rawUrl").or_else(|| r.get("raw_url")))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                return url.ok_or_else(|| {
                    "生成は完了しましたが、結果URLを取得できませんでした".to_string()
                });
            }
            "failed" | "cancelled" | "canceled" | "error" | "nsfw" => {
                let reason = gen
                    .get("error")
                    .or_else(|| gen.get("reason"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        if out.text.is_empty() {
                            format!("生成が {status} で終了しました")
                        } else {
                            out.text.clone()
                        }
                    });
                return Err(reason);
            }
            // pending / processing / queued / 不明ステータスは継続。
            _ => {
                if Instant::now() >= deadline {
                    return Err("生成がタイムアウトしました (混雑している可能性があります。少し時間をおいて再試行してください)".to_string());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// Higgsfield MCP 経由で画像 **または動画** を生成し、結果 URL を
/// generated_images/higgsfield/ にダウンロードする。コア(batch_gen)は触らず、
/// Higgsfield モデルが選ばれたときだけこの経路を通る。
///
/// LLM を介さない直接呼び出し: 参照画像を media_id 化 → generate_image/generate_video を
/// 1 コールで count 枚投入 → 各 job を並行ポーリング → 完了 URL を DL 保存。
#[tauri::command]
pub async fn higgsfield_mcp_generate_batch(
    state: State<'_, AppState>,
    args: HiggsfieldMcpGenArgs,
) -> Result<HiggsfieldMcpGenResult, String> {
    let Some(model) = args.model.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Err(
            "Higgsfield のモデルが未選択です。モデルを選んでから生成してください。".to_string(),
        );
    };
    let count = args.count.unwrap_or(1).clamp(1, 4);
    let aspect = args
        .aspect
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("1:1");
    let is_video = args.is_video();
    let noun = if is_video { "動画" } else { "画像" };
    // 生成全体の締め切り。動画は画像より重い (DEV-PLAYBOOK 生成3点セットの 900 秒に揃える)。
    let deadline = Instant::now() + Duration::from_secs(if is_video { 900 } else { 300 });

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("higgsfield");
    std::fs::create_dir_all(&dir).map_err(|e| format!("higgsfield dir 作成失敗: {e}"))?;
    let http = reqwest::Client::new();

    let mut generated_paths = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // ① 参照画像を media_id 化 (role はモデルカタログから決定)
    let ref_paths: Vec<&String> = args
        .ref_image_paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .collect();
    let mut medias: Vec<Value> = Vec::new();
    if !ref_paths.is_empty() {
        let role = resolve_media_role(&state, model).await;
        for path in &ref_paths {
            match upload_reference(&state, &http, path).await {
                Ok(media_id) => medias.push(json!({ "value": media_id, "role": role })),
                Err(e) => {
                    // 参照画像が 1 枚も使えないまま生成すると意図と違う絵になるため、
                    // アップロード失敗は即エラーで返す (ユーザーが状況を直せる)。
                    return Ok(HiggsfieldMcpGenResult {
                        generated_paths,
                        failed_count: count,
                        errors: vec![e],
                    });
                }
            }
        }
    }

    // ② 1 コールで count 枚投入 (応答 results[].id が job id)
    let arguments = build_gen_arguments(
        model,
        &args.prompt,
        aspect,
        count,
        args.duration,
        args.mode.as_deref(),
        args.resolution.as_deref(),
        args.sound.as_deref(),
        args.genre.as_deref(),
        args.model_variant.as_deref(),
        &medias,
        false,
    );
    let tool = if is_video {
        "generate_video"
    } else {
        "generate_image"
    };
    let out = call_tool(&state, HIGGSFIELD_MCP_NAME, tool, arguments).await?;
    if out.is_error {
        return Ok(HiggsfieldMcpGenResult {
            generated_paths,
            failed_count: count,
            errors: vec![format!(
                "Higgsfield {noun}生成の投入に失敗しました: {}",
                out.text
            )],
        });
    }
    let job_ids = extract_job_ids(out.structured.as_ref());
    if job_ids.is_empty() {
        return Ok(HiggsfieldMcpGenResult {
            generated_paths,
            failed_count: count,
            errors: vec![format!(
                "Higgsfield {noun}生成のジョブIDを取得できませんでした: {}",
                out.text
            )],
        });
    }

    // ③ 各 job を並行ポーリング (sync: true なのでサーバ側が待つ)
    let polls = job_ids
        .iter()
        .map(|job| poll_higgsfield_job(&state, job, deadline));
    let poll_results = futures::future::join_all(polls).await;

    // ④ 完了 URL を DL 保存
    let mut failed_count = 0u32;
    for (i, result) in poll_results.into_iter().enumerate() {
        let url = match result {
            Ok(u) => u,
            Err(e) => {
                failed_count += 1;
                errors.push(e);
                continue;
            }
        };
        let ext = extension_for(&url, is_video);
        match http.get(&url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) if !bytes.is_empty() => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let dest = dir.join(format!("higgsfield-{ts}-{i}.{ext}"));
                    if let Err(e) = std::fs::write(&dest, &bytes) {
                        failed_count += 1;
                        errors.push(format!("{noun}保存失敗: {e}"));
                    } else {
                        generated_paths.push(dest.to_string_lossy().into_owned());
                    }
                }
                _ => {
                    failed_count += 1;
                    errors.push(format!("Higgsfield {noun}データが空でした"));
                }
            },
            Ok(res) => {
                failed_count += 1;
                errors.push(format!(
                    "Higgsfield {noun}取得に失敗 (HTTP {})",
                    res.status()
                ));
            }
            Err(e) => {
                failed_count += 1;
                errors.push(format!("Higgsfield {noun}取得に失敗: {e}"));
            }
        }
    }
    // 投入できた job 数が count に満たない場合も失敗として数える。
    failed_count += count.saturating_sub(job_ids.len() as u32);

    Ok(HiggsfieldMcpGenResult {
        generated_paths,
        failed_count,
        errors,
    })
}

// ─────────────────────────── モデル一覧 / コスト / 残高 ───────────────────────────

/// モデル一覧の1件。フロントの `HiggsfieldModelInfo` ({displayName, jobSetType, type}) と鏡映。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldMcpModelInfo {
    #[serde(rename = "displayName", alias = "display_name", alias = "name")]
    pub display_name: String,
    #[serde(rename = "jobSetType", alias = "job_set_type", alias = "id")]
    pub job_set_type: String,
    /// "image" | "video"。
    #[serde(rename = "type", default)]
    pub r#type: String,
}

/// Higgsfield MCP の `models_explore` で画像 / 動画モデル一覧を動的取得する。
///
/// 直接呼び出し (実測 1.1 秒)。structuredContent.items[] の {id, name, output_type} を
/// フロント互換形 {jobSetType, displayName, type} に写す。
#[tauri::command]
pub async fn higgsfield_mcp_list_models(
    state: State<'_, AppState>,
    media: String,
) -> Result<Vec<HiggsfieldMcpModelInfo>, String> {
    let media = match media.as_str() {
        "image" => "image",
        "video" => "video",
        _ => return Err("media は image または video を指定してください。".to_string()),
    };

    let out = call_tool(
        &state,
        HIGGSFIELD_MCP_NAME,
        "models_explore",
        json!({ "action": "list", "type": media, "limit": 100 }),
    )
    .await?;
    if out.is_error {
        return Err(format!(
            "Higgsfield モデル一覧の取得に失敗しました: {}",
            out.text
        ));
    }
    let items = out
        .structured
        .as_ref()
        .and_then(|s| s.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "Higgsfield モデル一覧の応答に items がありません".to_string())?;

    let mut models = Vec::with_capacity(items.len());
    for item in &items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(id)
            .to_string();
        let kind = item
            .get("output_type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(media)
            .to_string();
        models.push(HiggsfieldMcpModelInfo {
            display_name: name,
            job_set_type: id.to_string(),
            r#type: kind,
        });
    }
    Ok(models)
}

/// コスト見積もりの入力。生成バッチ (HiggsfieldMcpGenArgs) と同じ動画パラメータを受け取り、
/// get_cost=true で「消費クレジットだけ」を取得する。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldMcpCostArgs {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub aspect: Option<String>,
    /// "image" | "video"。未指定なら image (後方互換)。
    #[serde(default)]
    pub media_type: Option<HiggsfieldMcpMediaType>,
    // ── 以下は media_type=video のときだけ意味を持つ動画パラメータ ──
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub sound: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub model_variant: Option<String>,
}

impl HiggsfieldMcpCostArgs {
    fn is_video(&self) -> bool {
        matches!(self.media_type, Some(HiggsfieldMcpMediaType::Video))
    }
}

/// Higgsfield MCP の `get_cost` でコストだけを見積もる (実生成しない)。
///
/// 直接呼び出し: structuredContent.cost.{credits_exact, credits} を読む。
/// CLI 版と同じく表示用に四捨五入した i64 を返す。
#[tauri::command]
pub async fn higgsfield_mcp_generate_cost(
    state: State<'_, AppState>,
    args: HiggsfieldMcpCostArgs,
) -> Result<i64, String> {
    let Some(model) = args.model.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Err("Higgsfield のモデルが未選択です。".to_string());
    };
    let aspect = args
        .aspect
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("1:1");
    let tool = if args.is_video() {
        "generate_video"
    } else {
        "generate_image"
    };
    let arguments = build_gen_arguments(
        model,
        &args.prompt,
        aspect,
        1,
        args.duration,
        args.mode.as_deref(),
        args.resolution.as_deref(),
        args.sound.as_deref(),
        args.genre.as_deref(),
        args.model_variant.as_deref(),
        &[],
        true,
    );
    let out = call_tool(&state, HIGGSFIELD_MCP_NAME, tool, arguments).await?;
    if out.is_error {
        return Err(format!(
            "Higgsfield コスト見積もりに失敗しました: {}",
            out.text
        ));
    }
    // structuredContent.cost.{credits_exact, credits} を最優先、無ければ text の数値。
    let credits = out
        .structured
        .as_ref()
        .and_then(|s| s.get("cost"))
        .and_then(json_to_number)
        .or_else(|| out.structured.as_ref().and_then(json_to_number))
        .or_else(|| extract_first_number(&out.text))
        .ok_or_else(|| "Higgsfield コスト見積もりの数値を取得できませんでした".to_string())?;
    Ok(credits.round() as i64)
}

/// クレジット残高 + プラン名。フロント互換形 ({email?, credits, subscriptionPlanType?})。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldMcpAccount {
    /// メールアドレス (取得できなければ None)。
    #[serde(default)]
    pub email: Option<String>,
    /// 利用可能クレジット数。小数で返りうるので f64。
    #[serde(default)]
    pub credits: f64,
    /// 現在のプラン名 (取得できなければ None)。
    #[serde(
        rename = "subscriptionPlanType",
        alias = "subscription_plan_type",
        alias = "plan",
        default
    )]
    pub subscription_plan_type: Option<String>,
}

/// Higgsfield MCP の `balance` ツールで利用可能クレジット + プラン名を取得する。
///
/// 直接呼び出し (実測 0.8 秒)。structuredContent.{credits, subscription_plan_type} を読む。
#[tauri::command]
pub async fn higgsfield_mcp_account(
    state: State<'_, AppState>,
) -> Result<HiggsfieldMcpAccount, String> {
    let out = call_tool(&state, HIGGSFIELD_MCP_NAME, "balance", json!({})).await?;
    if out.is_error {
        return Err(format!("Higgsfield 残高の取得に失敗しました: {}", out.text));
    }
    let Some(structured) = out.structured.as_ref() else {
        // structuredContent が無いバージョン差に備え、text の数値だけでも拾う。
        let credits = extract_first_number(&out.text)
            .ok_or_else(|| "Higgsfield 残高からクレジット数を取得できませんでした".to_string())?;
        return Ok(HiggsfieldMcpAccount {
            email: None,
            credits,
            subscription_plan_type: None,
        });
    };

    // まず構造体として直接パースを試み、credits が欠けていたら数値フォールバックで補う。
    match serde_json::from_value::<HiggsfieldMcpAccount>(structured.clone()) {
        Ok(acc) => Ok(acc),
        Err(_) => {
            let credits = json_to_number(structured)
                .or_else(|| extract_first_number(&out.text))
                .ok_or_else(|| {
                    "Higgsfield 残高からクレジット数を取得できませんでした".to_string()
                })?;
            let email = structured
                .get("email")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let plan = structured
                .get("subscriptionPlanType")
                .or_else(|| structured.get("subscription_plan_type"))
                .or_else(|| structured.get("plan"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Ok(HiggsfieldMcpAccount {
                email,
                credits,
                subscription_plan_type: plan,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_gen_arguments_wraps_in_params() {
        let v = build_gen_arguments(
            "seedance_2_0",
            "a corgi",
            "16:9",
            2,
            Some(5),
            Some("std"),
            Some("720p"),
            None,
            Some("auto"),
            None,
            &[json!({"value": "abc", "role": "image"})],
            false,
        );
        let p = v.get("params").expect("params wrapper");
        assert_eq!(p.get("model").unwrap(), "seedance_2_0");
        assert_eq!(p.get("count").unwrap(), 2);
        assert_eq!(p.get("duration").unwrap(), 5);
        assert_eq!(p.get("resolution").unwrap(), "720p");
        assert!(p.get("sound").is_none());
        assert_eq!(p.get("medias").unwrap().as_array().unwrap().len(), 1);
        assert!(p.get("get_cost").is_none());
    }

    #[test]
    fn build_gen_arguments_get_cost() {
        let v = build_gen_arguments(
            "nano_banana_2",
            "a corgi",
            "1:1",
            1,
            None,
            None,
            None,
            None,
            None,
            None,
            &[],
            true,
        );
        let p = v.get("params").unwrap();
        assert_eq!(p.get("get_cost").unwrap(), true);
        assert!(p.get("medias").is_none());
    }

    #[test]
    fn extract_job_ids_reads_results() {
        let s = json!({"results": [
            {"id": "job-1", "status": "pending"},
            {"id": "job-2", "status": "pending"},
            {"status": "pending"}
        ]});
        assert_eq!(extract_job_ids(Some(&s)), vec!["job-1", "job-2"]);
        assert!(extract_job_ids(None).is_empty());
    }

    #[test]
    fn extension_for_strips_query_and_falls_back() {
        assert_eq!(extension_for("https://x/y/a.png?sig=1", false), "png");
        assert_eq!(extension_for("https://x/y/a.mp4#t", true), "mp4");
        assert_eq!(extension_for("https://x/y/noext", true), "mp4");
        assert_eq!(extension_for("https://x/y/noext", false), "png");
    }

    #[test]
    fn content_type_for_path_known_kinds() {
        assert_eq!(content_type_for_path("/a/b.PNG"), "image/png");
        assert_eq!(content_type_for_path("/a/b.jpeg"), "image/jpeg");
        assert_eq!(content_type_for_path("/a/b.mov"), "video/quicktime");
        assert_eq!(
            content_type_for_path("/a/b.bin"),
            "application/octet-stream"
        );
    }

    #[test]
    fn json_to_number_prefers_exact_credits() {
        let cost = json!({"credits": 1, "credits_exact": 1.5});
        assert_eq!(json_to_number(&cost), Some(1.5));
        assert_eq!(
            extract_first_number("Credits: 445.77 | Plan: creator"),
            Some(445.77)
        );
    }
}
