//! リモート MCP (Magnific / Higgsfield 等) を `codex mcp` 経由で扱うための共通基盤。
//!
//! ## なぜこのモジュール (2026-06-10 段階1: 共通モジュール化)
//!
//! Magnific (mcp.magnific.com) と Higgsfield (mcp.higgsfield.ai) は、どちらも
//! 「GORI 専用 CODEX_HOME の config.toml に MCP を登録し、OAuth 認証して、
//! `codex exec` 経由でツールを叩く」という **同一構造** を持つ。
//! CLI バイナリの別 DL は不要で、リモート HTTP MCP に接続するだけ。
//!
//! magnific.rs にこのロジックが先に書かれていたが、Higgsfield も同じものを
//! 必要とするため、ここに共通化する。magnific.rs / higgsfield_mcp.rs は本モジュールを
//! 使い、重複コードを持たない。
//!
//! ## 設計の鉄則 (magnific.rs から継承)
//! - コア (codex/gpt-image-2) には一切手を入れない。これは全員が使う土台。
//! - リモート MCP 拡張は「持ってる人だけ」のオプショナル。未接続なら degrade する。
//! - 接続済みかどうかは `codex mcp list --json` の該当行で判定する。

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::codex::process::{enriched_path, resolve_codex_auth_binary, resolve_codex_cli_binary};

