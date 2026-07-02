use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::edit::registry::{model_hash_pin_path, model_path, ModelSpec};
use crate::events::EVENT_EDIT_MODEL_PROGRESS;

/// ファイルの sha256 を小文字 hex で計算する (ブロッキング IO を回避するため
/// spawn_blocking で回す)。
async fn compute_sha256(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path).map_err(|e| format!("hash open: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("hash read: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| format!("hash task join: {e}"))?
}

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
        // 既存 DL 済みユーザー互換:
        // - 実ハッシュ埋め込みモデル: 期待値と一致すればそのまま採用。
        //   不一致なら破損/改竄扱いで削除し、再 DL に進む (詰ませない)。
        // - TOFU モデル: ピン留めが無ければ「現状のハッシュをピン留め」して採用
        //   (旧バージョンで検証なしに落とした正規ファイルを弾かないため)。
        ensure_existing_file_ok(spec, &path).await?;
        if path.exists() {
            return Ok(path);
        }
        // ハッシュ不一致で削除された場合はここに落ちて通常 DL フローへ進む。
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

    // DL 実体の整合性検証 (rename 前に tmp を検証し、汚染ファイルを本パスへ昇格させない)。
    verify_and_pin(spec, tmp_path).await?;

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

/// ユーザー向けの日本語検証失敗メッセージ。
fn verify_failed_msg(spec: &ModelSpec) -> String {
    format!(
        "モデルファイル「{}」の検証に失敗しました。再ダウンロードしてください。",
        spec.display_name
    )
}

/// 新規 DL した tmp ファイルを検証し、TOFU モデルなら初回ハッシュをピン留めする。
///
/// - 実ハッシュ埋め込みモデル: 期待値と不一致なら tmp を削除して日本語エラーを返す。
/// - TOFU モデル: 計算したハッシュを `<file>.sha256` にピン留めする。ピン留めが
///   既に存在すればそれと照合し、不一致なら削除して日本語エラーを返す。
async fn verify_and_pin(spec: &ModelSpec, tmp_path: &PathBuf) -> Result<(), String> {
    let actual = compute_sha256(tmp_path).await?;

    if spec.has_pinned_hash() {
        if !actual.eq_ignore_ascii_case(spec.sha256) {
            let _ = tokio::fs::remove_file(tmp_path).await;
            return Err(verify_failed_msg(spec));
        }
        return Ok(());
    }

    // TOFU: ピン留めファイルと照合、無ければ今回の値を正とする。
    let pin_path = model_hash_pin_path(spec)?;
    match tokio::fs::read_to_string(&pin_path).await {
        Ok(pinned) => {
            let pinned = pinned.trim();
            if !pinned.is_empty() && !actual.eq_ignore_ascii_case(pinned) {
                let _ = tokio::fs::remove_file(tmp_path).await;
                return Err(verify_failed_msg(spec));
            }
        }
        Err(_) => {
            // 初回: ハッシュをピン留め (失敗しても DL 自体は成功扱いにする)。
            let _ = tokio::fs::write(&pin_path, &actual).await;
        }
    }
    Ok(())
}

/// 既存 DL 済みファイルの互換検証。
///
/// - 実ハッシュ埋め込みモデル: 一致→そのまま採用 / 不一致→破損扱いで削除
///   (呼び出し側が再 DL に進む)。
/// - TOFU モデル: ピン留めがあれば照合 (不一致→削除)。ピン留めが無ければ現状の
///   ハッシュを新たにピン留めして採用する (旧バージョンで検証なしに落とした
///   正規ファイルを弾いてユーザーを詰ませないため)。
async fn ensure_existing_file_ok(spec: &ModelSpec, path: &Path) -> Result<(), String> {
    let actual = compute_sha256(path).await?;

    if spec.has_pinned_hash() {
        if !actual.eq_ignore_ascii_case(spec.sha256) {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Ok(());
    }

    let pin_path = model_hash_pin_path(spec)?;
    match tokio::fs::read_to_string(&pin_path).await {
        Ok(pinned) => {
            let pinned = pinned.trim();
            if !pinned.is_empty() && !actual.eq_ignore_ascii_case(pinned) {
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        Err(_) => {
            // ピン留め未記録 → 現状をピン留め (互換)。
            let _ = tokio::fs::write(&pin_path, &actual).await;
        }
    }
    Ok(())
}
