//! 通常画像生成専用の常駐 Codex app-server。
//!
//! チャット用 app-server とはプロセスも RPC 購読も分離し、通知は Rust 内だけで
//! 消費する。初回生成時に遅延起動し、RPC/子プロセスの死活が失われていれば次回
//! 利用時に自動で起動し直す。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{broadcast, watch, OwnedSemaphorePermit};
use tokio::time::{interval, timeout, MissedTickBehavior};

use crate::codex::process::{
    enriched_path, no_window_flag, resolve_codex_binary, AppServerProcess, StderrBuffer,
};
use crate::codex::rpc::{handshake, RpcClient, RpcNotification};
use crate::commands::gen_queue::GLOBAL_GEN_SEMAPHORE;
use crate::commands::worker_registry::WorkerPidGuard;
use crate::state::AppState;

pub(crate) const GENERATION_TIMEOUT: Duration = Duration::from_secs(900);
const GEN_SERVER_WORKER_KIND: &str = "batch-app-server";
const WORKER_REGISTRY_FILE: &str = "worker-pids.json";
// ディレクトリ名の正本は codex::home 側に置く (storage_cleanup の掃除対象列挙と
// 同じ値を2箇所に持たせないため。2026-07-25: この値が掃除から漏れて 2.5GB 溜まった)
#[cfg(unix)]
use crate::codex::home::GEN_CODEX_HOME_LEAF as GEN_CODEX_HOME_DIR;
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// 実行中の turn 数。プロセス交代は 0 のときだけ行う。
    active_turns: Arc<AtomicU64>,
    /// interrupt の完了を確認できず、次のアイドル時交代が必要な状態。
    poisoned: Arc<AtomicBool>,
    /// stop_server が子プロセスの終了を実際に確認したときだけ true になる。
    process_stopped: watch::Sender<bool>,
}

struct GenServerLease {
    client: RpcClient,
    poisoned: Arc<AtomicBool>,
    process_stopped: watch::Receiver<bool>,
    _active_turn: ActiveTurnGuard,
}

struct WaitForSavedPathError {
    message: String,
    hold_permit: bool,
}

impl WaitForSavedPathError {
    fn release(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hold_permit: false,
        }
    }

    fn hold(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            hold_permit: true,
        }
    }
}

/// generate_image がどの終了経路を通っても実行中数を戻すガード。
struct ActiveTurnGuard {
    active_turns: Arc<AtomicU64>,
}

impl Drop for ActiveTurnGuard {
    fn drop(&mut self) {
        let previous = self.active_turns.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "active turn counter underflow");
    }
}

/// このターン数を超えたら次の ensure_client でプロセスを入れ替える。
const MAX_TURNS_PER_SERVER: u64 = 60;

/// 1 turn で画像を生成し、app-server が通知した保存元パスを返す。
///
/// セマフォは thread/start やプロセス起動中には持たず、turn/start から
/// imageGeneration 完了までの間だけ保持する。
#[allow(clippy::too_many_arguments)]
#[cfg(windows)]
pub(crate) async fn generate_image(
    _app: &AppHandle,
    _state: &AppState,
    _prompt: &str,
    _image_paths: &[String],
    _cwd: Option<&str>,
    _model: Option<&str>,
    _effort: Option<&str>,
) -> Result<PathBuf, String> {
    Err("resident path disabled on windows".to_string())
}

#[allow(clippy::too_many_arguments)]
#[cfg(not(windows))]
pub(crate) async fn generate_image(
    app: &AppHandle,
    state: &AppState,
    prompt: &str,
    image_paths: &[String],
    cwd: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<PathBuf, String> {
    let server = ensure_client(app, state).await?;
    let client = &server.client;

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

    let permit = Arc::clone(&*GLOBAL_GEN_SEMAPHORE)
        .acquire_owned()
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
        wait_for_saved_path(
            client,
            &mut notifications,
            &thread_id,
            &turn_id,
            &server.poisoned,
        ),
    )
    .await
    {
        Ok(Ok(path)) => Ok(path),
        Ok(Err(error)) => {
            if error.hold_permit {
                spawn_permit_watchdog(
                    permit,
                    notifications,
                    thread_id,
                    turn_id,
                    server.process_stopped.clone(),
                );
            }
            Err(error.message)
        }
        Err(_) => {
            // interrupt の RPC 成功と turn/completed の両方を確認する。
            // 確認できなければ番犬へ permit を渡し、ゾンビ生成が生死不明の間も
            // 全体同時実行数の 1 枠として数え続ける。
            let interruption_confirmed = interrupt_or_poison(
                client,
                &mut notifications,
                &thread_id,
                &turn_id,
                &server.poisoned,
            )
            .await;
            if !interruption_confirmed {
                spawn_permit_watchdog(
                    permit,
                    notifications,
                    thread_id,
                    turn_id,
                    server.process_stopped.clone(),
                );
            }
            Err(format!(
                "画像生成がタイムアウトしました（{}秒）。プロンプトを短くするか、時間をおいて再試行してください。",
                GENERATION_TIMEOUT.as_secs()
            ))
        }
    }
}

