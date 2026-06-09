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
//!   {directUploadUrl, path} → その URL へ HTTP PUT (Content-Type 必須) →
//!   `creations_finalize_upload` {path} → {identifier} → images_generate の
//!   references: [{type: "image", identifier}]。
//! - `account_balance` {} → {plan: {tier, isUnlimitedMode}, credits: {available, ...}}。
//!   (v1.1.0 時点の「MCP が credit を返さない」は旧情報。現 MCP は残高を返す)

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::codex::mcp_direct::{call_tool, reload_mcp_servers};
use crate::codex::mcp_shared::{entry_is_authenticated, find_mcp_entry, gori_codex_command, run_codex_capture};
use crate::state::AppState;

const MAGNIFIC_MCP_NAME: &str = "magnific";
const MAGNIFIC_MCP_URL: &str = "https://mcp.magnific.com";

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
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        child.wait_with_output(),
    )
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
    } else {
        Err(if login.2.is_empty() {
            "Magnific の認証に失敗しました。ブラウザでのログインを完了したか確認してください。".to_string()
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

/// 参照画像 1 枚を request_upload → HTTP PUT → finalize_upload で creation identifier 化する。
/// (PoC 実証済みフロー。directUploadUrl への PUT は Content-Type ヘッダ必須)
async fn upload_magnific_reference(
    state: &AppState,
    http: &reqwest::Client,
    path: &str,
) -> Result<String, String> {
    let mime = magnific_mime_for_path(path).ok_or_else(|| {
        format!("Magnific の参照画像は PNG / JPEG / WebP のみ対応です ({path})")
    })?;
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
        return Err(format!("参照画像のアップロード準備に失敗しました: {}", out.text));
    }
    let structured = out.structured.unwrap_or(Value::Null);
    let upload_url = structured
        .get("directUploadUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "creations_request_upload の応答に directUploadUrl がありません".to_string())?
        .to_string();
    let upload_path = structured
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "creations_request_upload の応答に path がありません".to_string())?
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
    out.structured
        .as_ref()
        .and_then(|s| s.get("identifier"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "creations_finalize_upload の応答に identifier がありません".to_string())
}

/// images_generate の応答 structuredContent.creations[] から identifier を集める。
fn extract_creation_ids(structured: Option<&Value>) -> Vec<String> {
    structured
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
                    error: Some(
                        r.get("error")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
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
        return Err("Magnific のモデルが未選択です。モデルを選んでから生成してください。".to_string());
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
            Ok(identifier) => {
                references.push(json!({ "type": "image", "identifier": identifier }))
            }
            Err(e) => {
                // 参照画像が使えないまま生成すると意図と違う絵になるため即返す。
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
    let out = call_tool(
        &state,
        MAGNIFIC_MCP_NAME,
        "images_generate",
        Value::Object(gen_args),
    )
    .await?;
    if out.is_error {
        return Ok(MagnificGenResult {
            generated_paths,
            failed_count: count,
            errors: vec![format!("Magnific 画像生成の投入に失敗しました: {}", out.text)],
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
            errors.push(format!(
                "Magnific 生成がタイムアウトしました ({} 件未完了)",
                pending.len()
            ));
            break;
        }
        let out = call_tool(
            &state,
            MAGNIFIC_MCP_NAME,
            "creations_wait",
            json!({ "identifiers": pending, "timeoutSeconds": 25 }),
        )
        .await?;
        if out.is_error {
            errors.push(format!("Magnific 生成の完了待ちに失敗しました: {}", out.text));
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
                (None, None) => {
                    errors.push("生成は完了しましたが、結果URLを取得できませんでした".to_string())
                }
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
                        errors.push(format!("画像保存失敗: {e}"));
                    } else {
                        generated_paths.push(dest.to_string_lossy().into_owned());
                    }
                }
                _ => errors.push("Magnific 画像データが空でした".to_string()),
            },
            Ok(res) => errors.push(format!("Magnific 画像取得に失敗 (HTTP {})", res.status())),
            Err(e) => errors.push(format!("Magnific 画像取得に失敗: {e}")),
        }
    }

    let failed_count = count.saturating_sub(generated_paths.len() as u32);
    Ok(MagnificGenResult {
        generated_paths,
        failed_count,
        errors,
    })
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

/// Magnific MCP の `account_balance` で残高 + プランを取得する (実測 1 秒前後)。
#[tauri::command]
pub async fn magnific_account(state: State<'_, AppState>) -> Result<MagnificAccount, String> {
    let out = call_tool(&state, MAGNIFIC_MCP_NAME, "account_balance", json!({})).await?;
    if out.is_error {
        return Err(format!("Magnific 残高の取得に失敗しました: {}", out.text));
    }
    let structured = out
        .structured
        .ok_or_else(|| "Magnific 残高の応答を取得できませんでした".to_string())?;
    let credits = structured
        .get("credits")
        .and_then(|c| c.get("available"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let plan = structured
        .get("plan")
        .and_then(|p| p.get("productName").or_else(|| p.get("tier")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let unlimited = structured
        .get("plan")
        .and_then(|p| p.get("isUnlimitedMode"))
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
            {"identifier": "b", "status": "failed", "error": "nsfw detected"},
            {"identifier": "c", "status": "queued"}
        ], "allTerminal": false});
        let entries = parse_wait_results(Some(&s));
        assert_eq!(entries.len(), 3);
        assert!(entries[0].terminal);
        assert_eq!(entries[0].url.as_deref(), Some("https://x/r.png"));
        assert!(entries[1].terminal);
        assert_eq!(entries[1].error.as_deref(), Some("nsfw detected"));
        assert!(!entries[2].terminal);
    }

    #[test]
    fn magnific_mime_rejects_unsupported() {
        assert_eq!(magnific_mime_for_path("/a/b.PNG"), Some("image/png"));
        assert_eq!(magnific_mime_for_path("/a/b.jpeg"), Some("image/jpeg"));
        assert_eq!(magnific_mime_for_path("/a/b.webp"), Some("image/webp"));
        assert_eq!(magnific_mime_for_path("/a/b.gif"), None);
    }
}
