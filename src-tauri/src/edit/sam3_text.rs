//! ことばで分離: SAM3 テキストプロンプト・セグメンテーション (int8 ONNX)。
//!
//! 「basketball」「train」等の言葉を与えると、その概念の全インスタンスを
//! ピクセル精度マスクで返す。layer-splitter (MLX SAM3, Apple Silicon 専用) の
//! テキスト分離体験を、既存の ort スタックで全OS配布可能な形に移植したもの。
//!
//! パイプライン: vision encoder (画像ごと1回, 実測7.7s) → text encoder (語ごと,
//! ~0.03s) → decoder (語ごと, ~2s)。vision の FPN 出力はセッション内にキャッシュし、
//! 同じ画像への語の追加は数秒で返す。
//!
//! 前処理は HF Sam3ImageProcessor 準拠: 1008x1008 bilinear / (x/255 - 0.5) / 0.5。
//! トークナイザは CLIP BPE (同梱 tokenizer.json、max_len=32、pad=<|endoftext|>)。

use std::path::Path;

use image::{ImageBuffer, Luma};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use crate::edit::registry::{find_model, model_path};
use crate::edit::runtime::{EditRuntime, OrtSessionHandle};

const INPUT_SIZE: u32 = 1008;
const MAX_TOKENS: usize = 32;
const PAD_TOKEN: &str = "<|endoftext|>";
/// 検出確信度の下限。実測 (2026-07-03): 正解は 0.75-0.98、誤検出 (日本語プロンプトの
/// 文字領域拾い等) は ~0.53 に出たため、その間に置く。
pub const DEFAULT_SCORE_THRESHOLD: f32 = 0.60;
/// 1語あたりの最大インスタンス数 (レイヤー暴発の安全弁)。
pub const MAX_INSTANCES_PER_WORD: usize = 8;

/// 検出 1 件 = レイヤー候補 1 件。
pub struct Sam3Detection {
    /// 確信度 (sigmoid 済み 0..1)。
    pub score: f32,
    /// 元画像同寸のソフトマスク (sigmoid*255。>127 が対象)。
    pub mask: ImageBuffer<Luma<u8>, Vec<u8>>,
}

/// FPN テンソル (shape + データ) のキャッシュ表現。
struct FpnTensor {
    shape: Vec<usize>,
    data: Vec<f32>,
}

/// SAM3 テキスト分離セッション。AppState に保持し、画像の embed をまたいで使い回す。
pub struct Sam3TextSession {
    vision: OrtSessionHandle,
    text: OrtSessionHandle,
    decoder: OrtSessionHandle,
    tokenizer: Tokenizer,
    /// embed 済み画像のキー (パス + サイズ + mtime)。一致すれば vision を再実行しない。
    embed_key: Option<String>,
    /// vision encoder の出力8本 (fpn_hidden_state_0..3, fpn_position_encoding_0..3)。
    fpn: Vec<FpnTensor>,
    orig_w: u32,
    orig_h: u32,
}

impl Sam3TextSession {
    /// 必要モデル4点が揃っていれば構築する (セッションは runtime キャッシュ共有)。
    pub async fn new(runtime: &EditRuntime) -> Result<Self, String> {
        let need = |id: &str| find_model(id).ok_or_else(|| format!("model spec not found: {id}"));
        let vision_spec = need("sam3-vision-int8")?;
        let text_spec = need("sam3-text-int8")?;
        let decoder_spec = need("sam3-decoder-int8")?;
        let tokenizer_spec = need("sam3-tokenizer")?;

        let tokenizer_path = model_path(&tokenizer_spec)?;
        if !tokenizer_path.exists() {
            return Err("model not downloaded: sam3-tokenizer".to_string());
        }
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("tokenizer load: {e}"))?;