/// 常駐経路のタイムアウト失敗か。呼び出し側は同じ試行内で二重化せず、
/// 次の試行だけ旧 exec 経路へ切り替える。
pub(crate) fn is_timeout_error(error: &str) -> bool {
    error.contains("画像生成がタイムアウトしました")
}

async fn wait_for_saved_path(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
    poisoned: &AtomicBool,
) -> Result<PathBuf, WaitForSavedPathError> {
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
                                    return Err(WaitForSavedPathError::release(format!(
                                        "app-server が通知した生成画像が見つかりません: {}",
                                        path.display()
                                    )));
                                }
                            }
                        }

                        if notification.method == "turn/completed"
                            && turn_notification_matches(&notification.params, thread_id, turn_id)
                        {
                            return Err(WaitForSavedPathError::release(
                                turn_completed_without_image_error(&notification.params),
                            ));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // 通知相関を保証できないため、interrupt が確認できても
                        // このサーバー自体は次のアイドル時に入れ替える。
                        poisoned.store(true, Ordering::Release);
                        let interruption_confirmed =
                            interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                        let message = format!(
                            "生成用 app-server の通知が混雑し、{skipped}件を取りこぼしました"
                        );
                        return Err(if interruption_confirmed {
                            WaitForSavedPathError::release(message)
                        } else {
                            WaitForSavedPathError::hold(message)
                        });
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        poisoned.store(true, Ordering::Release);
                        let interruption_confirmed =
                            interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                        let message = "生成用 app-server の通知接続が閉じました";
                        return Err(if interruption_confirmed {
                            WaitForSavedPathError::release(message)
                        } else {
                            WaitForSavedPathError::hold(message)
                        });
                    }
                }
            }
            _ = health_tick.tick() => {
                if !client.is_alive() {
                    poisoned.store(true, Ordering::Release);
                    let interruption_confirmed =
                        interrupt_or_poison(client, notifications, thread_id, turn_id, poisoned).await;
                    let message = "生成用 app-server が生成中に終了しました";
                    return Err(if interruption_confirmed {
                        WaitForSavedPathError::release(message)
                    } else {
                        WaitForSavedPathError::hold(message)
                    });
                }
            }
        }
    }
}

async fn interrupt_or_poison(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
    poisoned: &AtomicBool,
) -> bool {
    match interrupt_and_confirm(client, notifications, thread_id, turn_id).await {
        Ok(()) => true,
        Err(error) => {
            poisoned.store(true, Ordering::Release);
            tracing::warn!(
                target: "codex.gen_server",
                "turn/interrupt 完了を確認できないため app-server を交代予約します: {error}"
            );
            false
        }
    }
}

fn spawn_permit_watchdog(
    permit: OwnedSemaphorePermit,
    notifications: broadcast::Receiver<RpcNotification>,
    thread_id: String,
    turn_id: String,
    process_stopped: watch::Receiver<bool>,
) {
    spawn_permit_watchdog_with_timeout(
        permit,
        notifications,
        thread_id,
        turn_id,
        process_stopped,
        GENERATION_TIMEOUT,
    );
}

