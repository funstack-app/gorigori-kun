use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::edit::download::{download_model, EditModelProgress};
use crate::edit::registry::{all_models, find_model, model_path};
use crate::events::EVENT_EDIT_MODEL_PROGRESS;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub local_path: Option<String>,
}

#[tauri::command]
pub async fn edit_models_list() -> Result<Vec<ModelStatus>, String> {
    let mut out = Vec::new();
    for spec in all_models() {
        let path = model_path(&spec)?;
        let downloaded = path.exists();
        out.push(ModelStatus {
            id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            category: spec.category.as_str().to_string(),
            size_bytes: spec.size_bytes,
            downloaded,
            local_path: downloaded.then(|| path.to_string_lossy().into_owned()),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn edit_models_download(app: AppHandle, model_ids: Vec<String>) -> Result<(), String> {
    let specs = all_models();
    tokio::spawn(async move {
        for id in &model_ids {
            if let Some(spec) = specs.iter().find(|spec| spec.id == id.as_str()) {
                if let Err(err) = download_model(&app, spec).await {
                    let _ = app.emit(
                        EVENT_EDIT_MODEL_PROGRESS,
                        EditModelProgress::Failed {
                            model_id: id.clone(),
                            reason: err,
                        },
                    );
                }
            } else {
                let _ = app.emit(
                    EVENT_EDIT_MODEL_PROGRESS,
                    EditModelProgress::Failed {
                        model_id: id.clone(),
                        reason: format!("unknown model id: {id}"),
                    },
                );
            }
        }
    });
    Ok(())
}

/// 実行環境情報。編集タブのモード可否表示にフロントが使う汎用情報。
/// 注: 人物パーツ分解(SCHP)は CPU ONNX 推論で全OS動くため、もはや
/// Apple Silicon 判定には依存しない。is_apple_silicon は将来の
/// プラットフォーム別最適化(例: CoreML EP 追加時)に備えた素の環境情報として残す。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlatformInfo {
    /// "macos" | "windows" | "linux" 等 (std::env::consts::OS)
    pub os: String,
    /// "aarch64" | "x86_64" 等 (std::env::consts::ARCH)
    pub arch: String,
    /// Apple Silicon (macos + aarch64)。現状どのモードの前提でもない素の環境情報。
    pub is_apple_silicon: bool,
    /// ort (ONNX Runtime) 依存の編集AI機能がこのビルドで使えるか (2026-08-02)。
    ///
    /// フロントは os を直接見ずにこれで判定する。Windows 互換版 (compat) は
    /// OS が windows のまま false になるため、os での判定だと誤って
    /// 「使える」と表示してしまう。
    pub edit_ai_available: bool,
}

#[tauri::command]
pub fn edit_platform_info() -> EditPlatformInfo {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let is_apple_silicon = os == "macos" && arch == "aarch64";
    EditPlatformInfo {
        os,
        arch,
        is_apple_silicon,
        edit_ai_available: cfg!(edit_ai),
    }
}

#[tauri::command]
pub async fn edit_models_delete(
    #[allow(unused_variables)] state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    let spec = find_model(&model_id).ok_or_else(|| format!("unknown model id: {model_id}"))?;
    let path = model_path(&spec)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("delete failed: {e}"))?;
    }
    // ort セッションキャッシュの破棄は Windows のみ。非 Windows には
    // edit_runtime が存在しない (ort が Windows 限定依存のため。2026-07-28)。
    // モデルファイルの削除自体はどちらでも走るので、DL 済みモデルの掃除は
    // Mac でも機能する。
    #[cfg(edit_ai)]
    state.edit_runtime.clear().await;
    Ok(())
}
