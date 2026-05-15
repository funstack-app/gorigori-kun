use std::path::{Path, PathBuf};

use image::{GenericImageView, ImageBuffer, Rgba};
use ort::value::Tensor;

use crate::edit::registry::all_models;
use crate::edit::runtime::EditRuntime;

const INPUT_SIZE: u32 = 1024;
const INPUT_PIXELS: usize = (INPUT_SIZE as usize) * (INPUT_SIZE as usize);

pub struct SegmentResult {
    pub mask: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub foreground_path: PathBuf,
    pub background_path: PathBuf,
    pub mask_path: PathBuf,
}

pub async fn segment_image(
    runtime: &EditRuntime,
    input_path: &Path,
    output_dir: &Path,
) -> Result<SegmentResult, String> {
    let spec = all_models()
        .into_iter()
        .find(|spec| spec.id == "birefnet-general")
        .ok_or_else(|| "BiRefNet model spec not found".to_string())?;
    let session = runtime.get_session(&spec).await?;

    let img = image::open(input_path).map_err(|e| format!("image open: {e}"))?;
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("image has zero width or height".to_string());
    }

    let resized = img.resize_exact(
        INPUT_SIZE,
        INPUT_SIZE,
        image::imageops::FilterType::Lanczos3,
    );
    let rgb = resized.to_rgb8();
    let mut input_data = vec![0f32; 3 * INPUT_PIXELS];
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    for (i, p) in rgb.pixels().enumerate() {
        input_data[i] = (p[0] as f32 / 255.0 - mean[0]) / std[0];
        input_data[INPUT_PIXELS + i] = (p[1] as f32 / 255.0 - mean[1]) / std[1];
        input_data[2 * INPUT_PIXELS + i] = (p[2] as f32 / 255.0 - mean[2]) / std[2];
    }

    let mask_1024 = {
        let input_tensor = Tensor::from_array((
            [1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
            input_data,
        ))
        .map_err(|e| format!("tensor: {e}"))?;

        let mut guard = session.lock().await;
        let outputs = guard
            .run(ort::inputs!["input_image" => input_tensor])
            .map_err(|e| format!("run: {e}"))?;
        let (_shape, mask_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract: {e}"))?;
        if mask_data.len() < INPUT_PIXELS {
            return Err(format!(
                "unexpected mask tensor size: {} (expected at least {})",
                mask_data.len(),
                INPUT_PIXELS
            ));
        }

        ImageBuffer::<image::Luma<u8>, Vec<u8>>::from_fn(INPUT_SIZE, INPUT_SIZE, |x, y| {
            let idx = y as usize * INPUT_SIZE as usize + x as usize;
            let raw = mask_data[idx];
            let v = (sigmoid(raw) * 255.0).clamp(0.0, 255.0).round() as u8;
            image::Luma([v])
        })
    };

    let mask_resized = image::imageops::resize(
        &mask_1024,
        orig_w,
        orig_h,
        image::imageops::FilterType::Lanczos3,
    );

    let rgba = img.to_rgba8();
    let mut foreground = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(orig_w, orig_h);
    for (x, y, p) in rgba.enumerate_pixels() {
        let alpha = mask_resized.get_pixel(x, y)[0];
        foreground.put_pixel(x, y, Rgba([p[0], p[1], p[2], alpha]));
    }

    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(|e| format!("output dir: {e}"))?;
    let fg = output_dir.join("foreground.png");
    let bg_src = output_dir.join("background_src.png");
    let mask = output_dir.join("mask.png");

    foreground.save(&fg).map_err(|e| format!("save fg: {e}"))?;
    img.save(&bg_src).map_err(|e| format!("save bg src: {e}"))?;
    mask_resized
        .save(&mask)
        .map_err(|e| format!("save mask: {e}"))?;

    Ok(SegmentResult {
        mask: mask_resized.into_raw(),
        width: orig_w,
        height: orig_h,
        foreground_path: fg,
        background_path: bg_src,
        mask_path: mask,
    })
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}