fn spawn_permit_watchdog_with_timeout(
    permit: OwnedSemaphorePermit,
    mut notifications: broadcast::Receiver<RpcNotification>,
    thread_id: String,
    turn_id: String,
    mut process_stopped: watch::Receiver<bool>,
    max_hold: Duration,
) {
    tokio::spawn(async move {
        let _permit = permit;
        let deadline = tokio::time::sleep(max_hold);
        tokio::pin!(deadline);
        let mut notifications_open = true;
        let mut process_watch_open = true;

        let release_reason = loop {
            if *process_stopped.borrow() {
                break "poisoned server process stopped";
            }

            tokio::select! {
                _ = &mut deadline => {
                    break "watchdog maximum hold elapsed";
                }
                notification = notifications.recv(), if notifications_open => {
                    match notification {
                        Ok(notification)
                            if notification.method == "turn/completed"
                                && turn_notification_matches(
                                    &notification.params,
                                    &thread_id,
                                    &turn_id,
                                ) =>
                        {
                            break "turn/completed received";
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {
                            notifications_open = false;
                        }
                    }
                }
                changed = process_stopped.changed(), if process_watch_open => {
                    match changed {
                        Ok(()) if *process_stopped.borrow() => {
                            break "poisoned server process stopped";
                        }
                        Ok(()) => {}
                        Err(_) => {
                            process_watch_open = false;
                        }
                    }
                }
            }
        };

        tracing::info!(
            target: "codex.gen_server",
            thread_id,
            turn_id,
            release_reason,
            "生死不明 turn の番犬が画像生成 permit を解放します"
        );
    });
}

async fn interrupt_and_confirm(
    client: &RpcClient,
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let request = client.request_raw(
        "turn/interrupt",
        json!({ "threadId": thread_id, "turnId": turn_id }),
    );
    match timeout(INTERRUPT_TIMEOUT, request).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Err(format!("turn/interrupt 失敗: {error}")),
        Err(_) => return Err("turn/interrupt 応答待機がタイムアウト".to_string()),
    }

    match timeout(
        INTERRUPT_TIMEOUT,
        wait_for_turn_completed(notifications, thread_id, turn_id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("interrupt 後の turn/completed 待機がタイムアウト".to_string()),
    }
}

async fn wait_for_turn_completed(
    notifications: &mut broadcast::Receiver<RpcNotification>,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    loop {
        match notifications.recv().await {
            Ok(notification)
                if notification.method == "turn/completed"
                    && turn_notification_matches(&notification.params, thread_id, turn_id) =>
            {
                return Ok(());
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                return Err(format!(
                    "interrupt 完了通知を待つ間に {skipped}件を取りこぼしました"
                ));
            }
            Err(broadcast::error::RecvError::Closed) => {
                return Err("interrupt 完了通知を待つ前に接続が閉じました".to_string());
            }
        }
    }
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

fn should_replace_server(turns_started: u64, active_turns: u64, poisoned: bool) -> bool {
    active_turns == 0 && (turns_started >= MAX_TURNS_PER_SERVER || poisoned)
}

async fn ensure_client(app: &AppHandle, state: &AppState) -> Result<GenServerLease, String> {
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
            let active_turns = server.active_turns.load(Ordering::Acquire);
            let poisoned = server.poisoned.load(Ordering::Acquire);
            if should_replace_server(server.turns_started, active_turns, poisoned) {
                tracing::info!(
                    target: "codex.gen_server",
                    "生成用 app-server が交代条件に達したため、アイドル状態で入れ替えます (turns={}, poisoned={poisoned})",
                    server.turns_started
                );
            } else {
                server.turns_started += 1;
                server.active_turns.fetch_add(1, Ordering::AcqRel);
                return Ok(GenServerLease {
                    client: server.client.clone(),
                    poisoned: Arc::clone(&server.poisoned),
                    process_stopped: server.process_stopped.subscribe(),
                    _active_turn: ActiveTurnGuard {
                        active_turns: Arc::clone(&server.active_turns),
                    },
                });
            }
        }
    }

    if let Some(server) = slot.take() {
        stop_server(server).await;
    }

    let mut server = spawn_server(app).await?;
    server.turns_started = 1;
    server.active_turns.store(1, Ordering::Release);
    let lease = GenServerLease {
        client: server.client.clone(),
        poisoned: Arc::clone(&server.poisoned),
        process_stopped: server.process_stopped.subscribe(),
        _active_turn: ActiveTurnGuard {
            active_turns: Arc::clone(&server.active_turns),
        },
    };
    *slot = Some(server);
    Ok(lease)
}

#[cfg(unix)]
async fn spawn_server(app: &AppHandle) -> Result<GenServerProcess, String> {
    let source_home = crate::codex::home::resolve_command_codex_home()
        .ok_or_else(|| "生成用 CODEX_HOME のミラー元を解決できません".to_string())?;
    let generation_home = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("生成用 CODEX_HOME の場所を解決できません: {error}"))?
        .join(GEN_CODEX_HOME_DIR);
    crate::commands::batch_gen::mirror_resident_codex_home(&source_home, &generation_home)?;

    let bin = resolve_codex_binary(None)
        .map_err(|error| format!("生成用 Codex app-server の解決に失敗: {error:#}"))?;
    let proc = spawn_generation_app_server(&bin, &generation_home)
        .await
        .map_err(|error| format!("生成用 Codex app-server の起動に失敗: {error}"))?;
    let AppServerProcess {
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

    let handshake_error = match timeout(HANDSHAKE_TIMEOUT, handshake(&client)).await {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(format!("{error:#}")),
        Err(_) => Some(format!(
            "initialize handshake が{}秒でタイムアウト",
            HANDSHAKE_TIMEOUT.as_secs()
        )),
    };
    if let Some(error) = handshake_error {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stderr = stderr_buf.snapshot();
        let stderr_tail = stderr
            .last()
            .map(String::as_str)
            .unwrap_or("stderr 出力なし");
        if let Err(kill_error) = child.start_kill() {
            tracing::warn!(
                target: "codex.gen_server",
                "初期化失敗後の app-server 停止シグナル送信に失敗: {kill_error}"
            );
        }
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            tracing::warn!(
                target: "codex.gen_server",
                "初期化失敗後の app-server 終了待機がタイムアウトしました"
            );
        }
        return Err(format!(
            "生成用 Codex app-server の初期化に失敗: {error} ({stderr_tail})"
        ));
    }

    let (process_stopped, _) = watch::channel(false);
    tracing::info!(target: "codex.gen_server", pid, "生成用 app-server を起動しました");
    Ok(GenServerProcess {
        client,
        child,
        _registration: registration,
        turns_started: 0,
        active_turns: Arc::new(AtomicU64::new(0)),
        poisoned: Arc::new(AtomicBool::new(false)),
        process_stopped,
    })
}

