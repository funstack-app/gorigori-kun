//! 通常画像生成専用の常駐 Codex app-server。
//!
//! チャット用 app-server とはプロセスも RPC 購読も分離し、通知は Rust 内だけで
//! 消費する。初回生成時に遅延起動し、RPC/子プロセスの死活が失われていれば次回
//! 利用時に自動で起動し直す。

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tokio::process::Child;
use tokio::sync::broadcast;
use tokio::time::{interval, timeout, MissedTickBehavior};

use crate::codex::process::{resolve_codex_binary, spawn_app_server};
use crate::codex::rpc::{handshake, RpcClient, RpcNotification};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;
use crate::commands::worker_registry::WorkerPidGuard;
use crate::state::AppState;

pub(crate) const GENERATION_TIMEOUT: Duration = Duration::from_secs(900);
const GEN_SERVER_WORKER_KIND: &str = "batch-app-server";
const WORKER_REGISTRY_FILE: &str = "worker-pids.json";

/// AppState に 1 本だけ保持する生成専用プロセス。
pub(crate) struct GenServerProcess {
    client: RpcClient,
    child: Child,
    // 生存中は PID 台帳に残し、正常終了時は Drop で台帳から外す。
    _registration: WorkerPidGuard,
    /// このプロセスで開始した生成 turn 数。app-server には thread を閉じる
    /// API が無く、画像1枚ごとの thread がプロセス内に蓄積するため、
    /// 一定数でプロセスごと入れ替えてメモリ肥大を防ぐ(2026-07-17 レビュー指摘)。
    turns_started: u64,
}

/// このターン数を超えたら次の ensure_client でプロセスを入れ替える。
const MAX_TURNS_PER_SERVER: u64 = 60;

/// 1 turn で画像を生成し、app-server が通知した保存元パスを返す。
///
/// セマフォは thread/start やプロセス起動中には持たず、turn/start から
/// imageGeneration 完了までの間だけ保持する。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_image(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<PathBuf, String> {
    let client = ensure_client(app, state).await?;

    let mut thread_params = Map::new();
    thread_params.insert("approvalPolicy".into(), Value::String("never".into()));
    thread_params.insert("sandbox".into(), Value::String("workspace-write".into()));
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        thread_params.insert("cwd".into(), Value::String(cwd.to_string()));
    }

    let thread_result = client
        .request_raw("thread/start", Value::Object(thread_params))
        .await
        .map_err(|error| format!("生成用 thread/start に失敗: {error}"))?;
    let thread_id = extract_thread_id(&thread_result)
        .ok_or_else(|| "生成用 thread/start の応答から threadId を取得できません".to_string())?;

    // turn/start より先に購読し、開始直後の item 通知も取りこぼさない。
    let mut notifications = client.subscribe();
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    input.extend(
        image_paths
            .iter()
            .map(|path| json!({ "type": "localImage", "path": path })),
    );

    let mut turn_params = Map::new();
    turn_params.insert("threadId".into(), Value::String(thread_id.clone()));
    turn_params.insert("input".into(), Value::Array(input));
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        turn_params.insert("model".into(), Value::String(model.to_string()));
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        turn_params.insert("effort".into(), Value::String(effort.to_string()));
    }

    let _permit = GLOBAL_GEN_SEMAPHORE
        .acquire()
        .await
        .map_err(|_| "画像生成キューが閉じられました".to_string())?;
    let started_at = Instant::now();
    let turn_result = client
        .request_raw("turn/start", Value::Object(turn_params))
        .await
        .map_err(|error| format!("生成用 turn/start に失敗: {error}"))?;
    let turn_id = extract_turn_id(&turn_result)
        .ok_or_else(|| "生成用 turn/start の応答から turnId を取得できません".to_string())?;

    let remaining = GENERATION_TIMEOUT.saturating_sub(started_at.elapsed());
    match timeout(
        remaining,
        wait_for_saved_path(&client, &mut notifications, &thread_id, &turn_id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            // exec の kill_on_drop と同じく、タイムアウト後の生成を裏で残さない。
            best_effort_interrupt(&client, &thread_id, &turn_id).await;
            Err(format!(
                "画像生成がタイムアウトしました（{}秒）。プロンプトを短くするか、時間をおいて再試行してください。",
                GENERATION_TIMEOUT.as_secs()
            ))
        }
    }
}

/// 常駐経路のタイムアウト失敗か(この場合は旧経路へ切替せず試行失敗として返す。
/// 900秒の二重化で最悪1試行30分に伸びるのを防ぎ、旧実装と同じ上限を保つ)。
pub(crate) fn is_timeout_error(error: &str) -> bool {
    error.contains("画像生成がタイムアウトしました")
}

