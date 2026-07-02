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
    // 既定はマスク推論と前景合成を同じ画像で行う (単体切り抜きコマンド用)。
    segment_image_with_source(runtime, input_path, input_path, output_dir).await
}

/// マスク推論に使う画像 (`mask_source`) と、前景 RGBA の色を焼き込む画像
/// (`foreground_source`) を分離できる版。
///
/// なぜ分離が要るか: Magic Layer は OCR テキスト除去後の画像 (`text-removed.png`) を
/// セグメントに渡していたが、この画像は LaMa inpaint 経路で色が破綻しうる。前景レイヤーは
/// 「元写真の人物ピクセル + マスクを alpha にした RGBA」でなければならないので、RGB の出所は
/// **必ず元画像** にする。マスク側はテキスト除去済みでも元画像でもほぼ同じ結果になる
/// (テキスト領域は人物マスクにほぼ寄与しない) ため呼び出し側の選択に任せる。
///
/// 2026-07-02 実機バグ: foreground.png が白ベタ+反転色スペックルになる事故は、前景 RGB を
/// text-removed.png (破綻画像) から焼いていたことが真因。合成ロジック自体は正しい
/// (元画像 RGB + マスク alpha)。出所を元画像に戻すことで解消する。
pub async fn segment_image_with_source(
    runtime: &EditRuntime,
    mask_source: &Path,
    foreground_source: &Path,
    output_dir: &Path,
) -> Result<SegmentResult, String> {
    let spec = all_models()
        .into_iter()
        .find(|spec| spec.id == "birefnet-general")
        .ok_or_else(|| "BiRefNet model spec not found".to_string())?;
    let session = runtime.get_session(&spec).await?;

    let img = image::open(mask_source).map_err(|e| format!("image open: {e}"))?;
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
        if outputs.len() == 0 {
            return Err("segment output is empty".to_string());
        }
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

    // 前景 RGBA の色は **元写真** (foreground_source) から焼き込む。マスク推論に使う
    // mask_source (Magic Layer では text-removed.png) は inpaint で破綻しうるため、色の
    // 出所には使わない。mask_source と foreground_source が同一パスなら再ロードだけの無害動作。
    let fg_img = if foreground_source == mask_source {
        img.clone()
    } else {
        image::open(foreground_source).map_err(|e| format!("foreground image open: {e}"))?
    };
    let (fg_w, fg_h) = fg_img.dimensions();
    if fg_w != orig_w || fg_h != orig_h {
        return Err(format!(
            "foreground source size {fg_w}x{fg_h} != mask source size {orig_w}x{orig_h}"
        ));
    }
    let rgba = fg_img.to_rgba8();
    let foreground = composite_foreground(&rgba, &mask_resized);

    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(|e| format!("output dir: {e}"))?;
    let fg = output_dir.join("foreground.png");
    let bg_src = output_dir.join("background_src.png");
    let mask = output_dir.join("mask.png");

    foreground.save(&fg).map_err(|e| format!("save fg: {e}"))?;
    // background_src.png も元写真を残す (デバッグ/フォールバック用の下地)。
    fg_img
        .save(&bg_src)
        .map_err(|e| format!("save bg src: {e}"))?;
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

/// 前景 RGBA を合成する: 元画像の RGB をそのまま使い、マスクの値を alpha にする。
///
/// 正しい前景 = 「元画像の RGB + マスクを alpha にした RGBA」。RGB を書き換えたり
/// (白ベタ化)、チャネルを入れ替えたり (反転色) してはいけない。この純粋関数に切り出して
/// おくことで、白ベタ/反転色の退行を単体テストで機械検知する (2026-07-02 実機バグ対策)。
///
/// mask のサイズは rgba と同寸である前提 (呼び出し側で resize 済み)。ずれた場合は
/// 範囲外を alpha=0 (透明) 扱いにして panic を避ける。
fn composite_foreground(
    rgba: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    mask: &ImageBuffer<image::Luma<u8>, Vec<u8>>,
) -> ImageBuffer<Rgba<u8>, Vec<u8>> {
    let (w, h) = rgba.dimensions();
    let mut out = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(w, h);
    let (mw, mh) = mask.dimensions();
    for (x, y, p) in rgba.enumerate_pixels() {
        let alpha = if x < mw && y < mh {
            mask.get_pixel(x, y)[0]
        } else {
            0
        };
        out.put_pixel(x, y, Rgba([p[0], p[1], p[2], alpha]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Luma;

    /// 単色画像 + 単純マスクを合成し、前景 RGB が **元画像の色のまま** であること、
    /// alpha がマスク通りであることを assert する。白ベタ化 (RGB が 255,255,255 に化ける)
    /// やチャネル反転を機械検知する回帰テスト。
    #[test]
    fn composite_preserves_rgb_and_uses_mask_as_alpha() {
        // 元画像: 全面 (40, 80, 160) の単色 (白ではない = 白ベタ退行を検出できる色)。
        let w = 8u32;
        let h = 8u32;
        let src = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(w, h, Rgba([40, 80, 160, 255]));
        // マスク: 左半分だけ白 (255)、右半分は黒 (0)。
        let mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_fn(w, h, |x, _| {
            if x < w / 2 {
                Luma([255u8])
            } else {
                Luma([0u8])
            }
        });

        let fg = composite_foreground(&src, &mask);

        for y in 0..h {
            for x in 0..w {
                let px = fg.get_pixel(x, y);
                // RGB は元画像のまま (白ベタ化・チャネル反転していない)。
                assert_eq!(
                    [px[0], px[1], px[2]],
                    [40, 80, 160],
                    "RGB が元画像から変わった (白ベタ/反転の疑い) at ({x},{y}): {:?}",
                    px
                );
                // alpha はマスク通り。
                let expected_alpha = if x < w / 2 { 255 } else { 0 };
                assert_eq!(px[3], expected_alpha, "alpha がマスクと不一致 at ({x},{y})");
            }
        }
    }

    /// 白ベタ退行の直接検知: マスクが全面白でも、RGB が全ピクセル (255,255,255) になっては
    /// いけない (それは foreground が破綻画像から焼かれている症状)。
    #[test]
    fn composite_full_mask_is_not_white_flat() {
        let src = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_pixel(4, 4, Rgba([10, 20, 30, 255]));
        let mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(4, 4, Luma([255u8]));
        let fg = composite_foreground(&src, &mask);
        let all_white = fg.pixels().all(|p| p[0] == 255 && p[1] == 255 && p[2] == 255);
        assert!(!all_white, "前景が白ベタになった (破綻画像を焼いている)");
    }
}
