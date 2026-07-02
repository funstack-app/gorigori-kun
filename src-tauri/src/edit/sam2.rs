use std::io::Cursor;
use std::path::Path;
use std::time::Instant;

use image::{GenericImageView, ImageBuffer, Luma};
use ort::session::{Session, SessionInputValue, SessionOutputs};
use ort::value::{Tensor, ValueType};

use crate::edit::registry::find_model;
use crate::edit::runtime::{EditRuntime, OrtSessionHandle};

const SAM2_SIZE: u32 = 1024;
const DEFAULT_MASK_SIZE: usize = 256;

#[derive(Debug, Clone)]
struct TensorCache {
    data: Vec<f32>,
    shape: Vec<i64>,
}

#[derive(Debug, Clone)]
struct Sam2ImageEmbedding {
    image_embed: TensorCache,
    high_res_feats_0: Option<TensorCache>,
    high_res_feats_1: Option<TensorCache>,
}

#[derive(Debug)]
pub struct Sam2Mask {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 自動マスク生成 1 点分の生マスク。PNG に符号化する前の Luma バッファ + 予測スコア。
/// フィルタ/NMS を Rust 側で回すため、bbox・面積も同時に持つ。
#[derive(Debug, Clone)]
pub struct Sam2RawMask {
    /// 元画像と同寸の 2 値マスク (255=対象)。
    pub mask: ImageBuffer<Luma<u8>, Vec<u8>>,
    /// SAM2 decoder が返した best candidate の IoU 予測スコア。
    pub score: f32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct Sam2Session {
    encoder: OrtSessionHandle,
    decoder: OrtSessionHandle,
    cached_image_embedding: Option<Sam2ImageEmbedding>,
    cached_image_size: Option<(u32, u32)>,
}

impl Sam2Session {
    /// クリック切り抜き UI 用。encoder/decoder を **runtime キャッシュで共有** する。
    /// UI は 1 セッションを state.sam2_session に保持して使い回すので共有が適切。
    pub async fn new(runtime: &EditRuntime) -> Result<Self, String> {
        let enc_spec = find_model("sam2-tiny-encoder")
            .ok_or_else(|| "model spec not found: sam2-tiny-encoder".to_string())?;
        let dec_spec = find_model("sam2-tiny-decoder")
            .ok_or_else(|| "model spec not found: sam2-tiny-decoder".to_string())?;
        Ok(Self {
            encoder: runtime.get_session(&enc_spec).await?,
            decoder: runtime.get_session(&dec_spec).await?,
            cached_image_embedding: None,
            cached_image_size: None,
        })
    }

    /// Magic Layer の物体分解専用。encoder/decoder を **キャッシュ共有せず専用生成** する。
    ///
    /// なぜ: 物体分解はグリッド点を数百回 decoder に流す。共有セッションだとクリック切り抜き
    /// UI (state.sam2_session が同じ decoder Arc<Mutex> を参照) と Mutex を奪い合い、UI 側が
    /// guard を保持したままだと物体分解の `.lock().await` が 0% CPU で永久停止する
    /// (2026-07-02 実機デッドロック)。専用セッションは他コマンドと Mutex を共有しないため、
    /// この経路のデッドロックが構造的に起きえない。
    pub fn new_dedicated() -> Result<Self, String> {
        let enc_spec = find_model("sam2-tiny-encoder")
            .ok_or_else(|| "model spec not found: sam2-tiny-encoder".to_string())?;
        let dec_spec = find_model("sam2-tiny-decoder")
            .ok_or_else(|| "model spec not found: sam2-tiny-decoder".to_string())?;
        Ok(Self {
            encoder: EditRuntime::build_session_uncached(&enc_spec)?,
            decoder: EditRuntime::build_session_uncached(&dec_spec)?,
            cached_image_embedding: None,
            cached_image_size: None,
        })
    }