async fn wait_for_saved_path(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
) -> Result<PathBuf, String> {
    let mut health_tick = interval(Duration::from_millis(250));
    health_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            notification = notifications.recv() => {
                match notification {
                    Ok(notification) => {
                        if notification.method == "item/completed"
                            && notification_matches(&notification.params, thread_id, turn_id)
                        {
                            let item = notification.params.get("item").unwrap_or(&Value::Null);
                            if item.get("type").and_then(Value::as_str) == Some("imageGeneration") {
                                if let Some(saved_path) = item
                                    .get("savedPath")
                                    .and_then(Value::as_str)
                                    .filter(|path| !path.is_empty())
                                {
                                    let path = PathBuf::from(saved_path);
                                    // PNG の書き込みが通知より遅れることがある
                                    // (フロント側 MessageList にも同じレースの前例)。
                                    // 250ms x 4 まで待ってから諦める。
                                    for _ in 0..4 {
                                        if path.is_file() {
                                            return Ok(path);
                                        }
                                        tokio::time::sleep(Duration::from_millis(250)).await;
                                    }
                                    if path.is_file() {
                                        return Ok(path);
                                    }
                                    return Err(format!(
                                        "app-server が通知した生成画像が見つかりません: {}",
                                        path.display()
                                    ));
                                }
                            }
                        }

                        if notification.method == "turn/completed"
                            && turn_notification_matches(&notification.params, thread_id, turn_id)
                        {
                            return Err(turn_completed_without_image_error(&notification.params));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        best_effort_interrupt(client, thread_id, turn_id).await;
                        return Err(format!(
                            "生成用 app-server の通知が混雑し、{skipped}件を取りこぼしました"
                        ));
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("生成用 app-server の通知接続が閉じました".to_string());
                    }
                }
            }
            _ = health_tick.tick() => {
                if !client.is_alive() {
                    return Err("生成用 app-server が生成中に終了しました".to_string());
                }
            }
        }
    }
}

async fn best_effort_interrupt(client: &RpcClient, thread_id: &str, turn_id: &str) {
    let request = client.request_raw(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    );
    let _ = timeout(Duration::from_secs(5), request).await;
}

fn notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
}

fn turn_notification_matches(params: &Value, thread_id: &str, turn_id: &str) -> bool {
    params.get("threadId").and_then(Value::as_str) == Some(thread_id)
        && params
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            == Some(turn_id)
}

fn turn_completed_without_image_error(params: &Value) -> String {
    let turn = params.get("turn").unwrap_or(&Value::Null);
    let status = turn
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if let Some(message) = turn
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
    {
        return format!("生成用 turn が失敗しました: {message}");
    }
    format!("生成用 turn が画像を返さず終了しました (status={status})")
}

fn extract_thread_id(result: &Value) -> Option<String> {
    result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("threadId").and_then(Value::as_str))
        .map(str::to_string)
}

fn extract_turn_id(result: &Value) -> Option<String> {
    result
        .get("turn")
        .and_then(|turn| turn.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("turnId").and_then(Value::as_str))
        .map(str::to_string)
}

async fn ensure_client(app: &AppHandle, state: &AppState) -> Result<RpcClient, String> {
    let mut slot = state.gen_server.lock().await;
    if let Some(server) = slot.as_mut() {
        let child_alive = match server.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "生成用 app-server が終了していたため再起動します: {status}"
                );
                false
            }
            Err(error) => {
                tracing::warn!(
                    target: "codex.gen_server",
                    "生成用 app-server の死活確認に失敗したため再起動します: {error}"
                );
                false
            }
        };
        if child_alive && server.client.is_alive() {
            if server.turns_started >= MAX_TURNS_PER_SERVER {
                tracing::info!(
                    target: "codex.gen_server",
                    "生成 turn が {MAX_TURNS_PER_SERVER} 回に達したため app-server を入れ替えます(thread蓄積対策)"
                );
            } else {
                server.turns_started += 1;
                return Ok(server.client.clone());
            }
        }
    }

    if let Some(server) = slot.take() {
        stop_server(server).await;
    }

    let mut server = spawn_server(app).await?;
    server.turns_started = 1;
    let client = server.client.clone();
    *slot = Some(server);
    Ok(client)
}