        Ok(Self {
            vision: runtime.get_session(&vision_spec).await?,
            text: runtime.get_session(&text_spec).await?,
            decoder: runtime.get_session(&decoder_spec).await?,
            tokenizer,
            embed_key: None,
            fpn: Vec::new(),
            orig_w: 0,
            orig_h: 0,
        })
    }

    /// 画像を embed する (キー一致ならスキップ)。vision encoder は画像ごとに1回だけ走る。
    pub async fn embed_image(&mut self, input_path: &Path) -> Result<(), String> {
        let key = embed_cache_key(input_path)?;
        if self.embed_key.as_deref() == Some(key.as_str()) && !self.fpn.is_empty() {
            tracing::info!(target: "codex.edit", "sam3: embedキャッシュ命中 ({key})");
            return Ok(());
        }

        let img = image::open(input_path).map_err(|e| format!("open: {e}"))?;
        let (ow, oh) = (img.width(), img.height());
        let pixel_values = preprocess(&img);

        let started = std::time::Instant::now();
        let tensor = Tensor::<f32>::from_array((
            [1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
            pixel_values,
        ))
        .map_err(|e| format!("pixel tensor: {e}"))?;

        let mut fpn = Vec::with_capacity(8);
        {
            let mut vision = self.vision.lock().await;
            let outputs = vision
                .run(ort::inputs!["pixel_values" => tensor])
                .map_err(|e| format!("vision run: {e}"))?;
            if outputs.len() < 8 {
                return Err(format!("unexpected vision outputs: {}", outputs.len()));
            }
            for i in 0..8 {
                let (shape, data) = outputs[i]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("vision output {i}: {e}"))?;
                fpn.push(FpnTensor {
                    shape: shape.iter().map(|&d| d as usize).collect(),
                    data: data.to_vec(),
                });
            }
        }
        tracing::info!(
            target: "codex.edit",
            "sam3: vision embed 完了 {}x{} ({}ms)",
            ow, oh, started.elapsed().as_millis()
        );

        self.embed_key = Some(key);
        self.fpn = fpn;
        self.orig_w = ow;
        self.orig_h = oh;
        Ok(())
    }

    /// embed 済み画像に対して1語を予測し、閾値以上の検出を確信度降順で返す。
    pub async fn predict_word(
        &self,
        prompt: &str,
        score_threshold: f32,
    ) -> Result<Vec<Sam3Detection>, String> {
        if self.fpn.is_empty() {
            return Err("sam3: embed されていない (embed_image を先に呼ぶ)".to_string());
        }
        let started = std::time::Instant::now();
        let (input_ids, attention_mask) = self.tokenize(prompt)?;

        // text encoder
        let ids_tensor = Tensor::<i64>::from_array(([1usize, MAX_TOKENS], input_ids))
            .map_err(|e| format!("ids tensor: {e}"))?;
        let attn_tensor = Tensor::<i64>::from_array(([1usize, MAX_TOKENS], attention_mask.clone()))
            .map_err(|e| format!("attn tensor: {e}"))?;
        let text_features: FpnTensor = {
            let mut text = self.text.lock().await;
            let outputs = text
                .run(ort::inputs!["input_ids" => ids_tensor, "attention_mask" => attn_tensor])
                .map_err(|e| format!("text run: {e}"))?;
            let (shape, data) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("text output: {e}"))?;
            FpnTensor {
                shape: shape.iter().map(|&d| d as usize).collect(),
                data: data.to_vec(),
            }
        };

        // decoder: FPN 上位3層 + 位置エンコーディング + テキスト特徴。
        // tracer が未使用入力を落としている可能性があるため、実セッションの入力名で絞る。
        let attn_tensor = Tensor::<i64>::from_array(([1usize, MAX_TOKENS], attention_mask))
            .map_err(|e| format!("attn tensor2: {e}"))?;
        let (pred_masks, pred_logits) = {
            let mut decoder = self.decoder.lock().await;
            let expected: Vec<String> =
                decoder.inputs().iter().map(|i| i.name().to_string()).collect();
            let mut feed: Vec<(String, ort::value::Value)> = Vec::new();
            for (name, idx) in [
                ("fpn_hidden_state_0", 0usize),
                ("fpn_hidden_state_1", 1),
                ("fpn_hidden_state_2", 2),
                ("fpn_position_encoding_0", 4),
                ("fpn_position_encoding_1", 5),
                ("fpn_position_encoding_2", 6),
            ] {
                if expected.iter().any(|n| n == name) {
                    feed.push((name.to_string(), fpn_to_value(&self.fpn[idx])?));
                }
            }
            if expected.iter().any(|n| n == "text_features") {
                feed.push(("text_features".to_string(), fpn_to_value(&text_features)?));
            }
            if expected.iter().any(|n| n == "attention_mask") {
                feed.push(("attention_mask".to_string(), attn_tensor.into()));
            }
            let outputs = decoder
                .run(feed)
                .map_err(|e| format!("decoder run: {e}"))?;
            // 出力順: pred_masks [1,200,288,288] / pred_boxes [1,200,4] / pred_logits [1,200]
            let (mask_shape, mask_data) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("masks output: {e}"))?;
            let (_logit_shape, logit_data) = outputs[2]
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("logits output: {e}"))?;
            (
                FpnTensor {
                    shape: mask_shape.iter().map(|&d| d as usize).collect(),
                    data: mask_data.to_vec(),
                },
                logit_data.to_vec(),
            )
        };

        // スコア上位から閾値以上を採用し、元画像寸のソフトマスクへ変換する。
        let n_queries = pred_logits.len();
        let mut order: Vec<usize> = (0..n_queries).collect();
        order.sort_by(|&a, &b| {
            pred_logits[b]
                .partial_cmp(&pred_logits[a])
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let (mh, mw) = (
            pred_masks.shape[2] as u32,
            pred_masks.shape[3] as u32,
        );
        let plane = (mh * mw) as usize;
        let mut detections = Vec::new();
        for &qi in order.iter().take(MAX_INSTANCES_PER_WORD) {
            let score = sigmoid(pred_logits[qi]);
            if score < score_threshold {
                break;
            }
            let logits = &pred_masks.data[qi * plane..(qi + 1) * plane];
            let mut small = ImageBuffer::<Luma<u8>, Vec<u8>>::new(mw, mh);
            for (i, px) in small.pixels_mut().enumerate() {
                *px = Luma([(sigmoid(logits[i]) * 255.0) as u8]);
            }
            let full = image::imageops::resize(
                &small,
                self.orig_w,
                self.orig_h,
                image::imageops::FilterType::Triangle,
            );
            // 閾値未満はゼロ化 (crop_object_png が alpha にそのまま使うため)。
            let mut mask = full;
            for px in mask.pixels_mut() {
                if px[0] <= 127 {
                    *px = Luma([0u8]);
                }
            }
            if mask.pixels().all(|p| p[0] == 0) {
                continue;
            }
            detections.push(Sam3Detection { score, mask });
        }
        tracing::info!(
            target: "codex.edit",
            "sam3: '{prompt}' → {}件 ({}ms)",
            detections.len(),
            started.elapsed().as_millis()
        );
        Ok(detections)
    }

    /// CLIP BPE で max_len=32 に pad/truncate する。
    fn tokenize(&self, prompt: &str) -> Result<(Vec<i64>, Vec<i64>), String> {
        let encoded = self
            .tokenizer
            .encode(prompt, true)
            .map_err(|e| format!("tokenize: {e}"))?;
        let pad_id = self
            .tokenizer
            .token_to_id(PAD_TOKEN)
            .ok_or_else(|| "pad token not found".to_string())? as i64;
        let mut ids: Vec<i64> = encoded.get_ids().iter().map(|&v| v as i64).collect();
        ids.truncate(MAX_TOKENS);
        let mut attn: Vec<i64> = vec![1; ids.len()];
        while ids.len() < MAX_TOKENS {
            ids.push(pad_id);
            attn.push(0);
        }
        Ok((ids, attn))
    }
}

