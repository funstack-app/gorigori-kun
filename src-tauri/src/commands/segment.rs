#[cfg(edit_ai)]
use std::path::Path;

#[cfg(edit_ai)]
use crate::commands::now_secs;
#[cfg(edit_ai)]
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::download::download_model as download_edit_model;
use crate::edit::registry::{find_model, model_path};
#[cfg(edit_ai)]
use crate::edit::segment::segment_image as run_birefnet_segment;
#[cfg(edit_ai)]
use crate::segmentation::SegmentationResult;
use crate::segmentation::{SegmentationModel, SegmentationModelStatus};
#[cfg(edit_ai)]
use crate::state::AppState;
use tauri::AppHandle;
#[cfg(edit_ai)]
use tauri::State;

const BIREFNET_ID: &str = "birefnet-general";

/// BiRefNet (ort) による背景除去。ort が Windows 限定になったため
/// 非 Windows では commands/edit_unsupported.rs のスタブが代わりに登録される。
///
/// 注意: Mac の背景透過は Vision (resources/removebg.swift) 経由の別経路で、
/// commands/images.rs にある。この cfg の影響を受けない。
#[cfg(edit_ai)]
#[tauri::command]
pub async fn segment_image(
    state: State<'_, AppState>,
    image_path: String,
    model: Option<SegmentationModel>,
) -> Result<SegmentationResult, String> {
    let _ = model;
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-segment-{}", now_secs());
    let output_dir = resolve_output_dir(&settings, None, &leaf);
    let result =
        run_birefnet_segment(&state.edit_runtime, Path::new(&image_path), &output_dir).await?;

    Ok(SegmentationResult {
        foreground_path: result.foreground_path.to_string_lossy().into_owned(),
        background_path: result.background_path.to_string_lossy().into_owned(),
        mask_path: result.mask_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn is_segmentation_model_ready(
    model: SegmentationModel,
) -> Result<SegmentationModelStatus, String> {
    birefnet_status(model)
}

#[tauri::command]
pub async fn download_segmentation_model(
    app: AppHandle,
    model: SegmentationModel,
) -> Result<SegmentationModelStatus, String> {
    let spec =
        find_model(BIREFNET_ID).ok_or_else(|| "BiRefNet model spec not found".to_string())?;
    download_edit_model(&app, &spec).await?;
    birefnet_status(model)
}

fn birefnet_status(model: SegmentationModel) -> Result<SegmentationModelStatus, String> {
    let spec =
        find_model(BIREFNET_ID).ok_or_else(|| "BiRefNet model spec not found".to_string())?;
    let path = model_path(&spec)?;
    Ok(SegmentationModelStatus {
        model,
        installed: path.exists(),
        cache_path: path.to_string_lossy().into_owned(),
        estimated_size_mb: (spec.size_bytes / 1024 / 1024) as u32,
    })
}
