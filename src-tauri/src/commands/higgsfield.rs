use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::process::Command as TokioCommand;
use tokio::task::{JoinHandle, JoinSet};

use crate::codex::process::enriched_path;
use crate::events::EVENT_IMAGE_BATCH;
use crate::state::{AppState, HiggsfieldCancellation};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldModel {
    #[serde(rename(serialize = "displayName", deserialize = "display_name"))]
    pub display_name: String,
    #[serde(rename(serialize = "jobSetType", deserialize = "job_set_type"))]
    pub job_set_type: String,
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HiggsfieldAccount {
    pub email: String,
    // Higgsfield CLI は credits を小数で返すことがある (例: 5139.25)。
    // i64 で受けると JSON パース失敗 → plan も取れずに UNLIMITED ピルが
    // 表示されない事故が起きた。f64 で受ける。
    pub credits: f64,
    #[serde(rename(
        serialize = "subscriptionPlanType",
        deserialize = "subscription_plan_type"
    ))]
    pub subscription_plan_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldBatchArgs {
    pub job_set_type: String,
    pub display_name: String,
    pub prompt: String,
    pub count: u32,
    pub aspect: Option<String>,
    pub ref_image_paths: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldCompareArgs {
    pub prompt: String,
    pub models: Vec<HiggsfieldCompareModel>,
    pub aspect: Option<String>,
    pub ref_image_paths: Option<Vec<String>>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiggsfieldCompareModel {
    pub job_set_type: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub batch_id: String,
    pub generated_paths: Vec<String>,
    pub failed_count: u32,
}

#[derive(Serialize, Clone)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum HiggsfieldBatchEvent {
    Started {
        batch_id: String,
        count: u32,
        provider: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    WorkerStarted {
        batch_id: String,
        idx: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    WorkerCompleted {
        batch_id: String,
        idx: u32,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    WorkerFailed {
        batch_id: String,
        idx: u32,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    Completed {
        batch_id: String,
        generated_paths: Vec<String>,
        failed_count: u32,
        provider: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_job_set_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_display_name: Option<String>,
    },
    Cancelled {
        batch_id: String,
    },
}

#[derive(Debug)]
struct CompareWorkerResult {
    idx: u32,
    path: Option<String>,
}

type PipeReadTask = JoinHandle<Result<Vec<u8>, std::io::Error>>;

#[tauri::command]
pub async fn higgsfield_status() -> Result<HiggsfieldStatus, String> {
    let Some(binary) = resolve_higgsfield_binary() else {
        return Ok(HiggsfieldStatus {
            installed: false,
            authenticated: false,
            binary_path: None,
            version: None,
        });
    };

    let authenticated = auth_status(&binary);
    let version = command_text(&binary, ["--version"]).ok();

    Ok(HiggsfieldStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary.to_string_lossy().into_owned()),
        version,
    })
}

#[tauri::command]
pub async fn higgsfield_login() -> Result<String, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    command_text(&binary, ["auth", "login"])
}

#[tauri::command]
pub async fn higgsfield_logout() -> Result<(), String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    command_text(&binary, ["auth", "logout"]).map(|_| ())
}

#[tauri::command]
pub async fn higgsfield_list_models(media: String) -> Result<Vec<HiggsfieldModel>, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let media_arg = match media.as_str() {
        "image" => "--image",
        "video" => "--video",
        _ => return Err("media は image または video を指定してください。".to_string()),
    };

    let output = Command::new(&binary)
        .args(["model", "list", media_arg, "--json"])
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("Higgsfield CLI が失敗しました: {}", output.status));
        }
        return Err(format!("Higgsfield CLI が失敗しました: {stderr}"));
    }

    serde_json::from_slice::<Vec<HiggsfieldModel>>(&output.stdout).map_err(|e| {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            format!("Higgsfield モデル一覧の JSON デコードに失敗しました: {e}")
        } else {
            format!("Higgsfield モデル一覧の JSON デコードに失敗しました: {e}; stdout: {stdout}")
        }
    })
}

