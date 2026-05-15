use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCategory {
    Ocr,
    Inpaint,
    Segment,
    SamClick,
}

impl ModelCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ocr => "ocr",
            Self::Inpaint => "inpaint",
            Self::Segment => "segment",
            Self::SamClick => "samClick",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub id: &'static str,
    pub category: ModelCategory,
    pub display_name: &'static str,
    pub url: &'static str,
    pub file_name: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

pub fn all_models() -> Vec<ModelSpec> {
    vec![
        ModelSpec {
            id: "paddleocr-mobile-det",
            category: ModelCategory::Ocr,
            display_name: "テキスト検出 (PaddleOCR)",
            url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx",
            file_name: "paddleocr-mobile-det.onnx",
            size_bytes: 4_830_000,
            sha256: "PLACEHOLDER_DET",
        },
        ModelSpec {
            id: "paddleocr-mobile-rec",
            category: ModelCategory::Ocr,
            display_name: "テキスト認識 (PaddleOCR)",
            url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx",
            file_name: "paddleocr-mobile-rec.onnx",
            size_bytes: 16_600_000,
            sha256: "PLACEHOLDER_REC",
        },
        ModelSpec {
            id: "lama-onnx",
            category: ModelCategory::Inpaint,
            display_name: "背景補完 (LaMa)",
            url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
            file_name: "lama_fp32.onnx",
            size_bytes: 208_044_816,
            sha256: "PLACEHOLDER_LAMA",
        },
        ModelSpec {
            id: "birefnet-general",
            category: ModelCategory::Segment,
            display_name: "切り抜き (BiRefNet)",
            url: "https://huggingface.co/EmmaJohnson311/TensorRT-ONNX-collect/resolve/main/BiRefNet-v2-onnx/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
            file_name: "birefnet-general.onnx",
            size_bytes: 224_000_000,
            sha256: "PLACEHOLDER_BIREFNET",
        },
        ModelSpec {
            id: "sam2-tiny-encoder",
            category: ModelCategory::SamClick,
            display_name: "クリック切り抜き encoder (SAM2 Tiny)",
            url: "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/encoder.onnx",
            file_name: "sam2-tiny-encoder.onnx",
            size_bytes: 134_000_000,
            sha256: "PLACEHOLDER_SAM_ENC",
        },
        ModelSpec {
            id: "sam2-tiny-decoder",
            category: ModelCategory::SamClick,
            display_name: "クリック切り抜き decoder (SAM2 Tiny)",
            url: "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/decoder.onnx",
            file_name: "sam2-tiny-decoder.onnx",
            size_bytes: 20_600_000,
            sha256: "PLACEHOLDER_SAM_DEC",
        },
    ]
}

pub fn models_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "home dir not found".to_string())?;
    let dir = home.join("Library/Application Support/app.codexframefactory/models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("models dir mkdir: {e}"))?;
    Ok(dir)
}

pub fn model_path(spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(spec.file_name))
}

pub fn find_model(id: &str) -> Option<ModelSpec> {
    all_models().into_iter().find(|spec| spec.id == id)
}
