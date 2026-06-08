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