#[tauri::command]
pub async fn higgsfield_account() -> Result<HiggsfieldAccount, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;

    // PATH に node/npm の bin を含めないと CLI 内部のサブプロセス起動が失敗する
    // 可能性がある (generate_batch 側でも同様の理由で enriched_path を使っている)。
    let output = Command::new(&binary)
        .args(["account", "status", "--json"])
        .env("PATH", enriched_path())
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    eprintln!(
        "[higgsfield_account] status={} stdout_len={} stderr_len={}",
        output.status,
        output.stdout.len(),
        output.stderr.len(),
    );

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        eprintln!("[higgsfield_account] stderr={stderr}");
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield account status が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!(
            "Higgsfield account status が失敗しました: {stderr}"
        ));
    }

    let result = serde_json::from_slice::<HiggsfieldAccount>(&output.stdout).map_err(|e| {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        eprintln!("[higgsfield_account] JSON decode failed: {e}; stdout={stdout}");
        if stdout.is_empty() {
            format!("Higgsfield アカウント情報の JSON デコードに失敗しました: {e}")
        } else {
            format!(
                "Higgsfield アカウント情報の JSON デコードに失敗しました: {e}; stdout: {stdout}"
            )
        }
    });
    if let Ok(ref acc) = result {
        eprintln!(
            "[higgsfield_account] OK plan={}",
            acc.subscription_plan_type
        );
    }
    result
}

#[tauri::command]
pub async fn higgsfield_generate_batch(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: HiggsfieldBatchArgs,
) -> Result<BatchSummary, String> {
    if args.count == 0 {
        return Err("count must be >= 1".into());
    }
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;
    let batch_id = format!("hf-{}", short_id());
    let out_dir = codex_home.join("generated_images").join(&batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力ディレクトリ作成失敗: {e}"))?;
    let cancellation = register_higgsfield_cancellation(&state, &batch_id).await;

    let model_job_set_type = args.job_set_type.clone();
    let model_display_name = args.display_name.clone();
    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        HiggsfieldBatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.count,
            provider: "higgsfield",
            model_job_set_type: Some(model_job_set_type.clone()),
            model_display_name: Some(model_display_name.clone()),
        },
    );

    let mut generated_paths = Vec::new();
    let mut failed_count = 0u32;
    let mut cancelled = false;
    for idx in 1..=args.count {
        if cancellation.flag.load(Ordering::SeqCst) {
            cancelled = true;
            failed_count += emit_cancelled_workers(
                &app,
                &batch_id,
                idx,
                args.count,
                Some(&model_job_set_type),
                Some(&model_display_name),
            );
            break;
        }
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::WorkerStarted {
                batch_id: batch_id.clone(),
                idx,
                model_job_set_type: Some(model_job_set_type.clone()),
                model_display_name: Some(model_display_name.clone()),
            },
        );
        eprintln!(
            "[higgsfield] worker idx={idx} batch={batch_id} model={} prompt_len={} refs={} aspect={:?}",
            args.job_set_type,
            args.prompt.len(),
            args.ref_image_paths.as_deref().map(|v| v.len()).unwrap_or(0),
            args.aspect,
        );
        let result = run_one_higgsfield_job(&binary, &out_dir, idx, &args, &cancellation).await;
        match result {
            Ok(path) => {
                eprintln!("[higgsfield] worker idx={idx} OK path={path}");
                generated_paths.push(path.clone());
                let _ = app.emit(
                    EVENT_IMAGE_BATCH,
                    HiggsfieldBatchEvent::WorkerCompleted {
                        batch_id: batch_id.clone(),
                        idx,
                        path,
                        model_job_set_type: Some(model_job_set_type.clone()),
                        model_display_name: Some(model_display_name.clone()),
                    },
                );
            }
            Err(error) => {
                eprintln!("[higgsfield] worker idx={idx} FAIL: {error}");
                failed_count += 1;
                let was_cancelled = is_cancelled_error(&error);
                let _ = app.emit(
                    EVENT_IMAGE_BATCH,
                    HiggsfieldBatchEvent::WorkerFailed {
                        batch_id: batch_id.clone(),
                        idx,
                        error: error.clone(),
                        model_job_set_type: Some(model_job_set_type.clone()),
                        model_display_name: Some(model_display_name.clone()),
                    },
                );
                if was_cancelled {
                    cancelled = true;
                    failed_count += emit_cancelled_workers(
                        &app,
                        &batch_id,
                        idx + 1,
                        args.count,
                        Some(&model_job_set_type),
                        Some(&model_display_name),
                    );
                    break;
                }
            }
        }
    }

    if cancelled {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Cancelled {
                batch_id: batch_id.clone(),
            },
        );
    } else {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Completed {
                batch_id: batch_id.clone(),
                generated_paths: generated_paths.clone(),
                failed_count,
                provider: "higgsfield",
                model_job_set_type: Some(model_job_set_type),
                model_display_name: Some(model_display_name),
            },
        );
    }
    unregister_higgsfield_cancellation(&state, &batch_id).await;

    Ok(BatchSummary {
        batch_id,
        generated_paths,
        failed_count,
    })
}

