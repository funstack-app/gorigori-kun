pub mod gen_server;
pub mod home;
pub mod mcp_direct;
pub mod mcp_shared;
pub mod process;
pub mod rpc;
pub mod server_requests;
pub mod types;

pub use rpc::{RpcClient, RpcError, RpcNotification, ServerRequest};

/// 撤去済みの MCP 認可専用バイナリ (codex-auth) のキャッシュを掃除する。
///
/// ## なぜ要るか (2026-08-15)
///
/// 2026-08-06〜2026-08-15 の間、Magnific / Higgsfield を接続したユーザーの
/// data_dir には認可専用バイナリが **200〜290MB** でキャッシュされていた。
/// 0.147.0 一本化でその仕組みごと撤去したため、掃除しないと死蔵し続ける。
///
/// 付帯処理なので **失敗しても起動を止めない**。消せない (権限・使用中) 場合は
/// debug ログだけ残して黙って続行する。
pub fn cleanup_legacy_mcp_auth_cache() {
    let Some(data) = dirs::data_dir() else {
        return;
    };
    let base = data.join(crate::secrets::SERVICE_NAME);
    let stem = if cfg!(windows) {
        "codex-auth.exe"
    } else {
        "codex-auth"
    };
    for name in [stem, "codex-auth.download-tmp"] {
        let path = base.join(name);
        if !path.is_file() {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => tracing::info!(
                target: "codex.cleanup",
                path = %path.display(),
                "撤去済みの接続コンポーネントのキャッシュを削除しました"
            ),
            Err(e) => tracing::debug!(
                target: "codex.cleanup",
                path = %path.display(),
                error = %e,
                "撤去済みキャッシュを削除できませんでした (続行)"
            ),
        }
    }
}
