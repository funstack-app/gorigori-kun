use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::segment::{segment_image, SegmentResult};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentResultPayload {
    pub width: u32,
    pub height: u32,
    pub foreground_path: String,
    pub background_path: String,
    pub mask_path: String,
}

impl From<SegmentResult> for SegmentResultPayload {
    fn from(result: SegmentResult) -> Self {
        let SegmentResult {
            mask: _,
            width,
            height,
            foreground_path,
            background_path,
            mask_path,
        } = result;
        Self {
            width,
            height,
            foreground_path: foreground_path.to_string_lossy().into_owned(),
            background_path: background_path.to_string_lossy().into_owned(),
            mask_path: mask_path.to_string_lossy().into_owned(),
        }
    }
}

#[tauri::command]
pub async fn edit_segment_run(
    state: State<'_, AppState>,
    input_path: String,
    project_name: Option<String>,
) -> Result<SegmentResultPayload, String> {
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-segment-{}", now_secs());
    let output_dir = resolve_output_dir(&settings, project_name.as_deref(), &leaf);
    let result = segment_image(&state.edit_runtime, Path::new(&input_path), &output_dir).await?;
    Ok(result.into())
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}
