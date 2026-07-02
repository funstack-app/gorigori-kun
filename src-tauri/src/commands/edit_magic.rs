use std::path::Path;

use tauri::{AppHandle, State};

use crate::edit::auto_segment::{DEFAULT_OBJECT_COUNT, MAX_OBJECTS_HARD_CAP};
use crate::edit::magic_layer::{run_magic_layer, EditMode, MagicLayerResult, ObjectLayerOptions};
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
    // 物体分解 (SAM2 自動マスク) の有効/無効。省略時は ON (standard モードでのみ効く)。
    include_objects: Option<bool>,
    // 採用する物体数の上限。省略時は DEFAULT_OBJECT_COUNT。MAX_OBJECTS_HARD_CAP で丸める。
    object_count: Option<usize>,
) -> Result<MagicLayerResult, String> {
    let edit_mode = EditMode::from_id(mode.as_deref().unwrap_or("standard"))?;
    let object_options = ObjectLayerOptions {
        enabled: include_objects.unwrap_or(true),
        count: object_count
            .unwrap_or(DEFAULT_OBJECT_COUNT)
            .clamp(1, MAX_OBJECTS_HARD_CAP),
    };
    run_magic_layer(
        &app,
        &state,
        Path::new(&input_path),
        project_name.as_deref(),
        edit_mode,
        object_options,
    )
    .await
}
