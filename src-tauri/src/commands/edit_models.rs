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

#[tauri::command]
pub async fn edit_models_delete(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    let spec = find_model(&model_id).ok_or_else(|| format!("unknown model id: {model_id}"))?;
    let path = model_path(&spec)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("delete failed: {e}"))?;
    }
    state.edit_runtime.clear().await;
    Ok(())
}