    pub async fn embed_image(&mut self, input_path: &Path) -> Result<(), String> {
        let started = Instant::now();
        let img = image::open(input_path).map_err(|e| format!("open image: {e}"))?;
        let (w, h) = img.dimensions();
        let resized = img.resize_exact(SAM2_SIZE, SAM2_SIZE, image::imageops::FilterType::Lanczos3);
        let rgb = resized.to_rgb8();

        let image_area = (SAM2_SIZE * SAM2_SIZE) as usize;
        let mut input_data = vec![0f32; 3 * image_area];
        for (i, p) in rgb.pixels().enumerate() {
            input_data[i] = (p[0] as f32 / 255.0 - 0.485) / 0.229;
            input_data[image_area + i] = (p[1] as f32 / 255.0 - 0.456) / 0.224;
            input_data[2 * image_area + i] = (p[2] as f32 / 255.0 - 0.406) / 0.225;
        }

        let input_tensor =
            Tensor::from_array(([1_i64, 3, SAM2_SIZE as i64, SAM2_SIZE as i64], input_data))
                .map_err(|e| format!("encoder tensor: {e}"))?;

        let mut encoder = self.encoder.lock().await;
        log_session_io("sam2.encoder", &encoder);
        let image_input_name = find_input_name(&encoder, &["image"])
            .ok_or_else(|| "SAM2 encoder has no inputs".to_string())?;
        let outputs = encoder
            .run(ort::inputs![image_input_name.as_str() => input_tensor])
            .map_err(|e| format!("encoder run: {e}"))?;

        let image_embed = extract_named_or_index(&outputs, &["image_embed", "image_embedding"], 0)?;
        let high_res_feats_0 = extract_optional_named_or_index(
            &outputs,
            &["high_res_feats_0", "high_res_feat0", "high_res_feats0"],
            1,
        )?;
        let high_res_feats_1 = extract_optional_named_or_index(
            &outputs,
            &["high_res_feats_1", "high_res_feat1", "high_res_feats1"],
            2,
        )?;
        drop(outputs);
        drop(encoder);

        self.cached_image_embedding = Some(Sam2ImageEmbedding {
            image_embed,
            high_res_feats_0,
            high_res_feats_1,
        });
        self.cached_image_size = Some((w, h));
        tracing::info!(target: "edit.sam2", "embed_image completed in {}ms", started.elapsed().as_millis());
        Ok(())
    }

    pub async fn predict_mask(
        &self,
        click_point: (f32, f32),
        positive: bool,
    ) -> Result<Sam2Mask, String> {
        let started = Instant::now();
        let embedding = self
            .cached_image_embedding
            .as_ref()
            .ok_or_else(|| "not embedded".to_string())?;
        let (w, h) = self
            .cached_image_size
            .ok_or_else(|| "cached image size not found".to_string())?;

        let cx = click_point.0.clamp(0.0, 1.0) * SAM2_SIZE as f32;
        let cy = click_point.1.clamp(0.0, 1.0) * SAM2_SIZE as f32;
        let label = if positive { 1.0 } else { 0.0 };

        let mut decoder = self.decoder.lock().await;
        log_session_io("sam2.decoder", &decoder);
        let decoder_inputs = build_decoder_inputs(&decoder, embedding, cx, cy, label)?;
        let outputs = decoder
            .run(decoder_inputs)
            .map_err(|e| format!("decoder run: {e}"))?;

        let mask_png = mask_output_to_png(&outputs, w, h)?;
        drop(outputs);
        drop(decoder);

        tracing::info!(target: "edit.sam2", "predict_mask completed in {}ms", started.elapsed().as_millis());
        Ok(Sam2Mask {
            png: mask_png,
            width: w,
            height: h,
        })
    }