#[cfg(not(unix))]
async fn spawn_server(_app: &AppHandle) -> Result<GenServerProcess, String> {
    Err("resident path disabled on windows".to_string())
}

#[cfg(unix)]
async fn spawn_generation_app_server(
    bin: &Path,
    generation_home: &Path,
) -> Result<AppServerProcess, String> {
    let bin_name = bin
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_native_app_server = bin_name.starts_with("codex-app-server");

    let mut cmd = TokioCommand::new(bin);
    if !is_native_app_server {
        cmd.arg("app-server");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", enriched_path())
        .env("CODEX_HOME", generation_home)
        .kill_on_drop(true);
    no_window_flag(&mut cmd);

    let mut child = cmd.spawn().map_err(|error| {
        format!(
            "{} の起動に失敗 (CODEX_HOME={}): {error}",
            bin.display(),
            generation_home.display()
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child stdin を取得できません".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout を取得できません".to_string())?;

    let stderr_buf = StderrBuffer::default();
    if let Some(stderr) = child.stderr.take() {
        let logger_buf = stderr_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "codex.stderr", "{}", line);
                logger_buf.push(line);
            }
        });
    }

    tracing::info!(
        target: "codex.home",
        path = %generation_home.display(),
        "生成専用 app-server CODEX_HOME"
    );
    Ok(AppServerProcess {
        child,
        stdin,
        stdout,
        stderr_buf,
    })
}

async fn stop_server(mut server: GenServerProcess) {
    if let Err(error) = server.child.start_kill() {
        tracing::warn!(
            target: "codex.gen_server",
            "生成用 app-server の停止シグナル送信に失敗: {error}"
        );
    }
    match timeout(Duration::from_secs(5), server.child.wait()).await {
        Ok(Ok(_)) => {
            let _ = server.process_stopped.send(true);
        }
        Ok(Err(error)) => {
            tracing::warn!(
                target: "codex.gen_server",
                "生成用 app-server の終了確認に失敗しました: {error}"
            );
        }
        Err(_) => {
            tracing::warn!(target: "codex.gen_server", "生成用 app-server の終了待機がタイムアウトしました");
        }
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
    use super::{
        extract_thread_id, extract_turn_id, is_gen_server_command, should_replace_server,
        spawn_permit_watchdog_with_timeout, MAX_TURNS_PER_SERVER,
    };
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{broadcast, watch, Semaphore};
    use tokio::time::timeout;

    use crate::codex::rpc::RpcNotification;

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

    #[test]
    fn replaces_expired_or_poisoned_server_only_when_idle() {
        assert!(should_replace_server(MAX_TURNS_PER_SERVER, 0, false));
        assert!(!should_replace_server(MAX_TURNS_PER_SERVER, 1, false));
        assert!(should_replace_server(1, 0, true));
        assert!(!should_replace_server(1, 1, true));
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_matching_turn_completed() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let (notification_tx, notifications) = broadcast::channel(4);
        let (_process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_secs(1),
        );

        notification_tx
            .send(RpcNotification {
                method: "turn/completed".to_string(),
                params: json!({ "threadId": "thread-1", "turn": { "id": "turn-1" } }),
            })
            .unwrap();

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_process_stop_confirmation() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let (_notification_tx, notifications) = broadcast::channel(4);
        let (process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_secs(1),
        );

        process_stopped_tx.send(true).unwrap();

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }

    #[tokio::test]
    async fn watchdog_releases_permit_after_maximum_hold() {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&semaphore).acquire_owned().await.unwrap();
        let (_notification_tx, notifications) = broadcast::channel(4);
        let (_process_stopped_tx, process_stopped) = watch::channel(false);
        spawn_permit_watchdog_with_timeout(
            permit,
            notifications,
            "thread-1".to_string(),
            "turn-1".to_string(),
            process_stopped,
            Duration::from_millis(20),
        );

        let reacquired = timeout(Duration::from_millis(250), semaphore.acquire()).await;
        assert!(reacquired.is_ok());
    }
}
