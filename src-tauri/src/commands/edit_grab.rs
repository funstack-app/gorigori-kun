use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::commands::edit_segment::now_secs;
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::grab::grab_object;
use crate::state::AppState;

/// マジックグラブの結果 (フロント lib/edit/types.ts GrabResult と一致・camelCase)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrabResultPayload {
    /// マスク bbox にクロップした掴めるオブジェクトの透過 PNG パス。
    pub object_png: String,
    /// 元画像ピクセル座標の [x, y, width, height]。フロントがこの位置に置く。
    pub bbox: [i32; 4],
    /// 掴んだ跡地を LaMa で補完した背景画像パス。背景レイヤーをこれに差し替える。
    pub filled_background: String,
    pub width: u32,
    pub height: u32,
}

/// マスク + 元画像から「掴めるオブジェクト透過PNG + bbox + 穴埋め背景」を返す。
///
/// クリック切り抜き (edit_sam2_predict) で得たマスクを confirm 後にここへ渡す想定。
/// フロントはこの結果を使い、背景レイヤーを filled_background に差し替え、object_png を
/// bbox 位置に新規レイヤーとして追加してドラッグ可能にする (アトミックに適用)。
#[tauri::command]
pub async fn edit_grab_object(
    state: State<'_, AppState>,
    input_path: String,
    mask_path: String,
    project_name: Option<String>,
) -> Result<GrabResultPayload, String> {
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-grab-{}", now_secs());
    let output_dir = resolve_output_dir(&settings, project_name.as_deref(), &leaf);

    let result = grab_object(
        state.edit_runtime(),
        Path::new(&input_path),
        Path::new(&mask_path),
        &output_dir,
    )
    .await?;

    Ok(GrabResultPayload {
        object_png: result.object_png_path.to_string_lossy().into_owned(),
        bbox: result.bbox,
        filled_background: result.filled_background_path.to_string_lossy().into_owned(),
        width: result.width,
        height: result.height,
    })
}
