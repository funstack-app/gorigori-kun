//! app-server 経由の MCP ツール **直接呼び出し** (LLM を介さない決定論経路)。
//!
//! ## なぜこのモジュールか (2026-06-10 v1.1.0 配布後の実ユーザー障害対応)
//!
//! v1.1.0 までの Higgsfield/Magnific 連携は「`codex exec` で gpt-5.5 に
//! 『MCP ツールを呼んで結果だけ返して』とお願いする」LLM 仲介方式だった。これは:
//! - モデル一覧の取得に 30〜180 秒かかる (LLM 1 ターン分の往復が乗る)
//! - LLM がツールを呼ばない / 指示文をそのまま返す / URL 以外を返す事故が確率的に起きる
//!   (実ユーザー障害: 「JSON を取得できませんでした (stderr: 例: [...])」= プロンプトの
//!   例文がそのまま返った)
//! - gpt-5.5 へのアクセス・LLM 利用枠を、メタデータ取得ごときで消費する
//!
//! codex 0.136 の app-server には `mcpServer/tool/call` (JSON-RPC) があり、OAuth 済み
//! リモート MCP のツールを **LLM なしで直接** 呼べる (実測: models_explore 1.1 秒 /
//! balance 0.8 秒 / generate_image 投入 10 秒 → job_status sync で完了 URL 取得)。
//! GORI は常駐の app-server 子プロセスを既に抱えているため、その RpcClient を再利用する。
//!
//! ## 実機で確定済みの事実 (PoC 2026-06-10、推測ゼロ)
//! - `mcpServer/tool/call` params: { server, threadId(必須), tool, arguments }
//! - 応答: { content: [...], structuredContent?, isError? }
//! - ツールごとに arguments の形が違う: generate_image / generate_video は
//!   `{"params": {...}}` ラッパー、job_status / media_upload 等はトップレベル直。
//!   各ツールの inputSchema に従う (このモジュールは形を強制しない)。
//! - threadId は `thread/start` で発行。スレッドは MCP 呼び出しだけなら turn を作らない。

use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::codex::rpc::RpcClient;
use crate::state::AppState;

/// MCP ユーティリティ呼び出し専用 threadId のキャッシュ。
///
/// `mcpServer/tool/call` は threadId 必須だが、チャット用スレッドを汚したくないので
/// 専用スレッドを 1 本だけ作って使い回す。app-server が再起動すると無効になりうるため、
/// 呼び出しが失敗したら作り直して 1 回だけリトライする (call_tool 参照)。
static UTILITY_THREAD: Mutex<Option<String>> = Mutex::const_new(None);

/// tool/call の結果。structuredContent があれば最優先で使い、無ければ content の
/// text を結合したものをフォールバックに使う。
#[derive(Debug, Clone)]
pub struct ToolCallOutput {
    /// MCP ツールが返した structuredContent (あれば)。
    pub structured: Option<Value>,
    /// content[] 内の text を改行結合したもの。
    pub text: String,
    /// MCP ツールがエラーを返したか (isError)。
    pub is_error: bool,
}

/// 稼働中 app-server の RpcClient を取る。未起動なら分かるエラーを返す。
async fn rpc_client(state: &AppState) -> Result<RpcClient, String> {
    state
        .rpc()
        .await
        .ok_or_else(|| "GORI のコアエンジン (app-server) が起動していません。アプリを再起動してください。".to_string())
}

