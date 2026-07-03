use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use image::imageops::FilterType;
use image::{DynamicImage, Rgba, RgbaImage};
use serde::Deserialize;
use tauri::State;

use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PsdComposition {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<PsdLayerSpec>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PsdLayerSpec {
    Image {
        name: String,
        path: String,
        x: i32,
        y: i32,
        opacity: f32,
        width: Option<u32>,
        height: Option<u32>,
    },
    Text {
        name: String,
        text: String,
        font: String,
        size: f32,
        color: String,
        x: i32,
        y: i32,
    },
}

/// α版 PSD 出力。
///
/// Photoshop で再編集可能なレイヤー構造ではなく、全レイヤーを 1 枚に合成した
/// flattened RGB PSD として保存する。LayerComposer 側の PNG/JPG と同じ見た目を
/// PSD 拡張子で受け渡すための最小実装。
/// キャンバスの統合PNGを保存する。data_base64 はフロントの canvas.toDataURL 由来
/// (data: プレフィックスなしの base64 本体)。
#[tauri::command]
pub async fn edit_export_png(path: String, data_base64: String) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    if path.trim().is_empty() {
        return Err("保存先パスが空です".to_string());
    }
    let bytes = general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64 decode: {e}"))?;
    if bytes.is_empty() {
        return Err("書き出しデータが空です".to_string());
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("write png: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn edit_export_psd(
    state: State<'_, AppState>,
    composition: PsdComposition,
    output_path: String,
) -> Result<String, String> {
    let _ = state;

    if composition.width == 0 || composition.height == 0 {
        return Err("PSD のサイズが不正です。".to_string());
    }

    let mut canvas = RgbaImage::from_pixel(
        composition.width,
        composition.height,
        Rgba([16, 16, 16, 255]),
    );

    for layer in &composition.layers {
        match layer {
            PsdLayerSpec::Image {
                name: _name,
                path,
                x,
                y,
                opacity,
                width,
                height,
            } => {
                let image = image::ImageReader::open(path)
                    .map_err(|e| format!("画像を開けません: {path}: {e}"))?
                    .decode()
                    .map_err(|e| format!("画像をデコードできません: {path}: {e}"))?;
                let image = match (*width, *height) {
                    (Some(w), Some(h)) if w > 0 && h > 0 => {
                        image.resize_exact(w, h, FilterType::Triangle)
                    }
                    _ => image,
                };
                composite_image(&mut canvas, &image, *x, *y, opacity.clamp(0.0, 1.0));
            }
            PsdLayerSpec::Text {
                name,
                text,
                font,
                size,
                color,
                x,
                y,
            } => {
                // Rust 側にフォントレンダラを増やさない α版の代替。
                // テキスト内容を直接描画するのは v1.1 で対応し、ここでは
                // 位置確認用の薄いラベル矩形だけを焼き込む。
                let _ = (name, text, font);
                draw_text_placeholder(&mut canvas, *x, *y, *size, color);
            }
        }
    }

    let output = PathBuf::from(&output_path);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("出力ディレクトリを作成できません: {e}"))?;
    }

    write_flattened_rgb_psd(&canvas, &output)?;
    Ok(output.to_string_lossy().into_owned())
}

fn composite_image(
    canvas: &mut RgbaImage,
    image: &DynamicImage,
    offset_x: i32,
    offset_y: i32,
    opacity: f32,
) {
    let src = image.to_rgba8();
    let (cw, ch) = canvas.dimensions();
    for sy in 0..src.height() {
        let dy_i = offset_y + sy as i32;
        if dy_i < 0 || dy_i >= ch as i32 {
            continue;
        }
        for sx in 0..src.width() {
            let dx_i = offset_x + sx as i32;
            if dx_i < 0 || dx_i >= cw as i32 {
                continue;
            }
            let src_px = src.get_pixel(sx, sy).0;
            let alpha = (src_px[3] as f32 / 255.0) * opacity;
            if alpha <= 0.0 {
                continue;
            }
            let dst = canvas.get_pixel_mut(dx_i as u32, dy_i as u32);
            let dst_px = dst.0;
            let inv = 1.0 - alpha;
            *dst = Rgba([
                ((src_px[0] as f32 * alpha) + (dst_px[0] as f32 * inv)).round() as u8,
                ((src_px[1] as f32 * alpha) + (dst_px[1] as f32 * inv)).round() as u8,
                ((src_px[2] as f32 * alpha) + (dst_px[2] as f32 * inv)).round() as u8,
                255,
            ]);
        }
    }
}

fn draw_text_placeholder(canvas: &mut RgbaImage, x: i32, y: i32, size: f32, color: &str) {
    let rgba = parse_hex_color(color).unwrap_or([255, 255, 255, 180]);
    let width = (size.max(12.0) * 4.0).round() as i32;
    let height = (size.max(12.0) * 1.25).round() as i32;
    for yy in 0..height {
        let py = y + yy;
        if py < 0 || py >= canvas.height() as i32 {
            continue;
        }
        for xx in 0..width {
            let px = x + xx;
            if px < 0 || px >= canvas.width() as i32 {
                continue;
            }
            let border = yy < 2 || yy >= height - 2 || xx < 2 || xx >= width - 2;
            if !border && yy % 6 != 0 {
                continue;
            }
            let dst = canvas.get_pixel_mut(px as u32, py as u32);
            let a = rgba[3] as f32 / 255.0;
            let inv = 1.0 - a;
            let old = dst.0;
            *dst = Rgba([
                (rgba[0] as f32 * a + old[0] as f32 * inv).round() as u8,
                (rgba[1] as f32 * a + old[1] as f32 * inv).round() as u8,
                (rgba[2] as f32 * a + old[2] as f32 * inv).round() as u8,
                255,
            ]);
        }
    }
}

fn parse_hex_color(color: &str) -> Option<[u8; 4]> {
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 && hex.len() != 8 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    let a = if hex.len() == 8 {
        u8::from_str_radix(&hex[6..8], 16).ok()?
    } else {
        180
    };
    Some([r, g, b, a])
}

fn write_flattened_rgb_psd(image: &RgbaImage, output: &PathBuf) -> Result<(), String> {
    let file = File::create(output).map_err(|e| format!("PSD を作成できません: {e}"))?;
    let mut writer = BufWriter::new(file);
    let width = image.width();
    let height = image.height();

    writer.write_all(b"8BPS").map_err(|e| e.to_string())?;
    write_u16(&mut writer, 1)?; // version
    writer.write_all(&[0; 6]).map_err(|e| e.to_string())?;
    write_u16(&mut writer, 3)?; // RGB channels
    write_u32(&mut writer, height)?;
    write_u32(&mut writer, width)?;
    write_u16(&mut writer, 8)?; // bits/channel
    write_u16(&mut writer, 3)?; // RGB color mode

    write_u32(&mut writer, 0)?; // color mode data length
    write_u32(&mut writer, 0)?; // image resources length
    write_u32(&mut writer, 0)?; // layer/mask info length
    write_u16(&mut writer, 0)?; // raw image data

    for channel in 0..3 {
        for y in 0..height {
            for x in 0..width {
                writer
                    .write_all(&[image.get_pixel(x, y).0[channel]])
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())
}

fn write_u16(writer: &mut impl Write, value: u16) -> Result<(), String> {
    writer
        .write_all(&value.to_be_bytes())
        .map_err(|e| e.to_string())
}

fn write_u32(writer: &mut impl Write, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_be_bytes())
        .map_err(|e| e.to_string())
}