/// GORI 専用 CODEX_HOME を環境に設定した codex `Command` を作る。
/// MCP 設定は専用 HOME の config.toml を読むため、必ずこの HOME を渡す。
///
/// `tokio::process::Command` を返すので、呼び出し側は `tokio::time::timeout` で
/// 子プロセスを打ち切れる。`mcp login` の OAuth は完了までブロックしうるため、
/// 同期 `std::process::Command::output()` だと UI が固まる。
pub fn gori_codex_command() -> Result<Command, String> {
    let binary =
        resolve_codex_cli_binary().map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
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

/// MCP の **認可 2 操作 (`mcp add` / `mcp login`) 専用** の codex `Command` を作る。
///
/// env 設定 (PATH enrich / GORI 専用 CODEX_HOME / no_window_flag / kill_on_drop) は
/// `gori_codex_command` と完全に同一で、**解決するバイナリだけ** が
/// `resolve_codex_auth_binary()` (= 同梱 codex-auth を優先、無ければ従来 CLI) になる。
/// 同一 CODEX_HOME を使うので、認可で得たトークンは日常実行側 (0.146.0) と共用される。
///
/// 配布先での切り分けのため、使用バイナリの絶対パスを必ずログに残す
/// (`resources/codex-auth` を指していなければフォールバック＝ issuer バグ経路)。
pub fn gori_codex_auth_command() -> Result<Command, String> {
    let binary =
        resolve_codex_auth_binary().map_err(|e| format!("codex CLI が見つかりません: {e}"))?;
    tracing::info!(
        target: "mcp.auth",
        binary = %binary.display(),
        "MCP 認可に使用するバイナリ"
    );
    let mut cmd = Command::new(binary);
    cmd.env("PATH", enriched_path());
    if let Some(home) = crate::codex::home::gori_codex_home_path() {
        cmd.env("CODEX_HOME", home);
    }
    crate::codex::process::no_window_flag(&mut cmd);
    cmd.kill_on_drop(true);
    Ok(cmd)
}

/// codex の単発サブコマンドを spawn し、タイムアウト付きで待つ。
/// stdin は閉じる (対話入力を待たせない)。`Ok((成功フラグ, stdout, stderr))` を返す。
///
/// `mcp login` の OAuth はブラウザ完了までブロックしうるので、同期 `output()` では
/// なくタイムアウト付き spawn で待つ (UI が固まらない・タイムアウトで子を kill)。
pub async fn run_codex_capture(
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    run_capture_with(gori_codex_command()?, args, timeout).await
}

/// `run_codex_capture` の **認可専用** 版。バイナリ解決が codex-auth になるだけで、
/// spawn / timeout / 出力整形の挙動は完全に同一。
pub async fn run_codex_auth_capture(
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    run_capture_with(gori_codex_auth_command()?, args, timeout).await
}

/// spawn〜timeout〜出力整形の共通処理。`run_codex_capture` と
/// `run_codex_auth_capture` が渡す `Command` だけが異なる (重複実装を作らない)。
async fn run_capture_with(
    mut cmd: Command,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
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
            return Err(format!(
                "codex {} の待機に失敗しました: {e}",
                args.join(" ")
            ))
        }
        Err(_elapsed) => {
            // kill_on_drop(true) なので child を drop すれば子も殺される。
            return Err(format!(
                "codex {} が {} 秒以内に完了しませんでした。ブラウザでのログインを完了してから、もう一度「接続」を押してください。",
                args.join(" "),
                timeout.as_secs()
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((output.status.success(), stdout, stderr))
}

/// `codex mcp list --json` の要素の `auth_status` から OAuth 認証済みかを判定する。
///
/// 実バイナリ検証 (2026-06-09 / 2026-06-10): `--json` は配列等を返し、各要素に
/// `name` と `auth_status` フィールドを持つ。OAuth 認証済み MCP は `auth_status` が
/// "oauth" 系の値になるが、codex の実値は `"o_auth"` (アンダースコア入り) のことが
/// ある (Magnific / Higgsfield 同一)。区切り文字を除去してから "oauth" を含むか判定し、
/// `"o_auth"` / `"o-auth"` / `"oauth"` を一律で拾う。未認証/非対応 `"unsupported"` や
/// Bearer `"bearer_token"` には誤反応しない。テキスト出力の `contains("oauth")` は
/// 列見出し等を誤検知して永久 false になりうるので使わない。
pub fn is_mcp_oauth_authenticated(auth_status: &str) -> bool {
    let normalized: String = auth_status
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    normalized.contains("oauth")
}

/// `codex mcp list --json` の stdout から、指定 `name` の MCP エントリを探して返す。
///
/// codex のバージョンにより、トップが配列 / `{ "servers": [...] }` / オブジェクト
/// (name -> entry) のいずれもありうる。3 形すべてにフォールバックして手堅く探す。
/// JSON 解析に失敗 / 該当ノードが無ければ `None` (= 未登録 / degrade)。
pub fn find_mcp_entry(stdout: &[u8], name: &str) -> Option<serde_json::Value> {
    let value = serde_json::from_slice::<serde_json::Value>(stdout).ok()?;

    let find_in_array = |arr: &[serde_json::Value]| -> Option<serde_json::Value> {
        arr.iter()
            .find(|item| {
                item.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.eq_ignore_ascii_case(name))
                    .unwrap_or(false)
            })
            .cloned()
    };

    if let Some(arr) = value.as_array() {
        find_in_array(arr)
    } else if let Some(arr) = value.get("servers").and_then(|s| s.as_array()) {
        find_in_array(arr)
    } else if let Some(obj) = value.as_object() {
        // name -> entry 形式 (キーが MCP 名)。値に name が無いことがあるのでキー一致でも拾う。
        obj.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    } else {
        None
    }
}

/// MCP エントリから `auth_status` 文字列を取り出し、OAuth 認証済みかを返す。
/// `find_mcp_entry` の結果を直接渡せる薄いヘルパ。
pub fn entry_is_authenticated(entry: &serde_json::Value) -> bool {
    let auth_status = entry
        .get("auth_status")
        .and_then(|a| a.as_str())
        .unwrap_or("");
    is_mcp_oauth_authenticated(auth_status)
}

/// テキストから最初の http(s) URL を抽出する。`codex exec` の最終メッセージに
/// 「URL のみ」と指示するが、念のため行全体を走査して http で始まるトークンを拾う。
/// 引用符 / バッククォート / 山括弧で囲まれた URL もトリムして拾う。
pub fn extract_first_url(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let t = token.trim_matches(|c| c == '`' || c == '"' || c == '\'' || c == '<' || c == '>');
        if t.starts_with("http://") || t.starts_with("https://") {
            return Some(t.to_string());
        }
    }
    None
}