#[tauri::command]
pub async fn higgsfield_generate_compare(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: HiggsfieldCompareArgs,
) -> Result<BatchSummary, String> {
    if args.models.is_empty() {
        return Err("models must contain at least 1".into());
    }
    if args.models.len() > 4 {
        return Err("models must be 4 or fewer".into());
    }

    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or_else(|| "CODEX_HOME を解決できません".to_string())?;
    let batch_id = format!("hfc-{}", short_id());
    let out_dir = codex_home.join("generated_images").join(&batch_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力ディレクトリ作成失敗: {e}"))?;
    let cancellation = register_higgsfield_cancellation(&state, &batch_id).await;

    let _ = app.emit(
        EVENT_IMAGE_BATCH,
        HiggsfieldBatchEvent::Started {
            batch_id: batch_id.clone(),
            count: args.models.len() as u32,
            provider: "higgsfield",
            model_job_set_type: None,
            model_display_name: None,
        },
    );

    let mut jobs = JoinSet::new();
    for (zero_idx, model) in args.models.iter().cloned().enumerate() {
        let idx = zero_idx as u32 + 1;
        let app_for_worker = app.clone();
        let batch_id_for_worker = batch_id.clone();
        let binary_for_worker = binary.clone();
        let out_dir_for_worker = out_dir.clone();
        let cancellation_for_worker = cancellation.clone();
        let single_args = HiggsfieldBatchArgs {
            job_set_type: model.job_set_type.clone(),
            display_name: model.display_name.clone(),
            prompt: args.prompt.clone(),
            count: 1,
            aspect: args.aspect.clone(),
            ref_image_paths: args.ref_image_paths.clone(),
            cwd: args.cwd.clone(),
        };

        jobs.spawn(async move {
            let _ = app_for_worker.emit(
                EVENT_IMAGE_BATCH,
                HiggsfieldBatchEvent::WorkerStarted {
                    batch_id: batch_id_for_worker.clone(),
                    idx,
                    model_job_set_type: Some(model.job_set_type.clone()),
                    model_display_name: Some(model.display_name.clone()),
                },
            );
            eprintln!(
                "[higgsfield] compare worker idx={idx} batch={batch_id_for_worker} model={} prompt_len={} refs={} aspect={:?}",
                single_args.job_set_type,
                single_args.prompt.len(),
                single_args
                    .ref_image_paths
                    .as_deref()
                    .map(|v| v.len())
                    .unwrap_or(0),
                single_args.aspect,
            );
            match run_one_higgsfield_job(
                &binary_for_worker,
                &out_dir_for_worker,
                idx,
                &single_args,
                &cancellation_for_worker,
            )
            .await
            {
                Ok(path) => {
                    eprintln!("[higgsfield] compare worker idx={idx} OK path={path}");
                    let _ = app_for_worker.emit(
                        EVENT_IMAGE_BATCH,
                        HiggsfieldBatchEvent::WorkerCompleted {
                            batch_id: batch_id_for_worker,
                            idx,
                            path: path.clone(),
                            model_job_set_type: Some(model.job_set_type),
                            model_display_name: Some(model.display_name),
                        },
                    );
                    CompareWorkerResult {
                        idx,
                        path: Some(path),
                    }
                }
                Err(error) => {
                    eprintln!("[higgsfield] compare worker idx={idx} FAIL: {error}");
                    let _ = app_for_worker.emit(
                        EVENT_IMAGE_BATCH,
                        HiggsfieldBatchEvent::WorkerFailed {
                            batch_id: batch_id_for_worker,
                            idx,
                            error,
                            model_job_set_type: Some(model.job_set_type),
                            model_display_name: Some(model.display_name),
                        },
                    );
                    CompareWorkerResult { idx, path: None }
                }
            }
        });
    }

    let mut paths_by_idx = vec![None; args.models.len()];
    let mut failed_count = 0u32;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(worker) => {
                if let Some(slot) = paths_by_idx.get_mut(worker.idx.saturating_sub(1) as usize) {
                    *slot = worker.path;
                }
            }
            Err(error) => {
                eprintln!("[higgsfield] compare worker join error: {error}");
            }
        }
    }

    let mut generated_paths = Vec::new();
    for path in paths_by_idx {
        if let Some(path) = path {
            generated_paths.push(path);
        } else {
            failed_count += 1;
        }
    }

    if cancellation.flag.load(Ordering::SeqCst) {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Cancelled {
                batch_id: batch_id.clone(),
            },
        );
    } else {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::Completed {
                batch_id: batch_id.clone(),
                generated_paths: generated_paths.clone(),
                failed_count,
                provider: "higgsfield",
                model_job_set_type: None,
                model_display_name: None,
            },
        );
    }
    unregister_higgsfield_cancellation(&state, &batch_id).await;

    Ok(BatchSummary {
        batch_id,
        generated_paths,
        failed_count,
    })
}

