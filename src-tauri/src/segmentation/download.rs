use super::{model_cache_dir, model_status, SegmentationModel, SegmentationModelStatus};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

const READY_MARKER: &str = "READY";

pub fn is_model_installed(model: SegmentationModel) -> bool {
    model_cache_dir(model)
        .map(|dir| dir.join(READY_MARKER).is_file())
        .unwrap_or(false)
}

pub fn download_model(model: SegmentationModel) -> Result<SegmentationModelStatus, String> {
    let cache_dir = model_cache_dir(model).map_err(|err| err.to_string())?;
    fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let metadata = format!(
        "{{\n  \"model\": \"{}\",\n  \"displayName\": \"{}\",\n  \"estimatedSizeMb\": {},\n  \"downloadedAt\": {}\n}}\n",
        model.key(),
        model.display_name(),
        model.estimated_size_mb(),
        now
    );

    fs::write(cache_dir.join("model.json"), metadata).map_err(|err| err.to_string())?;
    fs::write(cache_dir.join(READY_MARKER), b"ready\n").map_err(|err| err.to_string())?;

    // TODO: Replace this marker write with the real model download pipeline.
    // Lightweight models should be resolved into this cache. Large models
    // should stay opt-in and report progress through an app event.
    model_status(model)
}
