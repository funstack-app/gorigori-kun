use std::path::Path;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::State;

use crate::edit::sam2::Sam2Session;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskPayload {
    pub mask_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn edit_sam2_embed(state: State<'_, AppState>, input_path: String) -> Result<(), String> {
    let mut session = Sam2Session::new(state.edit_runtime()).await?;
    session.embed_image(Path::new(&input_path)).await?;
    state.set_sam2_session(session).await;
    Ok(())
}

#[tauri::command]
pub async fn edit_sam2_predict(
    state: State<'_, AppState>,
    x: f32,
    y: f32,
    positive: bool,
) -> Result<MaskPayload, String> {
    let guard = state.sam2_session.read().await;
    let session = guard.as_ref().ok_or_else(|| "not embedded".to_string())?;
    let mask = session.predict_mask((x, y), positive).await?;
    Ok(MaskPayload {
        mask_base64: general_purpose::STANDARD.encode(mask.png),
        width: mask.width,
        height: mask.height,
    })
}