#[tauri::command]
pub async fn higgsfield_cancel_batch(
    state: tauri::State<'_, AppState>,
    batch_id: String,
) -> Result<(), String> {
    let map = state.higgsfield_cancellations.lock().await;
    if let Some(cancellation) = map.get(&batch_id) {
        cancellation.flag.store(true, Ordering::SeqCst);
        cancellation.notify.notify_waiters();
    }
    Ok(())
}

#[tauri::command]
pub async fn higgsfield_generate_cost(
    job_set_type: String,
    prompt: String,
    aspect: Option<String>,
) -> Result<i64, String> {
    let binary = resolve_higgsfield_binary().ok_or_else(|| {
        "Higgsfield CLI が見つかりません。npm install -g @higgsfield/cli を実行してください。"
            .to_string()
    })?;
    let mut cmd = TokioCommand::new(binary);
    cmd.args(["generate", "cost", &job_set_type]);
    cmd.arg("--prompt").arg(prompt);
    if let Some(aspect) = aspect.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--aspect_ratio").arg(aspect);
    }
    cmd.arg("--json");
    cmd.env("PATH", enriched_path());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Higgsfield generate cost の実行に失敗しました: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield generate cost が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!("Higgsfield generate cost が失敗しました: {stderr}"));
    }

    let json = parse_json_stdout(&output.stdout)?;
    json.get("credits")
        .and_then(|value| value.as_i64())
        .or_else(|| json.get("credits_exact").and_then(|value| value.as_i64()))
        .ok_or_else(|| {
            let preview = serde_json::to_string(&json).unwrap_or_else(|_| "<invalid json>".into());
            format!("Higgsfield cost JSON から credits を見つけられませんでした: {preview}")
        })
}

