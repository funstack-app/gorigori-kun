//! Magnific オプショナル拡張 (2026-06-08 STΛCK 指示)。
//!
//! ## 設計の鉄則
//! - コア (codex/gpt-image-2) には一切手を入れない。これは全員が使う土台。
//! - Magnific は「持ってる人だけ」のオプショナル拡張。未接続なら存在しないかのように degrade する。
//! - Higgsfield と違い CLI バイナリの別 DL は不要。Magnific MCP (mcp.magnific.com, OAuth) を
//!   GORI 専用 CODEX_HOME の config.toml に登録するだけで有効化される。
//! - 接続済みかどうかは `codex mcp list` の magnific 行と config.toml の存在で判定する。

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::codex::process::{enriched_path, resolve_codex_cli_binary};

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

/// GORI 専用 CODEX_HOME を環境に設定した codex Command を作る。
/// MCP 設定は専用 HOME の config.toml を読むため、必ずこの HOME を渡す。
///
/// `tokio::process::Command` を返すので、呼び出し側は `tokio::time::timeout` で
/// 子プロセスを打ち切れる。`mcp login` の OAuth は完了までブロックしうるため、
/// 同期 `std::process::Command::output()` だと UI が固まる。
fn gori_codex_command() -> Result<Command, String> {
    let binary = resolve_codex_cli_binary()
        .map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
    let mut cmd = Command::new(binary);
    cmd.env("PATH", enriched_path());
    if let Some(home) = crate::codex::home::gori_codex_home_path() {
        cmd.env("CODEX_HOME", home);
    }
    // Windows での黒い console window 抑制 (process.rs の no_window_flag と同等)。
    crate::codex::process::no_window_flag(&mut cmd);
    cmd.kill_on_drop(true);
    Ok(cmd)
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
/// 実バイナリ検証 (2026-06-09): `--json` は配列を返し、各要素に `name` と
/// `auth_status` フィールドを持つ。OAuth 認証済み MCP は `auth_status` が
/// "oauth" 系の値になる (未認証/非対応は "unsupported"、Bearer 系は "Bearer token")。
/// テキスト出力の `contains("oauth")` は列見出し等を誤検知して永久 false に
/// なりうるので使わない。JSON 構造が想定と違っても落とさず degrade する。
fn parse_magnific_status(stdout: &[u8]) -> MagnificStatus {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return magnific_status_unavailable();
    };

    // codex のバージョンにより、トップが配列 / { "servers": [...] } / オブジェクト
    // (name -> entry) のいずれもありうる。手堅く「magnific を表すノード」を探す。
    let find_entry = |arr: &[serde_json::Value]| -> Option<serde_json::Value> {
        arr.iter()
            .find(|item| {
                item.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.eq_ignore_ascii_case(MAGNIFIC_MCP_NAME))
                    .unwrap_or(false)
            })
            .cloned()
    };

    let entry = if let Some(arr) = value.as_array() {
        find_entry(arr)
    } else if let Some(arr) = value.get("servers").and_then(|s| s.as_array()) {
        find_entry(arr)
    } else if let Some(obj) = value.as_object() {
        // name -> entry 形式 (キーが magnific)。値に name が無いことがあるので
        // キー一致でも拾う。
        obj.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(MAGNIFIC_MCP_NAME))
            .map(|(_, v)| v.clone())
    } else {
        None
    };

    let Some(entry) = entry else {
        // magnific ノードが無い = 未登録。
        return magnific_status_unavailable();
    };

    // ここまで来れば config.toml に magnific が登録されている。
    // codex の実際の auth_status 値は "o_auth"(アンダースコア入り) のことがある
    // (実機確認 2026-06-10: OAuth認証済みでも "o_auth" が返る)。区切り文字を除去
    // してから "oauth" を含むか判定し、"o_auth"/"o-auth"/"oauth" を一律で拾う。
    // 未認証/非対応 "unsupported" や Bearer "bearer_token" には誤反応しない。
    let auth_status = entry
        .get("auth_status")
        .and_then(|a| a.as_str())
        .unwrap_or("")
        .to_lowercase();
    let normalized: String = auth_status
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let authenticated = normalized.contains("oauth");

    MagnificStatus {
        registered: true,
        authenticated,
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
/// ユーザーがブラウザでログインを終えるまで子プロセスが生きるので、待ち時間を
/// 長めに取る。これを過ぎたら子を kill して案内メッセージを返す。
const MAGNIFIC_LOGIN_TIMEOUT_SECS: u64 = 180;

/// codex の単発サブコマンドを spawn し、タイムアウト付きで待つ。
/// stdin は閉じる (対話入力を待たせない)。Ok((成功フラグ, stdout, stderr)) を返す。
async fn run_codex_capture(
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<(bool, String, String), String> {
    let mut cmd = gori_codex_command()?;
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("codex {} の実行に失敗しました: {e}", args.join(" ")))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return Err(format!("codex {} の待機に失敗しました: {e}", args.join(" ")))
        }
        Err(_elapsed) => {
            // kill_on_drop(true) なので child を drop すれば子も殺される。
            return Err(format!(
                "Magnific のログインが {} 秒以内に完了しませんでした。ブラウザでのログインを完了してから、もう一度「接続」を押してください。",
                timeout.as_secs()
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((output.status.success(), stdout, stderr))
}

/// Magnific MCP を登録し OAuth 認証を起動する。
///
/// `codex mcp add` は config.toml に登録するだけで OAuth を起こさない (実バイナリ
/// 検証 2026-06-09)。OAuth ブラウザを開くのは独立コマンド `codex mcp login`。
/// そこで ① 未登録なら add → ② login の 2 段階で認証する。
///
/// `mcp login` は OAuth ブラウザの完了まで子プロセスがブロックしうるので、
/// 同期 `output()` ではなくタイムアウト付き spawn で待つ (UI が固まらない)。
#[tauri::command]
pub async fn magnific_login() -> Result<String, String> {
    // ① 登録 (mcp add)。既に登録済みだと codex が非ゼロ終了することがあるが、
    //    それはエラーにせず login に進む (冪等性)。
    let add = run_codex_capture(
        &["mcp", "add", MAGNIFIC_MCP_NAME, "--url", MAGNIFIC_MCP_URL],
        std::time::Duration::from_secs(30),
    )
    .await?;
    if !add.0 {
        // 「already exists」系は無視して login に進む。それ以外の本当の失敗で
        // login がまた失敗すれば、下でエラーが返るので二重に止めない。
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

/// Magnific MCP の登録を解除する (codex mcp remove)。
#[tauri::command]
pub async fn magnific_logout() -> Result<(), String> {
    let mut cmd = gori_codex_command()?;
    cmd.args(["mcp", "remove", MAGNIFIC_MCP_NAME]);
    cmd.stdin(Stdio::null());
    cmd.output()
        .await
        .map_err(|e| format!("codex mcp remove の実行に失敗しました: {e}"))?;
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

/// stdout から最初の http(s) 画像 URL を抽出する。codex に「最終メッセージは URL のみ」と
/// 指示するが、念のため行全体を走査して http で始まるトークンを拾う。
fn extract_first_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == '<' || c == '>');
        if t.starts_with("http://") || t.starts_with("https://") {
            return Some(t.to_string());
        }
    }
    None
}

/// Magnific MCP 経由で画像を生成し、結果 URL を generated_images/ にダウンロードする。
/// コア(batch_gen)は触らず、Magnific モデルが選ばれたときだけこの経路を通る。
#[tauri::command]
pub async fn magnific_generate_batch(args: MagnificGenArgs) -> Result<MagnificGenResult, String> {
    let binary = resolve_codex_cli_binary()
        .map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
    let home = crate::codex::home::gori_codex_home_path();
    let count = args.count.unwrap_or(1).clamp(1, 4);
    let aspect = args.aspect.as_deref().filter(|s| !s.is_empty()).unwrap_or("1:1");

    let mut generated_paths = Vec::new();
    let mut errors = Vec::new();
    let mut failed_count = 0u32;

    let base = crate::images::watcher::generated_images_dir()
        .ok_or_else(|| "generated_images ディレクトリの解決に失敗".to_string())?;
    let dir = base.join("magnific");
    std::fs::create_dir_all(&dir).map_err(|e| format!("magnific dir 作成失敗: {e}"))?;
    let http = reqwest::Client::new();

    for i in 0..count {
        // codex に Magnific MCP の images_generate を使わせ、結果 URL だけを返させる。
        let ref_note = if args.ref_image_paths.is_empty() {
            String::new()
        } else {
            format!("参照画像(references)として次を使う: {}\n", args.ref_image_paths.join(", "))
        };
        let prompt = format!(
            "Magnific MCP の images_generate ツールで画像を1枚生成してください。\n\
             - model: {model}\n\
             - aspectRatio: {aspect}\n\
             - prompt: {user_prompt}\n\
             {ref_note}\
             生成が完了したら creations_wait で完了を待ち、最終メッセージは\
             **生成された画像のダウンロードURL(http(s)で始まる1個)だけ**を1行で返してください。\
             説明文や他のテキストは一切含めないこと。",
            model = args.model,
            aspect = aspect,
            user_prompt = args.prompt,
            ref_note = ref_note,
        );

        let mut cmd = tokio::process::Command::new(&binary);
        cmd.args([
            "exec",
            // Windows では --full-auto(=--sandbox workspace-write)が
            // codex-windows-sandbox-setup.exe を要求して「見つかりません」で死ぬ。
            // BYO 配布(ユーザー自身の PC・自身のサブスク=外部サンドボックス環境)では
            // サンドボックス無効の bypass を使う。これで Windows でも生成できる
            // (2026-06-09 Windows sandbox-setup.exe 不在エラーの修正)。
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--color",
            "never",
            "-c",
            "model=gpt-5.5",
            "-c",
            "model_reasoning_effort=low",
            "-",
        ]);
        cmd.env("PATH", enriched_path());
        if let Some(h) = home.as_ref() {
            cmd.env("CODEX_HOME", h);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);

        use tokio::io::AsyncWriteExt;
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                failed_count += 1;
                errors.push(format!("codex spawn 失敗: {e}"));
                continue;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }

        // Magnific 生成は MCP 往復 + クラウド生成で時間がかかる。余裕をみて 300 秒。
        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                failed_count += 1;
                errors.push(format!("codex 実行失敗: {e}"));
                continue;
            }
            Err(_) => {
                failed_count += 1;
                errors.push("Magnific 生成が 300 秒でタイムアウトしました".to_string());
                continue;
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(url) = extract_first_url(&stdout) else {
            failed_count += 1;
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!(
                "Magnific 生成結果のURLを取得できませんでした (stderr: {})",
                stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("")
            ));
            continue;
        };

        // URL を generated_images/magnific/ にダウンロード保存。
        match http.get(&url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) if !bytes.is_empty() => {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    let dest = dir.join(format!("magnific-{ts}-{i}.png"));
                    if let Err(e) = std::fs::write(&dest, &bytes) {
                        failed_count += 1;
                        errors.push(format!("画像保存失敗: {e}"));
                    } else {
                        generated_paths.push(dest.to_string_lossy().into_owned());
                    }
                }
                _ => {
                    failed_count += 1;
                    errors.push("Magnific 画像データが空でした".to_string());
                }
            },
            Ok(res) => {
                failed_count += 1;
                errors.push(format!("Magnific 画像取得に失敗 (HTTP {})", res.status()));
            }
            Err(e) => {
                failed_count += 1;
                errors.push(format!("Magnific 画像取得に失敗: {e}"));
            }
        }
    }

    Ok(MagnificGenResult {
        generated_paths,
        failed_count,
        errors,
    })
}
