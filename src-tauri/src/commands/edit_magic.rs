use std::path::Path;

use tauri::{AppHandle, State};

use crate::edit::magic_layer::{run_magic_layer, MagicLayerResult};
use crate::state::AppState;

#[tauri::command]
pub async fn edit_magic_run(
    app: AppHandle,
    state: State<'_, AppState>,
    input_path: String,
    project_name: Option<String>,
) -> Result<MagicLayerResult, String> {
    run_magic_layer(
        &app,
        &state,
        Path::new(&input_path),
        project_name.as_deref(),
    )
    .await
}
