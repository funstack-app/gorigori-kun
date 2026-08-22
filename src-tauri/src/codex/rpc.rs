use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::time::timeout;

use super::types::{default_client_info, ClientCapabilities, InitializeParams};

const NOTIFICATION_CHANNEL_CAPACITY: usize = 4096;
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// Methods whose request/response payloads may contain credentials.
/// Logged as `<redacted>` instead of the raw frame.
const SENSITIVE_METHOD_PREFIXES: &[&str] = &["account/login/start", "account/chatgptAuthTokens"];

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("rpc error {code}: {message}")]
    Remote {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("transport closed")]
    TransportClosed,
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("timeout waiting for response")]
    Timeout,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcNotification {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>>;

#[derive(Clone)]
pub struct RpcClient {
    next_id: Arc<AtomicI64>,
    out_tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    notif_tx: broadcast::Sender<RpcNotification>,
    transport_alive: Arc<AtomicBool>,
}

pub struct RpcHandle {
    pub client: RpcClient,
    pub server_req_rx: Mutex<Option<mpsc::UnboundedReceiver<ServerRequest>>>,
}

impl RpcClient {
    pub fn start(stdin: ChildStdin, stdout: ChildStdout) -> RpcHandle {
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (server_req_tx, server_req_rx) = mpsc::unbounded_channel::<ServerRequest>();
        let (notif_tx, _) = broadcast::channel::<RpcNotification>(NOTIFICATION_CHANNEL_CAPACITY);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let transport_alive = Arc::new(AtomicBool::new(true));

        // writer task
        let pending_for_writer = pending.clone();
        let alive_for_writer = transport_alive.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = out_rx.recv().await {
                if let Err(err) = stdin.write_all(line.as_bytes()).await {
                    tracing::error!(target: "codex.rpc", "write error: {err}");
                    break;
                }
                if !line.ends_with('\n') {
                    if let Err(err) = stdin.write_all(b"\n").await {
                        tracing::error!(target: "codex.rpc", "newline write error: {err}");
                        break;
                    }
                }
                if let Err(err) = stdin.flush().await {
                    tracing::error!(target: "codex.rpc", "flush error: {err}");
                    break;
                }
            }
            // mark transport dead and fail any in-flight requests
            alive_for_writer.store(false, Ordering::SeqCst);
            let mut map = pending_for_writer.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::TransportClosed));
            }
            tracing::warn!(target: "codex.rpc", "writer task exited");
        });

        // reader task
        let pending_reader = pending.clone();
        let notif_tx_reader = notif_tx.clone();
        let server_req_tx_reader = server_req_tx.clone();
        let alive_for_reader = transport_alive.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let value: Value = match serde_json::from_str(trimmed) {
                            Ok(v) => v,
                            Err(err) => {
                                tracing::warn!(target: "codex.rpc", "parse error: {err}");
                                continue;
                            }
                        };
                        dispatch_message(
                            value,
                            &pending_reader,
                            &notif_tx_reader,
                            &server_req_tx_reader,
                        )
                        .await;
                    }
                    Ok(None) => {
                        tracing::warn!(target: "codex.rpc", "stdout EOF");
                        break;
                    }
                    Err(err) => {
                        tracing::error!(target: "codex.rpc", "read error: {err}");
                        break;
                    }
                }
            }
            alive_for_reader.store(false, Ordering::SeqCst);
            let mut map = pending_reader.lock().await;
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::TransportClosed));
            }
        });

        let client = RpcClient {
            next_id: Arc::new(AtomicI64::new(1)),
            out_tx,
            pending,
            notif_tx,
            transport_alive,
        };

        RpcHandle {
            client,
            server_req_rx: Mutex::new(Some(server_req_rx)),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.transport_alive.load(Ordering::SeqCst)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RpcNotification> {
        self.notif_tx.subscribe()
    }

    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R, RpcError> {
        let value = self
            .request_raw(method, serde_json::to_value(params)?)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn request_raw(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.request_raw_with_timeout(method, params, Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .await
    }

    /// 応答待ち時間を呼び出し側で指定する JSON-RPC リクエスト。
    ///
    /// 通常の app-server 呼び出しは [`request_raw`](Self::request_raw) の 120 秒上限を
    /// 使う。画像・動画生成のように正規に長時間かかる処理だけ、この入口から明示的な
    /// 上限を渡す。
    pub async fn request_raw_with_timeout(
        &self,
        method: &str,
        params: Value,
        request_timeout: Duration,
    ) -> Result<Value, RpcError> {
        if !self.is_alive() {
            return Err(RpcError::TransportClosed);
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, tx);
        }

        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&frame)?;
        if !is_sensitive(method) {
            tracing::trace!(target: "codex.rpc", "→ {method} #{id}");
        } else {
            tracing::trace!(target: "codex.rpc", "→ {method} #{id} <redacted>");
        }

        if let Err(_) = self.out_tx.send(line) {
            // writer is dead; clean up the pending entry so we don't leak
            self.pending.lock().await.remove(&id);
            return Err(RpcError::TransportClosed);
        }

        match timeout(request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::TransportClosed),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::Timeout)
            }
        }
    }

    pub fn notify<P: Serialize>(&self, method: &str, params: P) -> Result<(), RpcError> {
        let frame = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": serde_json::to_value(params)?,
        });
        let line = serde_json::to_string(&frame)?;
        self.out_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)?;
        Ok(())
    }

    pub fn respond(&self, id: Value, result: Value) -> Result<(), RpcError> {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let line = serde_json::to_string(&frame)?;
        self.out_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)?;
        Ok(())
    }

    pub fn respond_error(&self, id: Value, code: i64, message: &str) -> Result<(), RpcError> {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        let line = serde_json::to_string(&frame)?;
        self.out_tx
            .send(line)
            .map_err(|_| RpcError::TransportClosed)?;
        Ok(())
    }
}

