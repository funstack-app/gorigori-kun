use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCategory {
    Ocr,
    Inpaint,
    Segment,
    SamClick,
    /// 高精度モード用。人物パーツ自動認識 (SCHP human parsing)。
    HumanParse,
    /// ことばで分離 (SAM3 テキストプロンプト・セグメンテーション)。
    TextSegment,
}

impl ModelCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ocr => "ocr",
            Self::Inpaint => "inpaint",
            Self::Segment => "segment",
            Self::SamClick => "samClick",
            Self::HumanParse => "humanParse",
            Self::TextSegment => "textSegment",
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
        // === 既定 OCR モデル: PP-OCRv6 small (2026-06 公開・PaddlePaddle 公式 ONNX / Apache 2.0) ===
        //
        // v5 mobile からの差し替え理由 (2026-07-02):
        //   実機で「バスケ」→「ハスケ」の濁点落ち誤認識が発生した。真因は認識器の
        //   CTC 辞書不整合。旧実装は ocr.rs 内に ~440 文字のハードコード辞書を持ち、
        //   モデル本来の 18708 文字辞書と索引がズレていた (バ idx1906 / ハ idx1905 が
        //   隣接するため、正しい出力索引が隣の文字へ化ける)。v6 では公式辞書
        //   (ppocrv6_dict.txt, 18708 文字) を include_str! で同梱し索引を厳密一致させる。
        //
        // 入出力仕様 (v5 との差分は ocr.rs の前処理に反映済み):
        //   det: 入力 [N,3,H,W] BGR + ImageNet mean/std 正規化、出力 [N,1,H,W] 確率マップ
        //   rec: 入力 [N,3,48,W] BGR + (x/255-0.5)/0.5 正規化、出力 [N,T,18710] (=18708辞書+blank+pad)
        //
        // ハッシュは HF LFS oid sha256 (DL 実体の sha256 と一致確認済み)。
        ModelSpec {
            id: "ppocrv6-small-det",
            category: ModelCategory::Ocr,
            display_name: "テキスト検出 (PP-OCRv6)",
            url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/main/inference.onnx",
            file_name: "ppocrv6-small-det.onnx",
            size_bytes: 9_880_512,
            sha256: "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e",
        },
        ModelSpec {
            id: "ppocrv6-small-rec",
            category: ModelCategory::Ocr,
            display_name: "テキスト認識 (PP-OCRv6)",
            url: "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/main/inference.onnx",
            file_name: "ppocrv6-small-rec.onnx",
            size_bytes: 21_159_378,
            sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
        },
        // === 旧 OCR モデル: PP-OCRv5 mobile (ロールバック用にコメントとして残置) ===
        //
        // 既定 (all_models) からは外した。理由: OCR ゲート (EditModelGate) は category=ocr の
        // 未DLモデルを一律に DL 対象にするため、v5 を active に残すと v6 と二重DL (+21MB) に
        // なり、かつ v5 が「未DL＝不足」判定でゲートを塞ぐ。v6 で致命的な回帰が出た場合の
        // 緊急退避手順は以下:
        //   1. 下記 spec を all_models に復帰させ、v6 spec を外す (id は変えない)
        //   2. ocr.rs の det/rec spec id を paddleocr-mobile-* に戻す
        //   3. ocr.rs の前処理を v5 版へ戻す:
        //        det: RGB + 0..1 正規化 (mean/std なし)
        //        rec: RGB + 0..1 正規化 (0.5 センタリングなし)
        //        辞書: v5 用 ppocrv5_dict.txt (18383行) に差し替え、CTC pad を +2 とする
        //   なお v5 も正しい公式辞書 (ppocrv5_dict.txt) を使えば濁点落ちは解消する。
        //   本差し替えの本質は「モデル世代」より「辞書索引の厳密一致」にある。
        //
        // ModelSpec { id: "paddleocr-mobile-det", category: Ocr, display_name: "テキスト検出 (PaddleOCR v5)",
        //   url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_det.onnx",
        //   file_name: "paddleocr-mobile-det.onnx", size_bytes: 4_830_000,
        //   sha256: "1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039" }
        // ModelSpec { id: "paddleocr-mobile-rec", category: Ocr, display_name: "テキスト認識 (PaddleOCR v5)",
        //   url: "https://huggingface.co/ilaylow/PP_OCRv5_mobile_onnx/resolve/main/ppocrv5_rec.onnx",
        //   file_name: "paddleocr-mobile-rec.onnx", size_bytes: 16_600_000,
        //   sha256: "243a0f06d826761323e9045e9b113ab2c191c3aa50565585e628300b8eda0224" }
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
        // === ことばで分離: SAM3 テキストプロンプト・セグメンテーション (int8 量子化) ===
        //
        // Meta SAM3 (2025-11公開) のコミュニティ ONNX export (danilobukvic/sam3-text-onnx)。
        // 「basketball」「train」等の言葉で概念単位の instance segmentation ができる。
        // 実測 (2026-07-03 Apple Silicon CPU): vision 7.7s/画像 + 1語 2s、basketball 0.983 /
        // robot 0.974 の確信度でピクセル精度マスク。int8 は fp32 と 0.001 以内のスコア一致
        // (配布元の検証記録)。ライセンスは SAM 3 License (再配布時にライセンス同梱が条件。
        // layer-splitter プロジェクトで配布可と検証済み: ~/layer-splitter/DISTRIBUTION_AND_COST.md)。
        //
        // ハッシュは HF paths-info の LFS oid と実DLの sha256 の両方で照合済み (2026-07-03)。
        // tokenizer.json は非LFSのため実DL実体の sha256 をピン留め。
        ModelSpec {
            id: "sam3-vision-int8",
            category: ModelCategory::TextSegment,
            display_name: "ことばで分離 vision (SAM3)",
            url: "https://huggingface.co/danilobukvic/sam3-text-onnx/resolve/main/vision_encoder_int8.onnx",
            file_name: "sam3-vision-int8.onnx",
            size_bytes: 496_047_770,
            sha256: "1a688329a8be3ae32d5f0bbf20657faac5a38e257fa30e8f5469a7e513a0b51c",
        },
        ModelSpec {
            id: "sam3-text-int8",
            category: ModelCategory::TextSegment,
            display_name: "ことばで分離 text (SAM3)",
            url: "https://huggingface.co/danilobukvic/sam3-text-onnx/resolve/main/text_encoder_int8.onnx",
            file_name: "sam3-text-int8.onnx",
            size_bytes: 357_021_801,
            sha256: "c0baf8a4165ecc4039bee9389903723e74a68d617d685a4f1dbfc21c58bb4121",
        },
        ModelSpec {
            id: "sam3-decoder-int8",
            category: ModelCategory::TextSegment,
            display_name: "ことばで分離 decoder (SAM3)",
            url: "https://huggingface.co/danilobukvic/sam3-text-onnx/resolve/main/decoder_int8.onnx",
            file_name: "sam3-decoder-int8.onnx",
            size_bytes: 26_804_694,
            sha256: "d721e7b643bb3ee2c48a59d520401c035c702cfbb13cb7f50fa103f0beb27af8",
        },
        ModelSpec {
            id: "sam3-tokenizer",
            category: ModelCategory::TextSegment,
            display_name: "ことばで分離 tokenizer (SAM3)",
            url: "https://huggingface.co/danilobukvic/sam3-text-onnx/resolve/main/tokenizer.json",
            file_name: "sam3-tokenizer.json",
            size_bytes: 3_642_073,
            sha256: "6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35",
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
