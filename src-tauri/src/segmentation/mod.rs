pub mod download;
pub mod runner;

use serde::{Deserialize, Serialize};
use std::path::Path;

pub use download::{download_model, is_model_installed};
pub use runner::run_segmentation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SegmentationModel {
    #[serde(rename = "u2net")]
    U2Net,
    #[serde(rename = "u2netp")]
    U2NetP,
    #[serde(rename = "mobile_sam")]
    MobileSAM,
    #[serde(rename = "sam3")]
    Sam3,
}

impl SegmentationModel {
    pub fn key(self) -> &'static str {
        match self {
            SegmentationModel::U2Net => "u2net",
            SegmentationModel::U2NetP => "u2netp",
            SegmentationModel::MobileSAM => "mobile_sam",
            SegmentationModel::Sam3 => "sam3",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            SegmentationModel::U2Net => "U2Net",
            SegmentationModel::U2NetP => "U2NetP",
            SegmentationModel::MobileSAM => "MobileSAM",
            SegmentationModel::Sam3 => "SAM3.1",
        }
    }

    pub fn estimated_size_mb(self) -> u32 {
        match self {
            SegmentationModel::U2Net => 176,
            SegmentationModel::U2NetP => 5,
            SegmentationModel::MobileSAM => 39,
            SegmentationModel::Sam3 => 3490,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationModelStatus {
    pub model: SegmentationModel,
    pub installed: bool,
    pub cache_path: String,
    pub estimated_size_mb: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentationResult {
    pub foreground_path: String,
    pub background_path: String,
    pub mask_path: String,
}

pub fn model_cache_dir(model: SegmentationModel) -> std::io::Result<std::path::PathBuf> {
    let root = dirs::cache_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("gori-gori-kun")
        .join("segmentation-models");
    Ok(root.join(model.key()))
}

pub fn model_status(model: SegmentationModel) -> Result<SegmentationModelStatus, String> {
    let cache_dir = model_cache_dir(model).map_err(|err| err.to_string())?;
    Ok(SegmentationModelStatus {
        model,
        installed: is_model_installed(model),
        cache_path: cache_dir.display().to_string(),
        estimated_size_mb: model.estimated_size_mb(),
    })
}

pub fn validate_image_path(image_path: &Path) -> Result<(), String> {
    if !image_path.exists() {
        return Err(format!("画像が見つかりません: {}", image_path.display()));
    }
    if !image_path.is_file() {
        return Err(format!(
            "画像ファイルではありません: {}",
            image_path.display()
        ));
    }
    Ok(())
}