/// thread/start のレスポンスから threadId を取り出す。codex のバージョンにより
/// { threadId } / { thread: { id } } の両形がありうるので両対応する。
fn extract_thread_id(result: &Value) -> Option<String> {
    result
        .get("threadId")
        .and_then(|v| v.as_str())
        .or_else(|| {
            result
                .get("thread")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
}

/// ユーティリティスレッドを (なければ作って) 返す。
async fn ensure_utility_thread(client: &RpcClient) -> Result<String, String> {
    {
        let cached = UTILITY_THREAD.lock().await;
        if let Some(tid) = cached.as_ref() {
            return Ok(tid.clone());
        }
    }
    let result = client
        .request_raw("thread/start", json!({}))
        .await
        .map_err(|e| format!("MCP 用スレッドの作成に失敗しました: {e}"))?;
    let tid = extract_thread_id(&result)
        .ok_or_else(|| "thread/start の応答から threadId を取得できませんでした".to_string())?;
    *UTILITY_THREAD.lock().await = Some(tid.clone());
    Ok(tid)
}

/// キャッシュ済みユーティリティスレッドを破棄する (app-server 再起動後の無効 threadId 対策)。
async fn invalidate_utility_thread() {
    *UTILITY_THREAD.lock().await = None;
}

/// tool/call 応答 (content / structuredContent / isError) を ToolCallOutput に畳む。
fn parse_tool_result(result: Value) -> ToolCallOutput {
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let text = result
        .get("content")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let structured = result.get("structuredContent").cloned().filter(|v| !v.is_null());
    ToolCallOutput {
        structured,
        text,
        is_error,
    }
}

/// MCP ツールを LLM なしで直接呼ぶ (本モジュールの中核)。
///
/// - `server`: config.toml 上の MCP 名 ("higgsfield" / "magnific")
/// - `tool`: ツール名 ("models_explore" / "generate_image" / "job_status" 等)
/// - `arguments`: ツールの inputSchema に従った JSON (ラッパー有無はツール依存)
///
/// threadId が無効化されている場合 (app-server 再起動後など) は、スレッドを
/// 作り直して 1 回だけリトライする。MCP ツール自体のエラー (isError) はリトライ
/// しない (引数間違い・残高不足等は再試行しても同じ)。
pub async fn call_tool(
    state: &AppState,
    server: &str,
    tool: &str,
    arguments: Value,
) -> Result<ToolCallOutput, String> {
    let client = rpc_client(state).await?;

    for attempt in 0..2 {
        let tid = ensure_utility_thread(&client).await?;
        let params = json!({
            "server": server,
            "threadId": tid,
            "tool": tool,
            "arguments": arguments,
        });
        match client.request_raw("mcpServer/tool/call", params).await {
            Ok(result) => return Ok(parse_tool_result(result)),
            Err(e) => {
                // threadId が無効 (app-server 再起動等) の可能性があるときだけ、
                // スレッドを作り直して 1 回リトライする。2 回目も失敗なら諦める。
                invalidate_utility_thread().await;
                if attempt == 1 {
                    return Err(format!("{server} の {tool} 呼び出しに失敗しました: {e}"));
                }
            }
        }
    }
    unreachable!("loop returns on attempt == 1");
}

/// `mcpServerStatus/list` で特定 MCP サーバの状態 (登録 + 認証) を取る。
///
/// 返り値: Some((authenticated)) = 登録あり / None = 未登録。
/// authStatus の実値は "oAuth" (camelCase)。`codex mcp list --json` の "o_auth" とは
/// 表記が違うため、英数字以外を除去して小文字比較する (mcp_shared::is_mcp_oauth_authenticated
/// と同じ正規化思想)。
pub async fn server_auth_status(state: &AppState, server: &str) -> Result<Option<bool>, String> {
    let client = rpc_client(state).await?;
    let tid = ensure_utility_thread(&client).await?;
    // detail を絞るオプションはバージョン差があるため使わず、デフォルト (Full) で取る。
    let result = client
        .request_raw("mcpServerStatus/list", json!({ "threadId": tid }))
        .await
        .map_err(|e| format!("MCP サーバ状態の取得に失敗しました: {e}"))?;
    let Some(entries) = result.get("data").and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    for entry in entries {
        if entry.get("name").and_then(|v| v.as_str()) == Some(server) {
            let auth = entry
                .get("authStatus")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let normalized: String = auth
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_lowercase();
            return Ok(Some(normalized.contains("oauth")));
        }
    }
    Ok(None)
}

/// 稼働中 app-server に config.toml の MCP 設定を再読込させる。
///
/// `codex mcp add/login` (接続) や `codex mcp remove` (切断) は config.toml を書き換えるが、
/// 常駐 app-server は起動時にしか読まない。接続直後に「アプリ再起動なしで」直接呼び出しを
/// 効かせるために、login/logout 成功後にこれを呼ぶ。app-server 未起動でも致命ではない
/// (次回起動時に読まれる) ので、失敗は警告ログに留めて Ok を返す。
pub async fn reload_mcp_servers(state: &AppState) {
    let Some(client) = state.rpc().await else {
        return;
    };
    if let Err(e) = client
        .request_raw("config/mcpServer/reload", Value::Null)
        .await
    {
        tracing::warn!(target: "mcp_direct", "config/mcpServer/reload 失敗 (次回起動時に反映): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_result_collects_text_and_structured() {
        let out = parse_tool_result(json!({
            "content": [
                {"type": "text", "text": "line1"},
                {"type": "resource_link", "uri": "https://example.com/a.png"},
                {"type": "text", "text": "line2"}
            ],
            "structuredContent": {"credits": 445.77},
            "isError": false
        }));
        assert_eq!(out.text, "line1\nline2");
        assert!(!out.is_error);
        assert_eq!(
            out.structured.unwrap().get("credits").unwrap().as_f64(),
            Some(445.77)
        );
    }

    #[test]
    fn parse_tool_result_handles_error_without_structured() {
        let out = parse_tool_result(json!({
            "content": [{"type": "text", "text": "MCP error -32602: bad args"}],
            "isError": true
        }));
        assert!(out.is_error);
        assert!(out.structured.is_none());
        assert!(out.text.contains("-32602"));
    }

    #[test]
    fn extract_thread_id_supports_both_shapes() {
        assert_eq!(
            extract_thread_id(&json!({"threadId": "abc"})).as_deref(),
            Some("abc")
        );
        assert_eq!(
            extract_thread_id(&json!({"thread": {"id": "xyz"}})).as_deref(),
            Some("xyz")
        );
        assert!(extract_thread_id(&json!({})).is_none());
    }
}
