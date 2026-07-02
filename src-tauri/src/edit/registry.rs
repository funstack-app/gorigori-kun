use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCategory {
    Ocr,
    Inpaint,
    Segment,
    SamClick,
    /// 高精度モード用。人物パーツ自動認識 (SCHP human parsing)。
    HumanParse,
}

impl ModelCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ocr => "ocr",
            Self::Inpaint => "inpaint",
            Self::Segment => "segment",
            Self::SamClick => "samClick",
            Self::HumanParse => "humanParse",
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
    /// DL 後に照合する期待 sha256 (小文字 hex 64桁)。
    ///
    /// HuggingFace の git-lfs `oid sha256` はダウンロード実体の sha256 と
    /// 一致することを確認済み (paths-info API で取得 → 実DLで照合検証済み)。
    /// このため全モデルに実ハッシュを埋め込んでいる。
    ///
    /// 空文字 `""` にした場合は TOFU (Trust On First Use) 方式にフォールバックする:
    /// 初回 DL 成功時にローカルへ `<file>.sha256` としてハッシュをピン留めし、
    /// 以降の再 DL では初回値と照合する。将来 sha256 を事前取得できない配布物を
    /// 追加したときの逃げ道として機構だけ残してある (現状該当なし)。
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
            sha256: "1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039",
        },
        ModelSpec {
            id: "paddleocr-mobile-rec",
            category: ModelCategory::Ocr,
            display_name: "テキスト認識 (PaddleOCR)",
            url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx",
            file_name: "paddleocr-mobile-rec.onnx",
            size_bytes: 16_600_000,
            sha256: "243a0f06d826761323e9045e9b113ab2c191c3aa50565585e628300b8eda0224",
        },
        ModelSpec {
            id: "lama-onnx",
            category: ModelCategory::Inpaint,
            display_name: "背景補完 (LaMa)",
            url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
            file_name: "lama_fp32.onnx",
            size_bytes: 208_044_816,
            sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
        },
        ModelSpec {
            id: "birefnet-general",
            category: ModelCategory::Segment,
            display_name: "切り抜き (BiRefNet)",
            url: "https://huggingface.co/EmmaJohnson311/TensorRT-ONNX-collect/resolve/main/BiRefNet-v2-onnx/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
            file_name: "birefnet-general.onnx",
            size_bytes: 224_000_000,
            sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
        },
        ModelSpec {
            id: "sam2-tiny-encoder",
            category: ModelCategory::SamClick,
            display_name: "クリック切り抜き encoder (SAM2 Tiny)",
            url: "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/encoder.onnx",
            file_name: "sam2-tiny-encoder.onnx",
            size_bytes: 134_000_000,
            sha256: "df265cb552475e1b3a6cb57c939e57c95ed849bfc2f985c06efab85d8bca6db9",
        },
        ModelSpec {
            id: "sam2-tiny-decoder",
            category: ModelCategory::SamClick,
            display_name: "クリック切り抜き decoder (SAM2 Tiny)",
            url: "https://huggingface.co/SharpAI/sam2-hiera-tiny-onnx/resolve/main/decoder.onnx",
            file_name: "sam2-tiny-decoder.onnx",
            size_bytes: 20_600_000,
            sha256: "63198f1f1e273d8f2f4a9d1baf926e53a01d78dc50e0674640e1513dc00d9927",
        },
        // 高精度モード: 人物パーツ自動認識 (SCHP, ATR 18クラス)。
        // INT8 静的量子化版を採用 (単一ファイル66MB。FP32版は .onnx.data 外部データ
        // 付随の2ファイル構成で単一ファイル前提のDL機構と相性が悪いため)。
        // 入力: pixel_values (1,3,512,512) RGB/255/(x-mean)/std。出力: logits (1,18,512,512)。
        ModelSpec {
            id: "schp-atr-18",
            category: ModelCategory::HumanParse,
            display_name: "人物パーツ自動認識 (SCHP ATR)",
            url: "https://huggingface.co/pirocheto/schp-atr-18/resolve/main/onnx/schp-atr-18-int8-static.onnx",
            file_name: "schp-atr-18-int8-static.onnx",
            size_bytes: 66_000_000,
            sha256: "4420d8db8c1f266967c89485786b01209f6d405f320fc0f87e8ced49392cefb5",
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

/// TOFU (Trust On First Use) 用のハッシュピン留めファイルのパス。
/// `<models_dir>/<file_name>.sha256`。実ハッシュ埋め込みモデルでは使わない。
pub fn model_hash_pin_path(spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(models_dir()?.join(format!("{}.sha256", spec.file_name)))
}

impl ModelSpec {
    /// 実ハッシュが埋め込まれているか (= 事前照合方式)。
    /// `false` のときは TOFU (初回ピン留め) 方式にフォールバックする。
    pub fn has_pinned_hash(&self) -> bool {
        self.sha256.len() == 64 && self.sha256.chars().all(|c| c.is_ascii_hexdigit())
    }
}

pub fn find_model(id: &str) -> Option<ModelSpec> {
    all_models().into_iter().find(|spec| spec.id == id)
}
