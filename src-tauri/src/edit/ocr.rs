use std::collections::VecDeque;
use std::path::Path;

use image::{DynamicImage, GenericImageView};
use ort::value::Tensor;
use serde::Serialize;

use crate::edit::registry::find_model;
use crate::edit::runtime::EditRuntime;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextRegion {
    pub id: String,
    pub bbox: [i32; 4],
    pub polygon: Vec<[i32; 2]>,
    pub text: String,
    pub confidence: f32,
    pub language: Option<String>,
}

#[derive(Debug, Clone)]
struct Polygon {
    points: [[i32; 2]; 4],
    score: f32,
}

pub async fn ocr_image(
    runtime: &EditRuntime,
    input_path: &Path,
) -> Result<Vec<TextRegion>, String> {
    let img = image::open(input_path).map_err(|e| format!("open: {e}"))?;

    let det_spec = find_model("paddleocr-mobile-det")
        .ok_or_else(|| "model spec not found: paddleocr-mobile-det".to_string())?;
    let det_session = runtime.get_session(&det_spec).await?;
    let polygons = {
        let mut session = det_session.lock().await;
        run_paddleocr_detection(&mut session, &img)?
    };

    let rec_spec = find_model("paddleocr-mobile-rec")
        .ok_or_else(|| "model spec not found: paddleocr-mobile-rec".to_string())?;
    let rec_session = runtime.get_session(&rec_spec).await?;

    let mut regions = Vec::new();
    let mut session = rec_session.lock().await;
    for (i, poly) in polygons.iter().enumerate() {
        let bbox = bbox_from_polygon(&poly.points, img.dimensions());
        if bbox[2] <= 0 || bbox[3] <= 0 {
            continue;
        }
        let crop = crop_axis_aligned(&img, bbox)?;
        let (text, rec_conf) = run_paddleocr_recognition(&mut session, &crop)?;
        let confidence = if rec_conf > 0.0 {
            (rec_conf * poly.score).clamp(0.0, 1.0)
        } else {
            poly.score.clamp(0.0, 1.0)
        };
        let language = detect_language_from_text(&text);
        regions.push(TextRegion {
            id: format!("region-{i:04}"),
            bbox,
            polygon: poly.points.to_vec(),
            text,
            confidence,
            language,
        });
    }

    Ok(regions)
}

fn run_paddleocr_detection(
    session: &mut ort::session::Session,
    img: &DynamicImage,
) -> Result<Vec<Polygon>, String> {
    let prepared = prepare_detection_input(img)?;
    let tensor = Tensor::<f32>::from_array((
        [1usize, 3, prepared.height as usize, prepared.width as usize],
        prepared.data,
    ))
    .map_err(|e| format!("det tensor: {e}"))?;

    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("det run: {e}"))?;
    if outputs.len() == 0 {
        return Err("det output is empty".to_string());
    }
    let (shape, heatmap) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("det output tensor: {e}"))?;
    let (map_w, map_h) = heatmap_hw(shape)?;
    let polygons = polygons_from_heatmap(
        heatmap,
        map_w,
        map_h,
        prepared.width,
        prepared.height,
        prepared.scale,
        img.dimensions(),
    );
    Ok(polygons)
}

struct PreparedInput {
    data: Vec<f32>,
    width: u32,
    height: u32,
    scale: f32,
}

fn prepare_detection_input(img: &DynamicImage) -> Result<PreparedInput, String> {
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("empty image".to_string());
    }
    let max_side = 960.0f32;
    let scale = (max_side / orig_w.max(orig_h) as f32).min(1.0);
    let resized_w = ((orig_w as f32 * scale).round() as u32).max(32);
    let resized_h = ((orig_h as f32 * scale).round() as u32).max(32);
    let padded_w = resized_w.div_ceil(32) * 32;
    let padded_h = resized_h.div_ceil(32) * 32;

    let resized = img.resize_exact(resized_w, resized_h, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();
    let plane = (padded_w * padded_h) as usize;
    let mut data = vec![0f32; plane * 3];
    for y in 0..resized_h {
        for x in 0..resized_w {
            let p = rgb.get_pixel(x, y);
            let idx = (y * padded_w + x) as usize;
            data[idx] = p[0] as f32 / 255.0;
            data[plane + idx] = p[1] as f32 / 255.0;
            data[plane * 2 + idx] = p[2] as f32 / 255.0;
        }
    }

    Ok(PreparedInput {
        data,
        width: padded_w,
        height: padded_h,
        scale,
    })
}