fn resolve_higgsfield_binary() -> Option<PathBuf> {
    // [v0.6.19] GORI GORI 専用 Higgsfield 拡張パックを最優先で探す。
    // 拡張パックは別配布の dmg/zip でユーザーがインストールする。
    // インストール先 (固定):
    //   Mac:   ~/Library/Application Support/app.codexframefactory/extensions/higgsfield/bin/higgsfield
    //   Win:   %APPDATA%/app.codexframefactory/extensions/higgsfield/bin/higgsfield.cmd
    // ラッパーは Node.js ポータブル版を内部で使うので、ユーザー環境に
    // Node.js が無くても動く設計。
    if let Some(data_dir) = dirs::data_dir() {
        let ext_bin = if cfg!(windows) { "higgsfield.cmd" } else { "higgsfield" };
        let ext_path = data_dir
            .join("app.codexframefactory")
            .join("extensions")
            .join("higgsfield")
            .join("bin")
            .join(ext_bin);
        if ext_path.exists() {
            return Some(ext_path);
        }
    }

    if let Ok(output) = Command::new("which").arg("higgsfield").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let candidate = PathBuf::from(path);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    for candidate in [
        PathBuf::from("/opt/homebrew/bin/higgsfield"),
        PathBuf::from("/usr/local/bin/higgsfield"),
    ] {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    find_nvm_higgsfield()
}

fn find_nvm_higgsfield() -> Option<PathBuf> {
    let versions_dir = dirs::home_dir()?.join(".nvm/versions/node");
    let entries = std::fs::read_dir(versions_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("bin/higgsfield");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn auth_status(binary: &Path) -> bool {
    // higgsfield CLI には `auth status` サブコマンドが無く、ヘルプが返って
    // exit 0 で抜ける → 誤判定の原因 (CLI 0.1.35 で確認)。
    // 代わりに `auth token` を使う:
    //   - 認証済み: 現在のアクセストークンを stdout に出力 + exit 0
    //   - 未認証: error を stderr に出して exit non-zero
    // stdout が空でないことも追加条件にして「ヘルプが間違って通る」事故を防ぐ
    let Ok(output) = Command::new(binary).args(["auth", "token"]).output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    !stdout.trim().is_empty()
}

fn command_text<const N: usize>(binary: &Path, args: [&str; N]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|e| format!("Higgsfield CLI の実行に失敗しました: {e}"))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        return Ok(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("Higgsfield CLI が失敗しました: {}", output.status))
    } else {
        Err(stderr)
    }
}

async fn register_higgsfield_cancellation(
    state: &tauri::State<'_, AppState>,
    batch_id: &str,
) -> HiggsfieldCancellation {
    let cancellation = HiggsfieldCancellation {
        flag: Arc::new(AtomicBool::new(false)),
        notify: Arc::new(tokio::sync::Notify::new()),
    };
    state
        .higgsfield_cancellations
        .lock()
        .await
        .insert(batch_id.to_string(), cancellation.clone());
    cancellation
}

async fn unregister_higgsfield_cancellation(state: &tauri::State<'_, AppState>, batch_id: &str) {
    state.higgsfield_cancellations.lock().await.remove(batch_id);
}

fn cancelled_error() -> String {
    "cancelled (credits consumed)".to_string()
}

fn is_cancelled_error(error: &str) -> bool {
    error.starts_with("cancelled")
}

fn emit_cancelled_workers(
    app: &AppHandle,
    batch_id: &str,
    start_idx: u32,
    end_idx: u32,
    model_job_set_type: Option<&str>,
    model_display_name: Option<&str>,
) -> u32 {
    if start_idx > end_idx {
        return 0;
    }
    for idx in start_idx..=end_idx {
        let _ = app.emit(
            EVENT_IMAGE_BATCH,
            HiggsfieldBatchEvent::WorkerFailed {
                batch_id: batch_id.to_string(),
                idx,
                error: cancelled_error(),
                model_job_set_type: model_job_set_type.map(str::to_string),
                model_display_name: model_display_name.map(str::to_string),
            },
        );
    }
    end_idx - start_idx + 1
}

async fn wait_for_cancellation(cancellation: &HiggsfieldCancellation) {
    loop {
        let notified = cancellation.notify.notified();
        tokio::pin!(notified);
        if cancellation.flag.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}

async fn collect_child_output(
    status: ExitStatus,
    stdout_task: PipeReadTask,
    stderr_task: PipeReadTask,
) -> Result<Output, String> {
    let stdout = stdout_task
        .await
        .map_err(|e| format!("Higgsfield stdout 読み取りタスクが失敗しました: {e}"))?
        .map_err(|e| format!("Higgsfield stdout の読み取りに失敗しました: {e}"))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("Higgsfield stderr 読み取りタスクが失敗しました: {e}"))?
        .map_err(|e| format!("Higgsfield stderr の読み取りに失敗しました: {e}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn wait_child_output_or_cancel(
    mut child: Child,
    cancellation: &HiggsfieldCancellation,
) -> Result<Option<Output>, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stdout) = stdout {
            stdout.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stderr) = stderr {
            stderr.read_to_end(&mut bytes).await?;
        }
        Ok::<_, std::io::Error>(bytes)
    });

    tokio::select! {
        status = child.wait() => {
            let status = status
                .map_err(|e| format!("Higgsfield generate create の待機に失敗しました: {e}"))?;
            collect_child_output(status, stdout_task, stderr_task).await.map(Some)
        }
        _ = wait_for_cancellation(cancellation) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            Ok(None)
        }
    }
}

