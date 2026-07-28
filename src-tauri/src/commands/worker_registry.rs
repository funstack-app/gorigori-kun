//! Tracks spawned `codex exec` workers so stale children can be stopped safely.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "worker-pids.json";
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
/// 1プロセスを複数runが共有するため、run単位キャンセルでは停止してはいけない。
pub const RESIDENT_GEN_SERVER_WORKER_KIND: &str = "batch-app-server";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WorkerPidEntry {
    pid: u32,
    spawned_at: i64,
    kind: String,
    /// 旧台帳には存在しないため、読み込み時は None として後方互換にする。
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReport {
    /// 実際に停止させた codex exec プロセス数 (常駐 app-server 経由の生成は
    /// interrupt で止まるためここには数えない。0 = 「プロセスは殺していない」であって
    /// 「何も起きなかった」ではない)。
    pub terminated: usize,
    /// run_id が実行中 run 台帳に存在したか。false = すでに終了しているか、
    /// まだ開始していないか、Rust が管理していない ID。
    pub found: bool,
}

/// RAII registration: every normal/failed return path removes the PID.
/// If the whole app crashes, Drop does not run and the entry remains for the
/// next startup cleanup.
pub struct WorkerPidGuard {
    app: AppHandle,
    pid: u32,
}

impl WorkerPidGuard {
    pub fn register(
        app: &AppHandle,
        pid: u32,
        kind: &str,
        run_id: Option<&str>,
    ) -> Result<Self, String> {
        let _lock = registry_lock();
        let path = registry_path(app)?;
        let mut entries = read_entries(&path);
        entries.retain(|entry| entry.pid != pid);
        entries.push(WorkerPidEntry {
            pid,
            spawned_at: now_ms(),
            kind: kind.to_string(),
            run_id: run_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        });
        write_entries(&path, &entries)?;
        Ok(Self {
            app: app.clone(),
            pid,
        })
    }
}

impl Drop for WorkerPidGuard {
    fn drop(&mut self) {
        if let Err(error) = unregister_worker(&self.app, self.pid) {
            tracing::warn!(
                target: "codex.worker_registry",
                pid = self.pid,
                "worker PID の台帳削除に失敗: {error}"
            );
        }
    }
}

/// On startup, only PIDs still recorded by this app are considered. A PID is
/// killed only when `ps` confirms its command line is a `codex exec` command.
pub fn cleanup_stale_workers(app: &AppHandle) {
    cleanup_registered_workers(app, "startup");
}

/// On ExitRequested/Exit, stop only workers currently present in our ledger.
pub fn terminate_registered_workers(app: &AppHandle) {
    cleanup_registered_workers(app, "exit");
}

/// 待機中の仕事へ印を付け、同じrunの1カット1プロセスだけを停止する。
/// 常駐 app-server は別runも共有するため、run_id が一致しても必ず除外する。
#[tauri::command]
pub fn cancel_generation(app: AppHandle, run_id: String) -> Result<CancelReport, String> {
    let run_id = run_id.trim();
    if !claim_cancellable_run(run_id) {
        return Ok(CancelReport {
            terminated: 0,
            found: false,
        });
    }

    let terminated = terminate_workers_for_run(&app, run_id)?;
    Ok(CancelReport {
        terminated,
        found: true,
    })
}

/// 「この run はキャンセルしてよいか」を判定し、してよいときだけキャンセル印を付ける。
///
/// AppHandle を必要としないので、cancel_generation の本体からこれを呼ぶ形にして
/// 単体テストが実際の判定コードをそのまま検査できるようにしてある
/// (テスト専用の写しを作ると、写しだけ直って本体が腐る)。
///
/// 知らない run には印を付けない。付けても消費者がいない上、
/// 「marked: true」という見せかけの成功が今回潰す嘘そのもの。
fn claim_cancellable_run(run_id: &str) -> bool {
    let run_id = run_id.trim();
    if run_id.is_empty() || !crate::commands::gen_queue::is_run_active(run_id) {
        return false;
    }
    crate::commands::gen_queue::mark_cancelled(run_id);
    true
}

fn terminate_workers_for_run(app: &AppHandle, run_id: &str) -> Result<usize, String> {
    let _lock = registry_lock();
    let path = registry_path(app)?;
    let entries = read_entries(&path);
    let mut terminated = 0;

    for entry in entries
        .iter()
        .filter(|entry| is_cancellable_entry(entry, run_id))
    {
        let Some(command_line) = command_line_for_pid(entry.pid) else {
            continue;
        };
        // PID再利用で無関係なプロセスを止めないため、既存の ps 確認を必ず通す。
        if !is_codex_exec_command(&command_line) {
            tracing::warn!(
                target: "codex.worker_registry",
                pid = entry.pid,
                kind = %entry.kind,
                run_id,
                "PID台帳とコマンドが一致しないため run キャンセルの kill を見送りました"
            );
            continue;
        }

        if send_terminate(entry.pid) {
            terminated += 1;
            tracing::info!(
                target: "codex.worker_registry",
                pid = entry.pid,
                kind = %entry.kind,
                run_id,
                "run に紐づく codex exec を停止しました"
            );
        }
    }

    Ok(terminated)
}

fn is_cancellable_entry(entry: &WorkerPidEntry, run_id: &str) -> bool {
    entry.run_id.as_deref() == Some(run_id)
        && entry.kind != RESIDENT_GEN_SERVER_WORKER_KIND
}

fn unregister_worker(app: &AppHandle, pid: u32) -> Result<(), String> {
    let _lock = registry_lock();
    let path = registry_path(app)?;
    let mut entries = read_entries(&path);
    entries.retain(|entry| entry.pid != pid);
    write_entries(&path, &entries)
}

fn cleanup_registered_workers(app: &AppHandle, phase: &str) {
    let _lock = registry_lock();
    let path = match registry_path(app) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(target: "codex.worker_registry", "PID台帳の場所を解決できません: {error}");
            return;
        }
    };
    let entries = read_entries(&path);

    for entry in &entries {
        let Some(command_line) = command_line_for_pid(entry.pid) else {
            // The PID is already gone, or this platform cannot verify it.
            // In both cases we deliberately do not send a signal.
            continue;
        };
        if !is_codex_exec_command(&command_line) {
            tracing::warn!(
                target: "codex.worker_registry",
                pid = entry.pid,
                kind = %entry.kind,
                "PID台帳とコマンドが一致しないため kill を見送りました"
            );
            continue;
        }

        if send_terminate(entry.pid) {
            tracing::info!(
                target: "codex.worker_registry",
                pid = entry.pid,
                kind = %entry.kind,
                phase,
                "台帳に残った codex exec を停止しました"
            );
        }
    }

    // Corrupt JSON is read as an empty ledger, and every cleanup rewrites a
    // valid array. This also prevents stale/reused PIDs from surviving forever.
    if let Err(error) = write_entries(&path, &[]) {
        tracing::warn!(target: "codex.worker_registry", "PID台帳のクリアに失敗: {error}");
    }
}