async fn spawn_server(app: &AppHandle) -> Result<GenServerProcess, String> {
    let bin = resolve_codex_binary(None)
        .map_err(|error| format!("生成用 Codex app-server の解決に失敗: {error:#}"))?;
    let proc = spawn_app_server(&bin)
        .await
        .map_err(|error| format!("生成用 Codex app-server の起動に失敗: {error:#}"))?;
    let crate::codex::process::AppServerProcess {
        mut child,
        stdin,
        stdout,
        stderr_buf,
    } = proc;

    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = child.kill().await;
            return Err("生成用 Codex app-server の PID を取得できません".to_string());
        }
    };
    let registration = match WorkerPidGuard::register(app, pid, GEN_SERVER_WORKER_KIND) {
        Ok(registration) => registration,
        Err(error) => {
            let _ = child.kill().await;
            return Err(format!("生成用 app-server の PID 台帳登録に失敗: {error}"));
        }
    };

    let handle = RpcClient::start(stdin, stdout);
    let client = handle.client.clone();

    // 生成専用プロセスの server request は UI に流さず、内部で明示的に拒否する。
    // approvalPolicy=never のため通常は来ないが、未応答で turn を止めない安全策。
    {
        let client_for_requests = client.clone();
        let mut guard = handle.server_req_rx.lock().await;
        if let Some(mut requests) = guard.take() {
            tokio::spawn(async move {
                while let Some(request) = requests.recv().await {
                    tracing::warn!(
                        target: "codex.gen_server",
                        method = %request.method,
                        "生成専用 app-server の server request を自動拒否しました"
                    );
                    let _ = client_for_requests.respond_error(
                        request.id,
                        -32000,
                        "generation worker does not accept interactive requests",
                    );
                }
            });
        }
    }

    if let Err(error) = handshake(&client).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stderr = stderr_buf.snapshot();
        let stderr_tail = stderr
            .last()
            .map(String::as_str)
            .unwrap_or("stderr 出力なし");
        let _ = child.kill().await;
        return Err(format!(
            "生成用 Codex app-server の初期化に失敗: {error:#} ({stderr_tail})"
        ));
    }

    tracing::info!(target: "codex.gen_server", pid, "生成用 app-server を起動しました");
    Ok(GenServerProcess {
        client,
        child,
        _registration: registration,
        turns_started: 0,
    })
}

async fn stop_server(mut server: GenServerProcess) {
    if let Err(error) = server.child.start_kill() {
        tracing::warn!(
            target: "codex.gen_server",
            "生成用 app-server の停止シグナル送信に失敗: {error}"
        );
    }
    if timeout(Duration::from_secs(5), server.child.wait())
        .await
        .is_err()
    {
        tracing::warn!(target: "codex.gen_server", "生成用 app-server の終了待機がタイムアウトしました");
    }
}

/// アプリ終了時に常駐 child を止め、PID 台帳の guard も破棄する。
pub(crate) async fn shutdown(state: &AppState) {
    let server = state.gen_server.lock().await.take();
    if let Some(server) = server {
        stop_server(server).await;
    }
}

#[derive(Deserialize)]
struct RegistryEntry {
    pid: u32,
    kind: String,
}

/// worker_registry の同じ PID 台帳にクラッシュ時だけ残る生成用 app-server を、
/// 汎用 worker 清掃が台帳を空にする前に停止する。
pub(crate) fn cleanup_stale_registered_servers(app: &AppHandle) {
    let path = match app.path().app_data_dir() {
        Ok(path) => path.join(WORKER_REGISTRY_FILE),
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳の場所を解決できません: {error}");
            return;
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳を読めません: {error}");
            return;
        }
    };
    let entries: Vec<RegistryEntry> = match serde_json::from_slice(&bytes) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(target: "codex.gen_server", "PID台帳を解析できません: {error}");
            return;
        }
    };

    for entry in entries
        .into_iter()
        .filter(|entry| entry.kind == GEN_SERVER_WORKER_KIND)
    {
        let Some(command_line) = command_line_for_pid(entry.pid) else {
            continue;
        };
        if !is_gen_server_command(&command_line) {
            tracing::warn!(
                target: "codex.gen_server",
                pid = entry.pid,
                "PID台帳と app-server のコマンドが一致しないため kill を見送りました"
            );
            continue;
        }
        if send_terminate(entry.pid) {
            tracing::info!(
                target: "codex.gen_server",
                pid = entry.pid,
                "前回クラッシュ時に残った生成用 app-server を停止しました"
            );
        }
    }
}

fn is_gen_server_command(command_line: &str) -> bool {
    let normalized = command_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    normalized.contains("codex-app-server")
        || (normalized.contains("codex") && normalized.contains(" app-server"))
}

#[cfg(unix)]
fn command_line_for_pid(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command_line = String::from_utf8(output.stdout).ok()?;
    let command_line = command_line.trim().to_string();
    (!command_line.is_empty()).then_some(command_line)
}

#[cfg(not(unix))]
fn command_line_for_pid(_pid: u32) -> Option<String> {
    // 既存 worker_registry と同じく、PID 再利用を安全に検証できない環境では kill しない。
    None
}

#[cfg(unix)]
fn send_terminate(pid: u32) -> bool {
    Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn send_terminate(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{extract_thread_id, extract_turn_id, is_gen_server_command};
    use serde_json::json;

    #[test]
    fn extracts_v2_ids() {
        assert_eq!(
            extract_thread_id(&json!({ "thread": { "id": "thread-1" } })).as_deref(),
            Some("thread-1")
        );
        assert_eq!(
            extract_turn_id(&json!({ "turn": { "id": "turn-1" } })).as_deref(),
            Some("turn-1")
        );
    }

    #[test]
    fn recognizes_cli_and_native_app_server_commands() {
        assert!(is_gen_server_command("/usr/local/bin/codex app-server"));
        assert!(is_gen_server_command("/Applications/GORI/codex-app-server"));
        assert!(!is_gen_server_command("/usr/local/bin/codex exec -"));
    }
}