async fn run_one_higgsfield_job(
    binary: &Path,
    out_dir: &Path,
    idx: u32,
    args: &HiggsfieldBatchArgs,
    cancellation: &HiggsfieldCancellation,
) -> Result<String, String> {
    if cancellation.flag.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }

    let mut cmd = TokioCommand::new(binary);
    cmd.args(["generate", "create", &args.job_set_type]);
    cmd.arg("--prompt").arg(&args.prompt);
    // Higgsfield CLI は params を `--<snake_case_name> <value>` で受け取る
    // (例: `--aspect_ratio 16:9`)。フラグ名は `higgsfield model get <model>` の
    // `params[].name` と一致する必要がある (kebab-case や省略形は Unknown params エラー)。
    if let Some(aspect) = args.aspect.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--aspect_ratio").arg(aspect);
    }
    for path in args.ref_image_paths.as_deref().unwrap_or(&[]) {
        if !path.trim().is_empty() {
            cmd.arg("--image").arg(path);
        }
    }
    cmd.args([
        "--wait",
        "--wait-timeout",
        "20m",
        "--wait-interval",
        "5s",
        "--json",
    ]);
    if let Some(cwd) = args.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.current_dir(cwd);
    }
    cmd.env("PATH", enriched_path());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Higgsfield generate create の実行に失敗しました: {e}"))?;
    let Some(output) = wait_child_output_or_cancel(child, cancellation).await? else {
        return Err(cancelled_error());
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!(
                "Higgsfield generate create が失敗しました: {}",
                output.status
            ));
        }
        return Err(format!(
            "Higgsfield generate create が失敗しました: {stderr}"
        ));
    }

    let json = parse_json_stdout(&output.stdout)?;
    let result_url = extract_result_image(&json).ok_or_else(|| {
        let preview = serde_json::to_string(&json).unwrap_or_else(|_| "<invalid json>".into());
        format!("Higgsfield 出力 JSON から画像 URL を見つけられませんでした: {preview}")
    })?;
    let dest = out_dir.join(format!("hf_b{idx:02}_{}.png", short_id()));
    save_result_image(&result_url, &dest).await?;
    Ok(dest.to_string_lossy().into_owned())
}

