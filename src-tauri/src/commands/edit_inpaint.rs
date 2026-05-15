use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::inpaint::inpaint_image;
use crate::state::AppState;

#[tauri::command]
pub async fn edit_inpaint_run(
    state: State<'_, AppState>,
    input_path: String,
    mask_path: String,
    project_name: Option<String>,
) -> Result<String, String> {
    let runtime = state.edit_runtime.clone();
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-inpaint-{}", now_millis());
    let output_dir = resolve_output_dir(&settings, project_name.as_deref(), &leaf);
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;
    let output_path = output_dir.join("inpainted.png");
    inpaint_image(
        runtime.as_ref(),
        Path::new(&input_path),
        Path::new(&mask_path),
        &output_path,
    )
    .await?;
    Ok(output_path.to_string_lossy().into_owned())
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