/// Sam3ImageProcessor 準拠の前処理: 1008x1008 bilinear + (x/255 - 0.5)/0.5、CHW。
fn preprocess(img: &image::DynamicImage) -> Vec<f32> {
    let resized = img
        .resize_exact(INPUT_SIZE, INPUT_SIZE, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let plane = (INPUT_SIZE * INPUT_SIZE) as usize;
    let mut out = vec![0f32; plane * 3];
    for (i, p) in resized.pixels().enumerate() {
        out[i] = (p[0] as f32 / 255.0 - 0.5) / 0.5;
        out[plane + i] = (p[1] as f32 / 255.0 - 0.5) / 0.5;
        out[plane * 2 + i] = (p[2] as f32 / 255.0 - 0.5) / 0.5;
    }
    out
}

fn fpn_to_value(t: &FpnTensor) -> Result<ort::value::Value, String> {
    Tensor::<f32>::from_array((t.shape.clone(), t.data.clone()))
        .map(|v| v.into())
        .map_err(|e| format!("fpn tensor: {e}"))
}

fn sigmoid(v: f32) -> f32 {
    1.0 / (1.0 + (-v).exp())
}

/// embed キャッシュのキー: パス + ファイルサイズ + mtime 秒。
fn embed_cache_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("metadata: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{}|{}|{}", path.display(), meta.len(), mtime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigmoid_is_monotonic_and_bounded() {
        assert!(sigmoid(0.0) - 0.5 < 1e-6);
        assert!(sigmoid(10.0) > 0.99);
        assert!(sigmoid(-10.0) < 0.01);
    }

    #[test]
    fn preprocess_shape_and_range() {
        let img = image::DynamicImage::new_rgb8(64, 32);
        let v = preprocess(&img);
        assert_eq!(v.len(), (INPUT_SIZE * INPUT_SIZE * 3) as usize);
        // 黒画像 → (0/255 - 0.5)/0.5 = -1.0
        assert!((v[0] + 1.0).abs() < 1e-6);
    }
}
