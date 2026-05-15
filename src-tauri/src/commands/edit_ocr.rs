use std::path::Path;

use tauri::State;

use crate::edit::ocr::{ocr_image, TextRegion};
use crate::state::AppState;

#[tauri::command]
pub async fn edit_ocr_detect(
    state: State<'_, AppState>,
    input_path: String,
) -> Result<Vec<TextRegion>, String> {
    let runtime = state.edit_runtime.clone();
    ocr_image(runtime.as_ref(), Path::new(&input_path)).await
}