fn heatmap_hw(shape: &[i64]) -> Result<(usize, usize), String> {
    if shape.len() < 2 {
        return Err(format!("unexpected det shape: {shape:?}"));
    }
    let h = *shape
        .get(shape.len().saturating_sub(2))
        .ok_or_else(|| format!("unexpected det shape: {shape:?}"))?;
    let w = *shape
        .get(shape.len().saturating_sub(1))
        .ok_or_else(|| format!("unexpected det shape: {shape:?}"))?;
    if h <= 0 || w <= 0 {
        return Err(format!("invalid det shape: {shape:?}"));
    }
    Ok((w as usize, h as usize))
}

fn polygons_from_heatmap(
    heatmap: &[f32],
    map_w: usize,
    map_h: usize,
    input_w: u32,
    input_h: u32,
    scale: f32,
    (orig_w, orig_h): (u32, u32),
) -> Vec<Polygon> {
    if map_w == 0 || map_h == 0 || heatmap.is_empty() {
        return Vec::new();
    }
    let plane_len = map_w * map_h;
    let offset = heatmap.len().saturating_sub(plane_len);
    let heat = &heatmap[offset..];
    let threshold = 0.30f32;
    let min_area = 12usize;
    let mut visited = vec![false; plane_len];
    let mut polys = Vec::new();

    for start in 0..plane_len {
        if visited[start] || heat[start] < threshold {
            continue;
        }
        visited[start] = true;
        let mut q = VecDeque::from([start]);
        let mut min_x = map_w;
        let mut min_y = map_h;
        let mut max_x = 0usize;
        let mut max_y = 0usize;
        let mut count = 0usize;
        let mut score_sum = 0.0f32;

        while let Some(idx) = q.pop_front() {
            let x = idx % map_w;
            let y = idx / map_w;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            count += 1;
            score_sum += heat[idx].clamp(0.0, 1.0);

            let y0 = y.saturating_sub(1);
            let y1 = (y + 1).min(map_h - 1);
            let x0 = x.saturating_sub(1);
            let x1 = (x + 1).min(map_w - 1);
            for ny in y0..=y1 {
                for nx in x0..=x1 {
                    let nidx = ny * map_w + nx;
                    if !visited[nidx] && heat[nidx] >= threshold {
                        visited[nidx] = true;
                        q.push_back(nidx);
                    }
                }
            }
        }

        if count < min_area {
            continue;
        }
        let score = score_sum / count as f32;
        let pad = 2.0f32;
        let sx = input_w as f32 / map_w as f32;
        let sy = input_h as f32 / map_h as f32;
        let to_orig = |x: f32, y: f32| -> [i32; 2] {
            let ox = (x * sx / scale)
                .round()
                .clamp(0.0, orig_w.saturating_sub(1) as f32);
            let oy = (y * sy / scale)
                .round()
                .clamp(0.0, orig_h.saturating_sub(1) as f32);
            [ox as i32, oy as i32]
        };
        let left = (min_x as f32 - pad).max(0.0);
        let top = (min_y as f32 - pad).max(0.0);
        let right = (max_x as f32 + 1.0 + pad).min(map_w as f32);
        let bottom = (max_y as f32 + 1.0 + pad).min(map_h as f32);
        let points = [
            to_orig(left, top),
            to_orig(right, top),
            to_orig(right, bottom),
            to_orig(left, bottom),
        ];
        let bbox = bbox_from_polygon(&points, (orig_w, orig_h));
        if bbox[2] >= 4 && bbox[3] >= 4 {
            polys.push(Polygon { points, score });
        }
    }

    polys.sort_by_key(|poly| {
        let b = bbox_from_polygon(&poly.points, (orig_w, orig_h));
        (b[1], b[0])
    });
    polys.truncate(128);
    polys
}

fn run_paddleocr_recognition(
    session: &mut ort::session::Session,
    crop: &DynamicImage,
) -> Result<(String, f32), String> {
    let (data, width) = prepare_recognition_input(crop)?;
    let tensor = Tensor::<f32>::from_array(([1usize, 3, 48usize, width as usize], data))
        .map_err(|e| format!("rec tensor: {e}"))?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|e| format!("rec run: {e}"))?;
    if outputs.len() == 0 {
        return Err("rec output is empty".to_string());
    }
    let (shape, logits) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("rec output tensor: {e}"))?;
    Ok(decode_ctc(shape, logits))
}

