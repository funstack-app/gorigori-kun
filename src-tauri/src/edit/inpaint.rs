use std::path::Path;

use image::{GenericImageView, ImageBuffer, Rgb};
use ort::value::Tensor;

use crate::edit::registry::find_model;
use crate::edit::runtime::EditRuntime;

const LAMA_SIZE: u32 = 512;

pub async fn inpaint_image(
    runtime: &EditRuntime,
    input_path: &Path,
    mask_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let img = image::open(input_path).map_err(|e| format!("open: {e}"))?;
    let mask = image::open(mask_path)
        .map_err(|e| format!("mask open: {e}"))?
        .to_luma8();
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("empty image".to_string());
    }

    let img_512 = img.resize_exact(LAMA_SIZE, LAMA_SIZE, image::imageops::FilterType::Lanczos3);
    let mask_512 = image::imageops::resize(
        &mask,
        LAMA_SIZE,
        LAMA_SIZE,
        image::imageops::FilterType::Nearest,
    );

    let rgb = img_512.to_rgb8();
    let plane = (LAMA_SIZE * LAMA_SIZE) as usize;
    let mut img_data = vec![0f32; plane * 3];
    let mut mask_data = vec![0f32; plane];

    for (i, p) in rgb.pixels().enumerate() {
        img_data[i] = p[0] as f32 / 255.0;
        img_data[plane + i] = p[1] as f32 / 255.0;
        img_data[plane * 2 + i] = p[2] as f32 / 255.0;
    }
    for (i, p) in mask_512.pixels().enumerate() {
        mask_data[i] = if p[0] > 127 { 1.0 } else { 0.0 };
    }

    let spec =
        find_model("lama-onnx").ok_or_else(|| "model spec not found: lama-onnx".to_string())?;
    let session = runtime.get_session(&spec).await?;
    let img_tensor = Tensor::<f32>::from_array((
        [1usize, 3, LAMA_SIZE as usize, LAMA_SIZE as usize],
        img_data,
    ))
    .map_err(|e| format!("image tensor: {e}"))?;
    let mask_tensor = Tensor::<f32>::from_array((
        [1usize, 1, LAMA_SIZE as usize, LAMA_SIZE as usize],
        mask_data,
    ))
    .map_err(|e| format!("mask tensor: {e}"))?;

    let mut session = session.lock().await;
    let outputs = session
        .run(ort::inputs![
            "image" => img_tensor,
            "mask" => mask_tensor,
        ])
        .map_err(|e| format!("lama run: {e}"))?;
    if outputs.len() == 0 {
        return Err("lama output is empty".to_string());
    }
    let (_shape, out_data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("lama output tensor: {e}"))?;
    if out_data.len() < plane * 3 {
        return Err(format!(
            "unexpected lama output len: {}, want >= {}",
            out_data.len(),
            plane * 3
        ));
    }

    let mut out_512 = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(LAMA_SIZE, LAMA_SIZE);
    for y in 0..LAMA_SIZE {
        for x in 0..LAMA_SIZE {
            let i = (y * LAMA_SIZE + x) as usize;
            out_512.put_pixel(
                x,
                y,
                Rgb([
                    to_u8(out_data[i]),
                    to_u8(out_data[plane + i]),
                    to_u8(out_data[plane * 2 + i]),
                ]),
            );
        }
    }

    let final_img = image::imageops::resize(
        &out_512,
        orig_w,
        orig_h,
        image::imageops::FilterType::Lanczos3,
    );
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    final_img
        .save(output_path)
        .map_err(|e| format!("save: {e}"))?;
    Ok(())
}

/// LaMa (Carve/LaMa-ONNX) の出力は **0..255 レンジの float** で返る (0..1 ではない)。
/// 実測: 入力を 0..1 正規化で流すと出力 RGB は範囲 [34, 234] / 平均 118 の 0..255 値になる
/// (2026-07-02 scale scan で確認)。
///
/// 旧実装は `v.clamp(0.0, 1.0) * 255.0` としており、出力が 0..1 だと誤仮定していた。
/// 実際は 0..255 なので clamp(0,1) が全画素を 1.0 に張り付かせ、×255 で **全面白 (255)** に
/// 破綻していた (text-removed.png が全面白になる実機バグの真因)。出力は 0..255 として
/// そのまま丸めるのが正しい。
fn to_u8(v: f32) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}