fn is_sensitive(method: &str) -> bool {
    SENSITIVE_METHOD_PREFIXES
        .iter()
        .any(|p| method.starts_with(p))
}

async fn dispatch_message(
    value: Value,
    pending: &Pending,
    notif_tx: &broadcast::Sender<RpcNotification>,
    server_req_tx: &mpsc::UnboundedSender<ServerRequest>,
) {
    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            tracing::warn!(target: "codex.rpc", "non-object frame");
            return;
        }
    };

    let has_id = obj.contains_key("id");
    let has_method = obj.contains_key("method");
    let has_result = obj.contains_key("result");
    let has_error = obj.contains_key("error");

    if has_id && (has_result || has_error) {
        let id_val = obj.get("id").cloned().unwrap_or(Value::Null);
        let id_num = match id_val.as_i64() {
            Some(n) => n,
            None => {
                tracing::warn!(target: "codex.rpc", "non-integer response id");
                return;
            }
        };

        let mut map = pending.lock().await;
        let Some(tx) = map.remove(&id_num) else {
            tracing::warn!(target: "codex.rpc", "no pending request for id={id_num}");
            return;
        };
        drop(map);

        if has_error {
            let err = obj.get("error").cloned().unwrap_or(Value::Null);
            let code = err.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
            let message = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error")
                .to_string();
            let data = err.get("data").cloned();
            let _ = tx.send(Err(RpcError::Remote {
                code,
                message,
                data,
            }));
        } else {
            let result = obj.get("result").cloned().unwrap_or(Value::Null);
            let _ = tx.send(Ok(result));
        }
        return;
    }

    if has_id && has_method {
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        let method = obj
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        if server_req_tx
            .send(ServerRequest { id, method, params })
            .is_err()
        {
            tracing::warn!(target: "codex.rpc", "server-request receiver dropped");
        }
        return;
    }

    if has_method {
        let method = obj
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let _ = notif_tx.send(RpcNotification { method, params });
        return;
    }

    tracing::warn!(target: "codex.rpc", "unrecognized frame");
}

/// Run the `initialize` handshake and the `initialized` notification.
pub async fn handshake(client: &RpcClient) -> Result<Value> {
    let params = InitializeParams {
        client_info: default_client_info(),
        capabilities: ClientCapabilities {
            experimental_api: Some(true),
        },
    };
    let result: Value = client
        .request("initialize", params)
        .await
        .context("initialize failed")?;
    client
        .notify("initialized", Map::<String, Value>::new())
        .map_err(|e| anyhow!(e.to_string()))?;
    Ok(result)
}