fn registry_lock() -> MutexGuard<'static, ()> {
    REGISTRY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(REGISTRY_FILE))
        .map_err(|error| format!("app_data_dir failed: {error}"))
}

fn read_entries(path: &Path) -> Vec<WorkerPidEntry> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(
                target: "codex.worker_registry",
                path = %path.display(),
                "PID台帳を読めないため空として扱います: {error}"
            );
            return Vec::new();
        }
    };

    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        tracing::warn!(
            target: "codex.worker_registry",
            path = %path.display(),
            "PID台帳が壊れているため作り直します: {error}"
        );
        Vec::new()
    })
}

fn write_entries(path: &Path, entries: &[WorkerPidEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("PID台帳ディレクトリ作成失敗: {error}"))?;
    }
    let json = serde_json::to_vec_pretty(entries)
        .map_err(|error| format!("PID台帳JSON作成失敗: {error}"))?;
    std::fs::write(path, json).map_err(|error| format!("PID台帳書き込み失敗: {error}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn is_codex_exec_command(command_line: &str) -> bool {
    let normalized = command_line
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    normalized.contains("codex exec")
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
    // Without a trustworthy `ps` equivalent we cannot rule out PID reuse, so
    // we intentionally skip killing on this platform.
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
        claim_cancellable_run, is_cancellable_entry, is_codex_exec_command, WorkerPidEntry,
        RESIDENT_GEN_SERVER_WORKER_KIND,
    };
    use crate::commands::gen_queue::{clear_cancelled, is_cancelled, ActiveRunGuard};

    /// 知らない run に「止めました」と言わない。印も付けない。
    #[test]
    fn cancel_unknown_run_reports_not_found() {
        let run_id = "worker-registry-unknown-run-test";
        clear_cancelled(run_id);

        assert!(!claim_cancellable_run(run_id));
        // 知らない run にキャンセル印を残すと、後から同じ ID で始まった生成が即死する。
        assert!(!is_cancelled(run_id));
    }

    /// 実行中 run 台帳にいる run は既知として扱い、キャンセル印を付ける。
    #[test]
    fn cancel_active_run_reports_found() {
        let run_id = "worker-registry-active-run-test";
        clear_cancelled(run_id);

        let guard = ActiveRunGuard::begin(run_id);
        assert!(claim_cancellable_run(run_id));
        assert!(is_cancelled(run_id));

        drop(guard);
        clear_cancelled(run_id);
    }

    fn entry(kind: &str, run_id: Option<&str>) -> WorkerPidEntry {
        WorkerPidEntry {
            pid: 1,
            spawned_at: 0,
            kind: kind.to_string(),
            run_id: run_id.map(str::to_string),
        }
    }

    #[test]
    fn run_cancel_never_targets_resident_server() {
        assert!(is_cancellable_entry(
            &entry("storyboard", Some("run-1")),
            "run-1"
        ));
        assert!(!is_cancellable_entry(
            &entry(RESIDENT_GEN_SERVER_WORKER_KIND, Some("run-1")),
            "run-1"
        ));
    }

    #[test]
    fn command_verification_accepts_exec_only() {
        assert!(is_codex_exec_command("/usr/local/bin/codex exec -"));
        assert!(!is_codex_exec_command(
            "/usr/local/bin/codex app-server"
        ));
    }
}