    /// 自動マスク生成用。キャッシュ済み embedding を使い、正クリック点 1 個から
    /// 元画像同寸の 2 値マスクと IoU 予測スコアを返す (PNG 符号化しない)。
    ///
    /// predict_mask との違い: グリッド走査で数百回呼ぶため PNG 符号化を挟まず、
    /// フィルタ/NMS に必要な Luma バッファと score をそのまま返す。encoder は
    /// 呼ばない (embed_image を 1 回だけ流用する前提)。
    pub async fn predict_raw_mask(
        &self,
        click_point: (f32, f32),
    ) -> Result<Sam2RawMask, String> {
        let embedding = self
            .cached_image_embedding
            .as_ref()
            .ok_or_else(|| "not embedded".to_string())?;
        let (w, h) = self
            .cached_image_size
            .ok_or_else(|| "cached image size not found".to_string())?;

        let cx = click_point.0.clamp(0.0, 1.0) * SAM2_SIZE as f32;
        let cy = click_point.1.clamp(0.0, 1.0) * SAM2_SIZE as f32;

        // decoder は直接 lock して同期実行する。クリック切り抜きの predict_mask と同じ経路。
        //
        // なぜ spawn_blocking を使わないか (2026-07-02 「採用0件」真因):
        // 以前は decoder.run を tokio::spawn_blocking + lock_owned でブロッキングプールへ
        // 逃がしていたが、この経路では全グリッド点で decoder が実行に到達せず即エラー扱いで
        // 捨てられ、採用0件になっていた (256点/89ms = 1点0.35ms は build_decoder_inputs の
        // tensor clone だけが走り run() が動いていない兆候)。ONNX モデルと入力構築自体は
        // 正しい (同じ入力を onnxruntime に流すと masks(1,3,256,256)+iou[0.99,..] を返すことを
        // 実測確認済み)。物体分解専用セッション (new_dedicated) は他コマンドと Mutex を共有
        // しないため、run が多少 async ワーカーを塞いでも UI 側デッドロックは起きえない
        // (共有しないのが new_dedicated の目的)。よって spawn_blocking は不要で、
        // predict_mask と同じ「直接 lock → run」に揃えるのが安全。
        let mut decoder = self.decoder.lock().await;
        let decoder_inputs = build_decoder_inputs(&decoder, embedding, cx, cy, 1.0)?;
        let outputs = decoder
            .run(decoder_inputs)
            .map_err(|e| format!("decoder run: {e}"))?;
        let (mask, score) = mask_output_to_buffer(&outputs, w, h)?;
        drop(outputs);
        drop(decoder);

        Ok(Sam2RawMask {
            mask,
            score,
            width: w,
            height: h,
        })
    }
}

fn build_decoder_inputs<'a>(
    decoder: &Session,
    embedding: &Sam2ImageEmbedding,
    cx: f32,
    cy: f32,
    label: f32,
) -> Result<Vec<(String, SessionInputValue<'a>)>, String> {
    let mut inputs: Vec<(String, SessionInputValue<'a>)> = Vec::new();

    for input in decoder.inputs() {
        let name = input.name().to_string();
        let lower = name.to_ascii_lowercase();
        if lower == "image_embed" || lower == "image_embedding" || lower == "image_embeddings" {
            push_tensor(&mut inputs, name, &embedding.image_embed)?;
        } else if lower == "high_res_feats_0"
            || lower == "high_res_feat0"
            || lower == "high_res_feats0"
        {
            let tensor = embedding
                .high_res_feats_0
                .as_ref()
                .ok_or_else(|| "encoder output high_res_feats_0 not found".to_string())?;
            push_tensor(&mut inputs, name, tensor)?;
        } else if lower == "high_res_feats_1"
            || lower == "high_res_feat1"
            || lower == "high_res_feats1"
        {
            let tensor = embedding
                .high_res_feats_1
                .as_ref()
                .ok_or_else(|| "encoder output high_res_feats_1 not found".to_string())?;
            push_tensor(&mut inputs, name, tensor)?;
        } else if lower == "point_coords" || lower == "coords" {
            let point_count = point_count_from_shape(input.dtype(), 2);
            let mut coords = Vec::with_capacity(point_count * 2);
            coords.extend_from_slice(&[cx, cy]);
            for _ in 1..point_count {
                coords.extend_from_slice(&[0.0, 0.0]);
            }
            let tensor = Tensor::from_array(([1_i64, point_count as i64, 2_i64], coords))
                .map_err(|e| format!("point_coords tensor: {e}"))?;
            inputs.push((name, SessionInputValue::from(tensor)));
        } else if lower == "point_labels" || lower == "labels" {
            let point_count = point_count_from_shape(input.dtype(), 2);
            let mut labels = vec![-1.0; point_count];
            if let Some(first) = labels.first_mut() {
                *first = label;
            }
            let tensor = Tensor::from_array(([1_i64, point_count as i64], labels))
                .map_err(|e| format!("point_labels tensor: {e}"))?;
            inputs.push((name, SessionInputValue::from(tensor)));
        } else if lower == "mask_input" || lower == "mask_inputs" {
            let shape = tensor_shape_or(
                input.dtype(),
                &[1, 1, DEFAULT_MASK_SIZE as i64, DEFAULT_MASK_SIZE as i64],
            );
            let len = tensor_len(&shape)?;
            // 明示的に f32。Rust の `0.0` リテラルは文脈が無いと f64 になり、SAM2 decoder が
            // `tensor(double)` を受け取って「expected: tensor(float)」で全点失敗する
            // (2026-07-02 実機バグ: predict失敗 256点全滅の真因)。
            let tensor = Tensor::from_array((shape, vec![0.0f32; len]))
                .map_err(|e| format!("mask_input tensor: {e}"))?;
            inputs.push((name, SessionInputValue::from(tensor)));
        } else if lower == "has_mask_input" || lower == "has_mask_inputs" {
            let shape = tensor_shape_or(input.dtype(), &[1]);
            let len = tensor_len(&shape)?;
            // f32 明示 (mask_input と同じ理由。f64 だと tensor(double) で decoder が拒否する)。
            let mut data = vec![0.0f32; len];
            if data.is_empty() {
                data.push(0.0f32);
            }
            let tensor = Tensor::from_array((shape, data))
                .map_err(|e| format!("has_mask_input tensor: {e}"))?;
            inputs.push((name, SessionInputValue::from(tensor)));
        } else {
            return Err(format!(
                "unsupported SAM2 decoder input `{}`; inputs: {}",
                input.name(),
                decoder
                    .inputs()
                    .iter()
                    .map(|item| item.name().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }

    Ok(inputs)
}

fn push_tensor<'a>(
    inputs: &mut Vec<(String, SessionInputValue<'a>)>,
    name: String,
    tensor: &TensorCache,
) -> Result<(), String> {
    let value = Tensor::from_array((tensor.shape.clone(), tensor.data.clone()))
        .map_err(|e| format!("{name} tensor: {e}"))?;
    inputs.push((name, SessionInputValue::from(value)));
    Ok(())
}

fn point_count_from_shape(dtype: &ValueType, default: usize) -> usize {
    dtype
        .tensor_shape()
        .and_then(|shape| shape.get(1).copied())
        .filter(|dim| *dim > 0)
        .map(|dim| dim as usize)
        .unwrap_or(default)
}

fn tensor_shape_or(dtype: &ValueType, fallback: &[i64]) -> Vec<i64> {
    dtype
        .tensor_shape()
        .map(|shape| {
            shape
                .iter()
                .enumerate()
                .map(|(index, dim)| {
                    if *dim > 0 {
                        *dim
                    } else {
                        fallback.get(index).copied().unwrap_or(1)
                    }
                })
                .collect::<Vec<_>>()
        })
        .filter(|shape| !shape.is_empty())
        .unwrap_or_else(|| fallback.to_vec())
}

fn tensor_len(shape: &[i64]) -> Result<usize, String> {
    shape.iter().try_fold(1usize, |acc, dim| {
        if *dim <= 0 {
            Err(format!("invalid tensor shape: {shape:?}"))
        } else {
            acc.checked_mul(*dim as usize)
                .ok_or_else(|| format!("tensor shape too large: {shape:?}"))
        }
    })
}

fn find_input_name(session: &Session, candidates: &[&str]) -> Option<String> {
    for candidate in candidates {
        if let Some(input) = session
            .inputs()
            .iter()
            .find(|input| input.name() == *candidate)
        {
            return Some(input.name().to_string());
        }
    }
    session
        .inputs()
        .first()
        .map(|input| input.name().to_string())
}

fn extract_named_or_index(
    outputs: &SessionOutputs<'_>,
    names: &[&str],
    index: usize,
) -> Result<TensorCache, String> {
    if let Some(cache) = extract_optional_named_or_index(outputs, names, index)? {
        Ok(cache)
    } else {
        Err(format!(
            "SAM2 output not found; expected one of {:?} or index {}. outputs: {}",
            names,
            index,
            outputs.keys().collect::<Vec<_>>().join(", ")
        ))
    }
}

fn extract_optional_named_or_index(
    outputs: &SessionOutputs<'_>,
    names: &[&str],
    index: usize,
) -> Result<Option<TensorCache>, String> {
    for name in names {
        if let Some(value) = outputs.get(*name) {
            return value_to_cache(value).map(Some);
        }
    }
    if index < outputs.len() {
        return value_to_cache(&outputs[index]).map(Some);
    }
    Ok(None)
}

fn value_to_cache(value: &ort::value::DynValue) -> Result<TensorCache, String> {
    let (shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("extract tensor: {e}"))?;
    Ok(TensorCache {
        data: data.to_vec(),
        shape: shape.iter().copied().collect(),
    })
}

fn mask_output_to_png(
    outputs: &SessionOutputs<'_>,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    let (resized, _score) = mask_output_to_buffer(outputs, width, height)?;
    let mut png = Vec::new();
    image::DynamicImage::ImageLuma8(resized)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("encode mask png: {e}"))?;
    Ok(png)
}

/// decoder 出力から元画像同寸の 2 値マスクと best candidate の IoU スコアを取り出す。
/// mask_output_to_png と predict_raw_mask の共通処理。
fn mask_output_to_buffer(
    outputs: &SessionOutputs<'_>,
    width: u32,
    height: u32,
) -> Result<(ImageBuffer<Luma<u8>, Vec<u8>>, f32), String> {
    let masks_value = outputs
        .get("masks")
        .or_else(|| outputs.get("mask"))
        .unwrap_or_else(|| &outputs[0]);
    let (shape, masks) = masks_value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("extract masks: {e}"))?;
    let shape = shape.iter().copied().collect::<Vec<_>>();
    let (candidate_count, mask_h, mask_w, base_offset) = mask_layout(&shape, masks.len())?;
    let candidate = best_mask_candidate(outputs, candidate_count).min(candidate_count - 1);
    let score = mask_candidate_score(outputs, candidate);

    let mask_2d =
        ImageBuffer::<Luma<u8>, Vec<u8>>::from_fn(mask_w as u32, mask_h as u32, |x, y| {
            let offset =
                base_offset + candidate * mask_h * mask_w + y as usize * mask_w + x as usize;
            let v = masks.get(offset).copied().unwrap_or_default();
            Luma([if v > 0.0 { 255 } else { 0 }])
        });
    let resized = image::imageops::resize(
        &mask_2d,
        width,
        height,
        image::imageops::FilterType::Nearest,
    );
    Ok((resized, score))
}

/// 指定 candidate の IoU 予測スコアを返す。スコア出力が無い decoder では 1.0 を返す
/// (スコア無し = フィルタで落とさない安全側)。
fn mask_candidate_score(outputs: &SessionOutputs<'_>, candidate: usize) -> f32 {
    let Some(value) = outputs
        .get("iou_predictions")
        .or_else(|| outputs.get("iou_scores"))
    else {
        return 1.0;
    };
    let Ok((_shape, scores)) = value.try_extract_tensor::<f32>() else {
        return 1.0;
    };
    scores.get(candidate).copied().unwrap_or(1.0)
}

fn mask_layout(shape: &[i64], data_len: usize) -> Result<(usize, usize, usize, usize), String> {
    match shape {
        [_, candidates, h, w] if *candidates > 0 && *h > 0 && *w > 0 => {
            Ok((*candidates as usize, *h as usize, *w as usize, 0))
        }
        [candidates, h, w] if *candidates > 0 && *h > 0 && *w > 0 => {
            Ok((*candidates as usize, *h as usize, *w as usize, 0))
        }
        [h, w] if *h > 0 && *w > 0 => Ok((1, *h as usize, *w as usize, 0)),
        _ => {
            let side = (data_len as f64).sqrt() as usize;
            if side > 0 && side * side == data_len {
                Ok((1, side, side, 0))
            } else if data_len % (DEFAULT_MASK_SIZE * DEFAULT_MASK_SIZE) == 0 {
                Ok((
                    data_len / (DEFAULT_MASK_SIZE * DEFAULT_MASK_SIZE),
                    DEFAULT_MASK_SIZE,
                    DEFAULT_MASK_SIZE,
                    0,
                ))
            } else {
                Err(format!("unsupported mask shape: {shape:?}, len={data_len}"))
            }
        }
    }
}

fn best_mask_candidate(outputs: &SessionOutputs<'_>, candidate_count: usize) -> usize {
    let Some(value) = outputs
        .get("iou_predictions")
        .or_else(|| outputs.get("iou_scores"))
    else {
        return 0;
    };
    let Ok((_shape, scores)) = value.try_extract_tensor::<f32>() else {
        return 0;
    };
    scores
        .iter()
        .take(candidate_count)
        .enumerate()
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn log_session_io(target: &str, session: &Session) {
    tracing::debug!(
        target: "edit.sam2",
        "{} inputs=[{}] outputs=[{}]",
        target,
        session
            .inputs()
            .iter()
            .map(|input| format!("{}:{:?}", input.name(), input.dtype().tensor_shape()))
            .collect::<Vec<_>>()
            .join(", "),
        session
            .outputs()
            .iter()
            .map(|output| format!("{}:{:?}", output.name(), output.dtype().tensor_shape()))
            .collect::<Vec<_>>()
            .join(", ")
    );
}
