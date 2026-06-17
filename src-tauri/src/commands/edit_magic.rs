use std::path::Path;

use tauri::{AppHandle, State};

use crate::edit::magic_layer::{run_magic_layer, EditMode, MagicLayerResult};
use crate::state::AppState;

#[tauri::command]
pub async fn edit_magic_run(
    app: AppHandle,
    state: State<'_, AppState>,
    input_path: String,
    project_name: Option<String>,
    // フロント (lib/edit/types.ts EditModeId) と一致: "standard" | "highQuality"。
    // 省略時は standard。未知値も standard にフォールバックせず明示エラーにしたいので
    // EditMode::from_id で判定する。
    mode: Option<String>,
) -> Result<MagicLayerResult, String> {
    let edit_mode = EditMode::from_id(mode.as_deref().unwrap_or("standard"))?;
    run_magic_layer(
        &app,
        &state,
        Path::new(&input_path),
        project_name.as_deref(),
        edit_mode,
    )
    .await
}