fn prepare_recognition_input(crop: &DynamicImage) -> Result<(Vec<f32>, u32), String> {
    let (w, h) = crop.dimensions();
    if w == 0 || h == 0 {
        return Err("empty crop".to_string());
    }
    let height = 48u32;
    let scaled_w = ((w as f32 * height as f32 / h as f32).round() as u32).clamp(16, 320);
    let padded_w = scaled_w.div_ceil(32) * 32;
    let resized = crop.resize_exact(scaled_w, height, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();
    let plane = (height * padded_w) as usize;
    let mut data = vec![0f32; plane * 3];
    for y in 0..height {
        for x in 0..scaled_w {
            let p = rgb.get_pixel(x, y);
            let idx = (y * padded_w + x) as usize;
            data[idx] = p[0] as f32 / 255.0;
            data[plane + idx] = p[1] as f32 / 255.0;
            data[plane * 2 + idx] = p[2] as f32 / 255.0;
        }
    }
    Ok((data, padded_w))
}

fn decode_ctc(shape: &[i64], logits: &[f32]) -> (String, f32) {
    if shape.len() < 2 || logits.is_empty() {
        return (String::new(), 0.0);
    }
    let classes = *shape.last().unwrap_or(&0);
    if classes <= 1 {
        return (String::new(), 0.0);
    }
    let classes = classes as usize;
    let steps = logits.len() / classes;
    let charset = ocr_charset();
    let mut prev = usize::MAX;
    let mut chars = String::new();
    let mut conf_sum = 0.0f32;
    let mut conf_count = 0usize;

    for t in 0..steps {
        let row = &logits[t * classes..(t + 1) * classes];
        let (idx, max_val) = row
            .iter()
            .copied()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or((0, 0.0));
        if idx != 0 && idx != prev {
            if let Some(ch) = charset.get(idx - 1) {
                chars.push(*ch);
            } else {
                chars.push('□');
            }
            conf_sum += softmax_prob(row, idx, max_val);
            conf_count += 1;
        }
        prev = idx;
    }

    let conf = if conf_count > 0 {
        conf_sum / conf_count as f32
    } else {
        0.0
    };
    (chars, conf.clamp(0.0, 1.0))
}

fn softmax_prob(row: &[f32], idx: usize, max_val: f32) -> f32 {
    let denom: f32 = row.iter().map(|v| (*v - max_val).exp()).sum();
    if denom <= f32::EPSILON {
        return 0.0;
    }
    ((row[idx] - max_val).exp() / denom).clamp(0.0, 1.0)
}

fn ocr_charset() -> Vec<char> {
    // PaddleOCRの辞書はモデルごとに異なるため、α版では代表的な文字だけを内蔵する。
    // 未対応のクラスは '□' として残し、Phase 4以降でモデル辞書ファイル対応へ拡張する。
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ¥。、，．・：；？！ー〜…（）［］「」『』【】abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわをんァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヲンヴ一二三四五六七八九十百千万年月日時分秒円人大小中上下左右前後会社商品無料限定新発売予約受付価格税込".chars().collect()
}

fn bbox_from_polygon(points: &[[i32; 2]; 4], (orig_w, orig_h): (u32, u32)) -> [i32; 4] {
    let min_x = points.iter().map(|p| p[0]).min().unwrap_or(0).max(0);
    let min_y = points.iter().map(|p| p[1]).min().unwrap_or(0).max(0);
    let max_x = points
        .iter()
        .map(|p| p[0])
        .max()
        .unwrap_or(0)
        .min(orig_w.saturating_sub(1) as i32);
    let max_y = points
        .iter()
        .map(|p| p[1])
        .max()
        .unwrap_or(0)
        .min(orig_h.saturating_sub(1) as i32);
    [min_x, min_y, (max_x - min_x).max(0), (max_y - min_y).max(0)]
}

fn crop_axis_aligned(img: &DynamicImage, bbox: [i32; 4]) -> Result<DynamicImage, String> {
    let (orig_w, orig_h) = img.dimensions();
    let x = bbox[0].max(0) as u32;
    let y = bbox[1].max(0) as u32;
    let w = (bbox[2].max(1) as u32).min(orig_w.saturating_sub(x));
    let h = (bbox[3].max(1) as u32).min(orig_h.saturating_sub(y));
    if w == 0 || h == 0 {
        return Err("invalid crop".to_string());
    }
    Ok(img.crop_imm(x, y, w, h))
}

fn detect_language_from_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let ascii = trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .count();
    let total = trimmed
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .count()
        .max(1);
    if ascii * 2 >= total {
        Some("en".to_string())
    } else {
        Some("ja".to_string())
    }
}
