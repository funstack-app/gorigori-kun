use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::{RpcClient, ServerRequest};

pub const EVENT_SERVER_REQUEST: &str = "codex://server-request";

/// Forward server-initiated requests to the frontend so it can show approval
/// dialogs / user-input prompts. The frontend responds via the
/// `codex_resolve_server_request` Tauri command.
pub async fn run_server_request_loop(
    app: AppHandle,
    client: RpcClient,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<ServerRequest>,
) {
    while let Some(req) = rx.recv().await {
        tracing::debug!(target: "codex.rpc", "server request: {} {:?}", req.method, req.id);
        let payload = json!({
            "id": req.id,
            "method": req.method,
            "params": req.params,
        });
        if let Err(err) = app.emit(EVENT_SERVER_REQUEST, payload) {
            tracing::error!(target: "codex.rpc", "failed to emit server-request: {err}");
            // auto-decline so the server doesn't hang
            let _ = client.respond_error(req.id, -32000, "client emit failed");
        }
    }
}
