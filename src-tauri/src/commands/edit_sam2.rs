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
    // RwLock の read guard は predict_mask().await をまたいで保持しない。
    // なぜ: guard を await 越しに握ると、embed し直し (set_sam2_session の write().await) と
    // 絡んで停止しうる。predict_mask 内部で decoder Mutex を取れば十分なので、ここでは
    // guard をすぐ解放できるよう最小スコープに閉じ、その中で推論まで済ませる。
    let guard = state.sam2_session.read().await;
    let session = guard.as_ref().ok_or_else(|| "not embedded".to_string())?;
    let mask = session.predict_mask((x, y), positive).await?;
    drop(guard);
    Ok(MaskPayload {
        mask_base64: general_purpose::STANDARD.encode(mask.png),
        width: mask.width,
        height: mask.height,
    })
}