fn parse_json_stdout(stdout: &[u8]) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return Ok(value);
    }
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            return Ok(value);
        }
    }
    for (open, close) in [('{', '}'), ('[', ']')] {
        if let (Some(start), Some(end)) = (text.find(open), text.rfind(close)) {
            if start < end {
                let candidate = &text[start..=end];
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                    return Ok(value);
                }
            }
        }
    }
    Err(format!(
        "Higgsfield generate create の JSON デコードに失敗しました: {}",
        trimmed
    ))
}

fn extract_result_image(value: &serde_json::Value) -> Option<String> {
    // Higgsfield CLI `generate create --wait --json` の出力形式 (公式 README 準拠):
    //   - トップレベルが配列 [{...}] (1 ジョブ = 1 要素)
    //   - 各要素のトップに `result_url` キー
    //   - status: "completed" を確認した方が安全
    // 例:
    //   [{"id":"...","status":"completed","result_url":"https://.../hf_xxx.png",
    //     "job_set_type":"nano_banana","params":{...}}]
    //
    // POINTERS は公式パターンを最優先で並べる。マッチしなければ再帰で url 系
    // キーを総当たり (古い API / 別モデルへの保険)。
    const POINTERS: [&str; 27] = [
        // 公式形式: トップ配列の [0].result_url
        "/0/result_url",
        "/0/resultUrl",
        "/0/url",
        // 単発オブジェクト形式 (一部モデルが返す可能性)
        "/result_url",
        "/resultUrl",
        "/url",
        // 旧 / 別パターン (フォールバック)
        "/result/images/0/url",
        "/result/images/0",
        "/result/image/url",
        "/result/outputs/0/url",
        "/result/outputs/0",
        "/result/outputUrl",
        "/result/output_url",
        "/result/resultUrl",
        "/result/result_url",
        "/result/url",
        "/data/images/0/url",
        "/data/images/0",
        "/data/image/url",
        "/data/outputs/0/url",
        "/data/outputs/0",
        "/data/outputUrl",
        "/data/output_url",
        "/data/result_url",
        "/outputUrl",
        "/output_url",
        "/0/url",
    ];
    for pointer in POINTERS {
        if let Some(url) = value.pointer(pointer).and_then(|v| v.as_str()) {
            if is_usable_result_ref(url) {
                return Some(url.to_string());
            }
        }
    }

    let mut keyed_urls = Vec::new();
    collect_url_key_strings(value, &mut keyed_urls);
    keyed_urls.into_iter().find(|url| is_usable_result_ref(url))
}

fn collect_url_key_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let lower = key.to_ascii_lowercase();
                if lower.contains("url") {
                    if let Some(s) = child.as_str().filter(|s| is_usable_result_ref(s)) {
                        out.push(s.to_string());
                    }
                }
                collect_url_key_strings(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_url_key_strings(item, out);
            }
        }
        _ => {}
    }
}

fn is_usable_result_ref(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://") || Path::new(trimmed).exists()
}

async fn save_result_image(src: &str, dest: &Path) -> Result<(), String> {
    let trimmed = src.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let output = TokioCommand::new("curl")
            .args(["-fsSL", "-o"])
            .arg(dest)
            .arg(trimmed)
            .output()
            .await
            .map_err(|e| format!("curl の実行に失敗しました: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err(format!("画像ダウンロードに失敗しました: {}", output.status));
        }
        return Err(format!("画像ダウンロードに失敗しました: {stderr}"));
    }
    std::fs::copy(trimmed, dest)
        .map(|_| ())
        .map_err(|e| format!("Higgsfield 出力画像のコピーに失敗しました: {e}"))
}

fn short_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos)
}
