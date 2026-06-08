//! Magnific オプショナル拡張 (2026-06-08 STΛCK 指示)。
//!
//! ## 設計の鉄則
//! - コア (codex/gpt-image-2) には一切手を入れない。これは全員が使う土台。
//! - Magnific は「持ってる人だけ」のオプショナル拡張。未接続なら存在しないかのように degrade する。
//! - Higgsfield と違い CLI バイナリの別 DL は不要。Magnific MCP (mcp.magnific.com, OAuth) を
//!   GORI 専用 CODEX_HOME の config.toml に登録するだけで有効化される。
//! - 接続済みかどうかは `codex mcp list` の magnific 行と config.toml の存在で判定する。

use std::process::Command;

use serde::{Deserialize, Serialize};

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
fn gori_codex_command() -> Result<Command, String> {
    let binary = resolve_codex_cli_binary()
        .map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
    let mut cmd = Command::new(binary);
    cmd.env("PATH", enriched_path());
    if let Some(home) = crate::codex::home::gori_codex_home_path() {
        cmd.env("CODEX_HOME", home);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Magnific 拡張の接続状態を返す。失敗しても起動を止めず、未接続として degrade する。
#[tauri::command]
pub async fn magnific_status() -> Result<MagnificStatus, String> {
    let mut cmd = match gori_codex_command() {
        Ok(c) => c,
        // codex が無い環境では「未接続」として扱う (コアは別経路なので影響しない)。
        Err(_) => {
            return Ok(MagnificStatus {
                registered: false,
                authenticated: false,
            })
        }
    };
    cmd.args(["mcp", "list"]);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => {
            return Ok(MagnificStatus {
                registered: false,
                authenticated: false,
            })
        }
    };
    let text = String::from_utf8_lossy(&output.stdout);
    // magnific 行を探す。enabled かつ OAuth なら authenticated。
    let mut registered = false;
    let mut authenticated = false;
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains(MAGNIFIC_MCP_NAME) {
            registered = true;
            if lower.contains("enabled") && lower.contains("oauth") {
                authenticated = true;
            }
        }
    }
    Ok(MagnificStatus {
        registered,
        authenticated,
    })
}

/// Magnific MCP を登録し OAuth フローを開始する (codex mcp add)。
/// 既に登録済みなら codex が冪等に扱う。OAuth はブラウザで完了する。
#[tauri::command]
pub async fn magnific_login() -> Result<String, String> {
    let mut cmd = gori_codex_command()?;
    cmd.args(["mcp", "add", MAGNIFIC_MCP_NAME, "--url", MAGNIFIC_MCP_URL]);
    let output = cmd
        .output()
        .map_err(|e| format!("codex mcp add の実行に失敗しました: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() {
            format!("Magnific 接続に失敗しました: {}", output.status)
        } else {
            stderr
        })
    }
}

/// Magnific MCP の登録を解除する (codex mcp remove)。
#[tauri::command]
pub async fn magnific_logout() -> Result<(), String> {
    let mut cmd = gori_codex_command()?;
    cmd.args(["mcp", "remove", MAGNIFIC_MCP_NAME]);
    cmd.output()
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
