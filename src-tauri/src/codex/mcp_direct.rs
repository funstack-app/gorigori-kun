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
    state.rpc().await.ok_or_else(|| {
        "GORI のコアエンジン (app-server) が起動していません。アプリを再起動してください。"
            .to_string()
    })
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
    let structured = result
        .get("structuredContent")
        .cloned()
        .filter(|v| !v.is_null());
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

                // 「そんな MCP サーバーは無い」と言われた場合は、**設定も読み直してから**
                // 再試行する (2026-07-26 STΛCK 報告)。
                //
                // なぜ: app-server は起動時にしか config.toml を読まない。アプリを立ち上げた
                // 後に接続した場合も、逆に接続済みの状態でアプリを起動した場合も、
                // 常駐サーバーの側が古い顔ぶれを持ったままになることがある。実際に
                // higgsfield が登録済み・OAuth 認証済みなのに
                //   `rpc error -32603: unknown MCP server 'higgsfield'`
                // で動画生成が落ちた。ユーザーには「接続済みなのに使えない」としか
                // 見えず、再接続もアプリ再起動も効かない詰みになる。
                //
                // スレッド破棄だけでは足りない (新しいスレッドを作っても、サーバー側の
                // 一覧が古ければ同じ結果になる) ので、設定の読み直しと対で行う。
                let msg = e.to_string();
                let unknown_server =
                    msg.contains("unknown MCP server") || msg.contains("unknown mcp server");
                if unknown_server && attempt == 0 {
                    tracing::warn!(
                        target: "mcp_direct",
                        "{server} が見つからないと言われました。MCP 設定を読み直して再試行します"
                    );
                    if let Err(reload_err) = client
                        .request_raw("config/mcpServer/reload", Value::Null)
                        .await
                    {
                        tracing::warn!(
                            target: "mcp_direct",
                            "設定の読み直しに失敗 (再試行は続行): {reload_err}"
                        );
                    }
                }

                if attempt == 1 {
                    // 最後まで見つからなかった場合は、次の行動が分かる言い方にする。
                    // 生の rpc error だけだと非エンジニアには何をすべきか分からない。
                    if unknown_server {
                        return Err(format!(
                            "{server} に接続できませんでした。設定画面で {server} の接続を確認してください \
                             (接続済みの場合は、一度切断してから接続し直すと直ることがあります)。詳細: {e}"
                        ));
                    }
                    return Err(format!("{server} の {tool} 呼び出しに失敗しました: {e}"));
                }
            }
        }
    }
    unreachable!("loop returns on attempt == 1");
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

    // 設定を読み直したら、**使い回しているスレッドも捨てる** (2026-07-26 STΛCK 報告)。
    //
    // ## なぜこれが要るか
    //
    // UTILITY_THREAD は一度作ったら以後ずっと使い回す。ところがスレッドは
    // **作られた時点の MCP サーバー一覧を持つ**ため、後から config.toml に
    // higgsfield を足して reload しても、既存スレッドから見える顔ぶれは古いまま。
    // 結果、接続は成功しているのに実行だけが
    //   `rpc error -32603: unknown MCP server 'higgsfield'`
    // で落ちる。ユーザーからは「接続済みなのに使えない」に見え、
    // 再接続もアプリ再起動も効かない (再起動時は起動→接続の順なので同じ状態に戻る)。
    //
    // reload と対で捨てておけば、次の call_tool が新しい設定でスレッドを作り直す。
    // 捨てるコストはスレッド1本の作り直しだけで、生成中の処理には影響しない。
    invalidate_utility_thread().await;
    tracing::info!(
        target: "mcp_direct",
        "MCP 設定を読み直し、キャッシュ済みスレッドを破棄しました (次回呼び出しで新しい設定が効きます)"
    );
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
