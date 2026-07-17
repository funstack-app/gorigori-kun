pub mod auth;
pub mod batch_gen;
pub mod cloud_supabase;
pub mod codex_text;
pub mod codex_vision;
pub mod edit_export;
pub mod edit_fonts;
pub mod edit_grab;
pub mod edit_inpaint;
pub mod edit_magic;
pub mod edit_models;
pub mod edit_ocr;
pub mod edit_sam2;
pub mod edit_words;
pub mod edit_segment;
pub mod gen_queue;
pub mod higgsfield_mcp;
pub mod images;
pub mod layer_splitter;
pub mod magnific;
pub mod mcp;
pub mod multiangle;
pub mod rpc_bridge;
pub mod secrets;
pub mod segment;
pub mod sessions;
pub mod skills;
pub mod stock;
pub mod storage;
pub mod storage_cleanup;
pub mod scene3d;
pub mod storyboard;
pub mod translate;

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::codex::process::{resolve_codex_binary, spawn_app_server, StderrBuffer};
use crate::codex::rpc::{handshake, RpcClient};
use crate::codex::server_requests::run_server_request_loop;
use crate::codex::RpcNotification;
use crate::events::{EVENT_APP_SERVER_STATUS, EVENT_NOTIFICATION};
use crate::state::AppState;

/// app-server が落ちた / handshake に失敗した時に、ユーザーが切り分けに使える
/// 情報をまとめて返す。stderr の直近 200 行も付ける。
fn format_exit_error(bin: &Path, reason: &str, stderr: &StderrBuffer) -> String {
    let lines = stderr.snapshot();
    let stderr_block = if lines.is_empty() {
        "(stderr 出力なし)".to_string()
    } else {
        lines.join("\n")
    };
    format!(
        "codex app-server が落ちました\n\
         理由: {reason}\n\
         バイナリ: {}\n\
         OS: {} / {}\n\
         --- codex app-server stderr ---\n{stderr_block}",
        bin.display(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

#[derive(Serialize, Clone)]
struct StatusPayload {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
pub async fn codex_start(
    app: AppHandle,
    state: State<'_, AppState>,
    binary_override: Option<String>,
) -> Result<serde_json::Value, String> {
    if state.rpc().await.is_some() {
        return Err("app-server already running".into());
    }

    let _ = app.emit(
        EVENT_APP_SERVER_STATUS,
        StatusPayload {
            state: "starting",
            error: None,
        },
    );

    let bin = resolve_codex_binary(binary_override.as_deref().map(std::path::Path::new))
        .map_err(|e| format!("{e:#}"))?;
    tracing::info!(target: "codex", "spawning {}", bin.display());

    let proc = spawn_app_server(&bin)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let stderr_buf = proc.stderr_buf.clone();
    let handle = RpcClient::start(proc.stdin, proc.stdout);
    let client = handle.client.clone();

    // Keep the child handle so we can wait for exit and surface it.
    state.set_child(proc.child).await;

    // Watch the child for exit; emit `exited` and clear RPC state.
    {
        let app_for_wait = app.clone();
        let state_for_wait = state.inner_clone();
        let stderr_for_wait = stderr_buf.clone();
        let bin_for_wait = bin.clone();
        tokio::spawn(async move {
            if let Some(mut child) = state_for_wait.take_child().await {
                let exit = child.wait().await;
                state_for_wait.clear_rpc().await;
                let err = match exit {
                    Ok(status) if status.success() => None,
                    Ok(status) => Some(format_exit_error(
                        &bin_for_wait,
                        &format!("{status}"),
                        &stderr_for_wait,
                    )),
                    Err(err) => Some(format_exit_error(
                        &bin_for_wait,
                        &format!("wait failed: {err}"),
                        &stderr_for_wait,
                    )),
                };
                let _ = app_for_wait.emit(
                    EVENT_APP_SERVER_STATUS,
                    StatusPayload {
                        state: "exited",
                        error: err,
                    },
                );
            }
        });
    }

    // server-request loop
    {
        let app_for_loop = app.clone();
        let client_for_loop = client.clone();
        let mut guard = handle.server_req_rx.lock().await;
        if let Some(rx) = guard.take() {
            tokio::spawn(async move {
                run_server_request_loop(app_for_loop, client_for_loop, rx).await;
            });
        }
    }

    // notification → frontend bridge
    {
        let app_for_notif = app.clone();
        let mut rx = client.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(RpcNotification { method, params }) => {
                        let _ = app_for_notif.emit(
                            EVENT_NOTIFICATION,
                            serde_json::json!({ "method": method, "params": params }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(target: "codex.rpc", "notification stream lagged: {n}");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    let result = match handshake(&client).await {
        Ok(v) => v,
        Err(e) => {
            // handshake 失敗時は、stderr buffer に少しでも溜まるよう猶予を与えてから出力する
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            return Err(format_exit_error(
                &bin,
                &format!("handshake に失敗: {e:#}"),
                &stderr_buf,
            ));
        }
    };
    state.set_rpc(client).await;

    let _ = app.emit(
        EVENT_APP_SERVER_STATUS,
        StatusPayload {
            state: "ready",
            error: None,
        },
    );

    Ok(result)
}

#[tauri::command]
pub async fn codex_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    client
        .request_raw(&method, params.unwrap_or(serde_json::Value::Null))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_resolve_server_request(
    state: State<'_, AppState>,
    id: serde_json::Value,
    result: Option<serde_json::Value>,
    error: Option<rpc_bridge::ErrorPayload>,
) -> Result<(), String> {
    let client = state
        .rpc()
        .await
        .ok_or_else(|| "app-server not started".to_string())?;
    if result.is_some() && error.is_some() {
        return Err("specify either `result` or `error`, not both".into());
    }
    if let Some(err) = error {
        client
            .respond_error(id, err.code, &err.message)
            .map_err(|e| e.to_string())
    } else {
        client
            .respond(id, result.unwrap_or(serde_json::Value::Null))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn codex_status(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.rpc().await.map(|c| c.is_alive()).unwrap_or(false))
}

/// 起動失敗時の診断情報。フロントのエラー画面に表示し、コピー&ペーストで開発者に送ってもらう用。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub resolved_codex_path: Option<String>,
    pub codex_path_exists: bool,
    pub current_exe: Option<String>,
    pub log_dir: Option<String>,
}

#[tauri::command]
pub async fn codex_diagnostics(binary_override: Option<String>) -> Result<Diagnostics, String> {
    let resolved = resolve_codex_binary(binary_override.as_deref().map(std::path::Path::new));
    let (path_str, path_exists) = match &resolved {
        Ok(p) => (Some(p.display().to_string()), p.is_file()),
        Err(_) => (None, false),
    };
    Ok(Diagnostics {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        resolved_codex_path: path_str,
        codex_path_exists: path_exists,
        current_exe: std::env::current_exe()
            .ok()
            .map(|p| p.display().to_string()),
        log_dir: crate::log_dir().map(|p| p.display().to_string()),
    })
}

/// Restart the codex app-server after a crash. Idempotent — if the server is
/// already alive this is a no-op. Returns the initialize result so the
/// frontend can re-derive any session info it cares about.
#[tauri::command]
pub async fn codex_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    binary_override: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(client) = state.rpc().await {
        if client.is_alive() {
            return Err("app-server already running".into());
        }
    }
    state.clear_rpc().await;
    codex_start(app, state, binary_override).await
}
