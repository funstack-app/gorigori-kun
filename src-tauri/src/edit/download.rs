use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::edit::registry::{model_path, ModelSpec};
use crate::events::EVENT_EDIT_MODEL_PROGRESS;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum EditModelProgress {
    Started {
        model_id: String,
        total_bytes: u64,
    },
    Progress {
        model_id: String,
        downloaded_bytes: u64,
        total_bytes: u64,
    },
    Completed {
        model_id: String,
        file_path: String,
    },
    Failed {
        model_id: String,
        reason: String,
    },
}

pub async fn download_model(app: &AppHandle, spec: &ModelSpec) -> Result<PathBuf, String> {
    let path = model_path(spec)?;
    if path.exists() {
        return Ok(path);
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("models dir mkdir: {e}"))?;
    }

    let tmp_path = path.with_extension("onnx.tmp");
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let _ = app.emit(
        EVENT_EDIT_MODEL_PROGRESS,
        EditModelProgress::Started {
            model_id: spec.id.to_string(),
            total_bytes: spec.size_bytes,
        },
    );

    let result = download_model_inner(spec, &path, &tmp_path, app).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
    }
    result
}

async fn download_model_inner(
    spec: &ModelSpec,
    path: &PathBuf,
    tmp_path: &PathBuf,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let resp = reqwest::get(spec.url)
        .await
        .map_err(|e| format!("DL request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("DL http status failed: {e}"))?;
    let total = resp.content_length().unwrap_or(spec.size_bytes);
    let mut file = tokio::fs::File::create(tmp_path)
        .await
        .map_err(|e| format!("tmp file create: {e}"))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream chunk: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("file write: {e}"))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= Duration::from_millis(100) {
            let _ = app.emit(
                EVENT_EDIT_MODEL_PROGRESS,
                EditModelProgress::Progress {
                    model_id: spec.id.to_string(),
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                },
            );
            last_emit = Instant::now();
        }
    }

    file.flush().await.map_err(|e| format!("file flush: {e}"))?;
    drop(file);

    tokio::fs::rename(tmp_path, path)
        .await
        .map_err(|e| format!("rename: {e}"))?;

    let _ = app.emit(
        EVENT_EDIT_MODEL_PROGRESS,
        EditModelProgress::Completed {
            model_id: spec.id.to_string(),
            file_path: path.to_string_lossy().into_owned(),
        },
    );

    Ok(path.clone())
}
