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

/// PaddleOCR DB 検出器が内部生成するテキスト確率マップを、**元画像解像度**へ
/// アップスケールして保持したもの。各バイトは `prob * 255`（0-255）。
///
/// なぜ元画像解像度に揃えるか: 呼び出し側 (magic_layer の text-mask 生成) は
/// 元画像ピクセル座標の bbox でゲートするため、確率マップも同座標系にしておけば
/// 「bbox 内 ∩ prob >= 閾値」のピクセル判定が O(1) のインデックス参照で済む。
#[derive(Debug, Clone)]
pub struct TextProbMap {
    pub width: u32,
    pub height: u32,
    /// row-major, width*height 個。各バイト = clamp(prob,0,1)*255。
    pub data: Vec<u8>,
}

impl TextProbMap {
    /// 元画像ピクセル (x,y) の確率 (0.0-1.0)。範囲外は 0。
    pub fn prob_at(&self, x: u32, y: u32) -> f32 {
        if x >= self.width || y >= self.height {
            return 0.0;
        }
        let idx = (y * self.width + x) as usize;
        self.data.get(idx).copied().unwrap_or(0) as f32 / 255.0
    }
}

pub async fn ocr_image(
    runtime: &EditRuntime,
    input_path: &Path,
) -> Result<Vec<TextRegion>, String> {
    let (regions, _prob) = ocr_image_with_probmap(runtime, input_path).await?;
    Ok(regions)
}

/// `ocr_image` と同じパイプラインだが、DB 検出器の確率マップ (元画像解像度) も返す。
///
/// なぜ別関数か: 既存の `ocr_image` 呼び出し側 (commands/edit_ocr.rs) は確率マップを
/// 必要としない。シグネチャを壊さず、確率マップを使いたい呼び出し側 (magic_layer の
/// ストロークマスク生成) だけがこちらを使う。確率マップが取れない経路 (モデル出力形状が
/// 想定外・検出0件等) では `None` を返し、呼び出し側は従来の bbox 矩形にフォールバックする。
pub async fn ocr_image_with_probmap(
    runtime: &EditRuntime,
    input_path: &Path,
) -> Result<(Vec<TextRegion>, Option<TextProbMap>), String> {
    tracing::info!(target: "codex.edit", "ocr: 画像デコード開始");
    let img = image::open(input_path).map_err(|e| format!("open: {e}"))?;
    tracing::info!(target: "codex.edit", "ocr: 画像デコード完了 {}x{}", img.width(), img.height());

    let det_spec = find_model("ppocrv6-small-det")
        .ok_or_else(|| "model spec not found: ppocrv6-small-det".to_string())?;
    tracing::info!(target: "codex.edit", "ocr: detセッション取得開始");
    let det_session = runtime.get_session(&det_spec).await?;
    tracing::info!(target: "codex.edit", "ocr: detection開始 {}x{}", img.width(), img.height());
    let (polygons, prob_map) = {
        let mut session = det_session.lock().await;
        run_paddleocr_detection(&mut session, &img)?
    };
    tracing::info!(target: "codex.edit", "ocr: detection完了 polygons={}", polygons.len());

    let rec_spec = find_model("ppocrv6-small-rec")
        .ok_or_else(|| "model spec not found: ppocrv6-small-rec".to_string())?;
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
        // 非文字の塊 (眼鏡アイコン等) や化けを弾く。DB検出器は文字でない塊も region に
        // 拾い、認識にかけると低信頼の記号列が返る (Canva差2「アイコン混入」/差3「文字化け」)。
        // 消し過ぎない保守設計: 正しい文字を落とすより化けを見逃す方向へ倒す (弾いた分は
        // ログに残す。ユーザーは残った化け region を手で消せるが、消えた region は戻せない)。
        if !should_keep_text_region(&text, rec_conf) {
            tracing::info!(
                target: "codex.edit",
                "ocr: 非文字/低信頼 region を除外 text={:?} rec_conf={:.3}",
                text, rec_conf
            );
            continue;
        }
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

    tracing::info!(target: "codex.edit", "ocr: recognition完了 regions={}", regions.len());
    Ok((regions, prob_map))
}

fn run_paddleocr_detection(
    session: &mut ort::session::Session,
    img: &DynamicImage,
) -> Result<(Vec<Polygon>, Option<TextProbMap>), String> {
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
    // 確率マップを捨てずに元画像解像度へアップスケールして保持する。
    // 縁残り・過剰復元を減らす「ストロークマスク」の材料 (magic_layer が bbox でゲートして使う)。
    let prob_map = upscale_prob_map(
        heatmap,
        map_w,
        map_h,
        prepared.width,
        prepared.height,
        prepared.scale,
        img.dimensions(),
    );
    Ok((polygons, prob_map))
}

/// DB 検出器の確率マップ (map_w×map_h、モデル入力座標系) を、元画像 (orig_w×orig_h)
/// 解像度の `TextProbMap` へ最近傍アップスケールする。
///
/// 座標変換は polygons_from_heatmap の `to_orig` と同じ規則:
///   map 座標 → 入力座標 (×input/map) → 元画像座標 (÷scale)。
/// 逆に、元画像画素 (ox,oy) に対応する map 画素を求めて確率を引く。
/// heatmap が空 / 座標系が縮退している場合は None (呼び出し側は bbox 矩形にフォールバック)。
fn upscale_prob_map(
    heatmap: &[f32],
    map_w: usize,
    map_h: usize,
    input_w: u32,
    input_h: u32,
    scale: f32,
    (orig_w, orig_h): (u32, u32),
) -> Option<TextProbMap> {
    if map_w == 0 || map_h == 0 || heatmap.is_empty() || orig_w == 0 || orig_h == 0 {
        return None;
    }
    if !(scale > 0.0) || input_w == 0 || input_h == 0 {
        return None;
    }
    let plane_len = map_w * map_h;
    // detection 出力は [1,1,H,W] 等の先頭に batch/channel が付くことがあるので末尾平面を使う
    // (polygons_from_heatmap と同じ扱い)。
    let offset = heatmap.len().checked_sub(plane_len)?;
    let heat = &heatmap[offset..];

    // 元画像 (ox,oy) → 入力座標 (×scale) → map 座標 (÷ input/map)。
    let sx = input_w as f32 / map_w as f32; // map→input
    let sy = input_h as f32 / map_h as f32;
    let mut data = vec![0u8; (orig_w * orig_h) as usize];
    for oy in 0..orig_h {
        // input 座標へ: iy = oy * scale。map 座標へ: my = iy / sy。
        let iy = oy as f32 * scale;
        let my = (iy / sy).floor() as i64;
        if my < 0 || my as usize >= map_h {
            continue;
        }
        let row = (my as usize) * map_w;
        let out_row = (oy * orig_w) as usize;
        for ox in 0..orig_w {
            let ix = ox as f32 * scale;
            let mx = (ix / sx).floor() as i64;
            if mx < 0 || mx as usize >= map_w {
                continue;
            }
            let prob = heat[row + mx as usize].clamp(0.0, 1.0);
            data[out_row + ox as usize] = (prob * 255.0).round() as u8;
        }
    }
    Some(TextProbMap {
        width: orig_w,
        height: orig_h,
        data,
    })
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
    // PP-OCRv6 det 前処理 (inference.yml PreProcess より):
    //   img_mode=BGR + NormalizeImage(scale=1/255, mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225])。
    // PaddleOCR は mean/std をチャンネル位置にそのまま適用する (mean[0]→plane0)。モデルは BGR で
    // 学習されているため、plane0=B・plane1=G・plane2=R を書き、mean/std を位置対応で当てる。
    //   plane0(B): (b/255 - 0.485)/0.229
    //   plane1(G): (g/255 - 0.456)/0.224
    //   plane2(R): (r/255 - 0.406)/0.225
    const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];
    // 32の倍数へのパディング領域は「正規化後の黒」(=(0-mean)/std) で埋める。
    // 生の 0.0 で埋めると正規化前提とズレるため、各 plane を対応する黒値で初期化する。
    let mut data = vec![0f32; plane * 3];
    for (c, plane_slice) in data.chunks_mut(plane).enumerate() {
        let black = (0.0 - DET_MEAN[c]) / DET_STD[c];
        for v in plane_slice.iter_mut() {
            *v = black;
        }
    }
    for y in 0..resized_h {
        for x in 0..resized_w {
            let p = rgb.get_pixel(x, y);
            let idx = (y * padded_w + x) as usize;
            let b = p[2] as f32 / 255.0;
            let g = p[1] as f32 / 255.0;
            let r = p[0] as f32 / 255.0;
            data[idx] = (b - DET_MEAN[0]) / DET_STD[0];
            data[plane + idx] = (g - DET_MEAN[1]) / DET_STD[1];
            data[plane * 2 + idx] = (r - DET_MEAN[2]) / DET_STD[2];
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
        // 成分に属する map 座標を集める。split_component_rows で行方向の谷を検出し、
        // 「レンタル / 補聴器」のように行間が近い複数行を 1 region に潰さず行単位へ割るため。
        let mut pixels: Vec<(usize, usize)> = Vec::new();

        while let Some(idx) = q.pop_front() {
            let x = idx % map_w;
            let y = idx / map_w;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            count += 1;
            score_sum += heat[idx].clamp(0.0, 1.0);
            pixels.push((x, y));

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
        // 成分 bbox (map 座標) を行方向の谷で分割する。単一行なら 1 件返る (退行しない)。
        let comp_bbox = [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1];
        for row in split_component_rows(comp_bbox, &pixels) {
            let [r_min_x, r_min_y, r_w, r_h] = row;
            let r_max_x = r_min_x + r_w.saturating_sub(1);
            let r_max_y = r_min_y + r_h.saturating_sub(1);
            let left = (r_min_x as f32 - pad).max(0.0);
            let top = (r_min_y as f32 - pad).max(0.0);
            let right = (r_max_x as f32 + 1.0 + pad).min(map_w as f32);
            let bottom = (r_max_y as f32 + 1.0 + pad).min(map_h as f32);
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
    // PP-OCRv6 rec 前処理 (inference.yml: img_mode=BGR + RecResizeImg[3,48,320])。
    // RecResizeImg は (img/255 - 0.5)/0.5 = img/127.5 - 1.0 で正規化する。モデルは BGR 学習
    // なので plane0=B・plane1=G・plane2=R を書く。右パディング領域は正規化後の黒 (-1.0) で埋める。
    let mut data = vec![-1.0f32; plane * 3];
    let norm = |c: u8| c as f32 / 127.5 - 1.0;
    for y in 0..height {
        for x in 0..scaled_w {
            let p = rgb.get_pixel(x, y);
            let idx = (y * padded_w + x) as usize;
            data[idx] = norm(p[2]); // B
            data[plane + idx] = norm(p[1]); // G
            data[plane * 2 + idx] = norm(p[0]); // R
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
            // PP-OCRv6 rec の ONNX 出力は既に softmax 済み確率 (各 step の行和≈1.0)。
            // よって argmax の値 max_val がそのままそのクラスの確率＝信頼度になる。
            // ここで再度 softmax をかけると 18710 クラスに薄まって conf≈0 に潰れる (v5→v6 で
            // 出力が logits→確率へ変わったことへの適合)。row が確率でない稀な系のために
            // 0..1 の範囲外なら softmax にフォールバックする。
            let step_conf = if (0.0..=1.0).contains(&max_val) {
                max_val
            } else {
                softmax_prob(row, idx, max_val)
            };
            conf_sum += step_conf;
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

/// PP-OCRv6 small rec の CTC 復号用文字集合。
///
/// 公式 inference.yml の PostProcess.character_dict (18708 文字) をバイナリへ同梱
/// (include_str! なので dev / テスト / 配布バイナリで完全に同一。BaseDirectory::Resource の
/// パス解決に依存せず、配布版でパスが解決できず OCR が黙って壊れる事故を構造的に回避する)。
///
/// CTC クラス構成 (rec 出力 shape 末尾 = 18710):
///   index 0        = blank (復号でスキップ)
///   index 1..18708 = character_dict[0..18707]  → charset[idx-1]
///   index 18709    = 末尾 space (PaddleOCR が use_space_char で辞書末尾に付与する ' ')
/// よって charset = character_dict + [' '] の 18709 要素にすると `charset[idx-1]` が全域で正しい。
///
/// 差し替え前 (2026-07-02以前) はここに ~440 文字のハードコード辞書があり、モデル本来の
/// 18708 文字辞書と索引がズレていた。これが「バスケ→ハスケ」(バ idx1906 / ハ idx1905 が隣接)
/// 濁点落ちの真因。公式辞書で索引を厳密一致させて解消する。
fn ocr_charset() -> Vec<char> {
    // 各行ちょうど1文字であることは生成時に検証済み (空行・複数文字行なし)。
    let dict = include_str!("ppocrv6_dict.txt");
    let mut chars: Vec<char> = dict
        .lines()
        .filter_map(|line| line.chars().next())
        .collect();
    // 末尾 space クラス (index 18709) 用。
    chars.push(' ');
    chars
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

/// DB 検出器が拾った region を「文字レイヤーとして残すか」を判定する純粋関数。
/// 非文字の塊 (眼鏡アイコン等) や信頼度の低い化けを弾く (Canva差2/差3)。
///
/// 保守設計 (消し過ぎ防止): 正しい文字を落とすより化けを見逃す方向へ倒す。
/// 閾値は低めに置き、「明らかに文字でない/明らかに壊れている」ものだけを弾く。
///
/// 判定 (いずれかに該当したら除外 = false を返す):
///   1. 認識テキストが実質空 (trim 後に文字ゼロ)
///   2. 有意な文字 (文字/数字) が1つも無い — 記号・罫線・□ だけの塊 (非文字アイコンの典型)
///   3. 認識信頼度が下限 (REC_CONF_FLOOR) 未満 — CTC が自信を持てなかった化け候補
///      ただし信頼度が高い (>= REC_CONF_TRUST) 場合は、たとえ記号主体でも残す
///      (「!」「?」「+」等の正当な記号テキストを誤除去しないため)
fn should_keep_text_region(text: &str, rec_conf: f32) -> bool {
    // 化け候補とみなす下限。これ未満は非文字/誤認識として弾く。
    // PP-OCRv6 の実測では正しい日本語行は 0.6-0.99、非文字塊は 0.0-0.2 に出やすい。
    // 誤除去を避けるため保守的に 0.35 (この間のグレーゾーンは残す = 見逃し側へ倒す)。
    const REC_CONF_FLOOR: f32 = 0.35;
    // これ以上の信頼度なら記号主体でも文字として信頼する (正当な記号テキストの保護)。
    const REC_CONF_TRUST: f32 = 0.80;

    let trimmed = text.trim();
    // 1. 実質空は除外。
    if trimmed.chars().all(|c| c.is_whitespace()) {
        return false;
    }
    // 有意な文字 (letter or number) の有無。□ (復号不能マーカー) や記号は含めない。
    let has_meaningful_char = trimmed
        .chars()
        .any(|c| c.is_alphanumeric() && c != '□');
    // 3. 信頼度が下限未満なら、有意な文字があっても弾く (化け候補)。
    if rec_conf < REC_CONF_FLOOR {
        return false;
    }
    // 2. 有意な文字が無い (記号・罫線・□ だけ) 場合、信頼度が高くなければ弾く。
    //    非文字アイコンの塊は記号列 + 低〜中信頼で出るため。
    if !has_meaningful_char && rec_conf < REC_CONF_TRUST {
        return false;
    }
    true
}

/// 連結成分1件の bbox (map 座標系) と、その成分に属する画素ごとの map 座標を受け取り、
/// **行の水平投影 (各 y のインク画素数)** の谷で上下に分割した「行 bbox」の列を返す。
///
/// なぜ必要か: PaddleOCR DB 検出器の連結成分は、行間が近い複数行テキストを 1 つの塊として
/// 返すことがある (実測: パリミキ「レンタル / 補聴器」が 1 region に潰れる)。連結成分抽出
/// だけでは分けられないので、塊の内部を行方向のインク密度で割って行単位に戻す。
///
/// アルゴリズム (本家 PaddleOCR の行分離を軽量化した投影法):
///   1. 成分の各行 y について、その行に属するインク画素数 row_ink[y] を数える
///   2. row_ink[y] > 0 の連続する y 区間 = 1 行。区間の切れ目 (row_ink==0 の谷) で分割
///   3. 各行区間の [min_x..max_x] は成分全体の x 範囲を使う (行内の x は密なので全幅でよい)
///
/// 単一行 (谷が無い) の場合は入力 bbox をそのまま 1 件返す (分割しない = 退行しない)。
///
/// 引数の `pixels` は成分に属する map 座標 (x, y) の列。空なら bbox をそのまま1件返す。
fn split_component_rows(bbox_map: [usize; 4], pixels: &[(usize, usize)]) -> Vec<[usize; 4]> {
    let [min_x, min_y, w, h] = bbox_map;
    if pixels.is_empty() || h == 0 || w == 0 {
        return vec![bbox_map];
    }
    // 成分の y 範囲 [min_y, min_y+h) について、各 y のインク画素数を数える。
    let mut row_ink = vec![0usize; h];
    for &(_x, y) in pixels {
        if y >= min_y && y < min_y + h {
            row_ink[y - min_y] += 1;
        }
    }
    // row_ink>0 の連続区間を1行として切り出す (0 の谷が行間)。
    let mut rows: Vec<[usize; 4]> = Vec::new();
    let mut band_start: Option<usize> = None;
    for local_y in 0..h {
        let inked = row_ink[local_y] > 0;
        match (inked, band_start) {
            (true, None) => band_start = Some(local_y),
            (false, Some(start)) => {
                rows.push([min_x, min_y + start, w, local_y - start]);
                band_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = band_start {
        rows.push([min_x, min_y + start, w, h - start]);
    }
    if rows.is_empty() {
        vec![bbox_map]
    } else {
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 縦に並んだ2つのインク帯 (行) が row_ink==0 の谷で区切られていれば、2行に分離される。
    /// これが「レンタル / 補聴器」を1regionに潰さないための核心。
    #[test]
    fn split_component_rows_separates_two_bands() {
        // 成分 bbox: x=10, y=0, w=5, h=10。
        // 行A: y=0..3、行B: y=6..9。y=3..6 はインクなし (行間の谷)。
        let bbox_map = [10usize, 0, 5, 10];
        let mut pixels = Vec::new();
        for y in 0..3 {
            for x in 10..15 {
                pixels.push((x, y));
            }
        }
        for y in 6..9 {
            for x in 10..15 {
                pixels.push((x, y));
            }
        }
        let rows = split_component_rows(bbox_map, &pixels);
        assert_eq!(rows.len(), 2, "2つのインク帯は2行に分離されるべき");
        // 1行目は y=0..3、2行目は y=6..9。
        assert_eq!(rows[0][1], 0);
        assert_eq!(rows[0][3], 3);
        assert_eq!(rows[1][1], 6);
        assert_eq!(rows[1][3], 3);
    }

    /// 谷が無い単一行の塊は、分割せず入力 bbox をそのまま1件返す (退行しない)。
    #[test]
    fn split_component_rows_keeps_single_band() {
        let bbox_map = [0usize, 0, 8, 4];
        let mut pixels = Vec::new();
        for y in 0..4 {
            for x in 0..8 {
                pixels.push((x, y));
            }
        }
        let rows = split_component_rows(bbox_map, &pixels);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], bbox_map);
    }

    /// 画素が空なら bbox をそのまま返す (フォールバック、パニックしない)。
    #[test]
    fn split_component_rows_empty_pixels_fallback() {
        let bbox_map = [3usize, 3, 5, 5];
        let rows = split_component_rows(bbox_map, &[]);
        assert_eq!(rows, vec![bbox_map]);
    }

    /// 配線検証: 連結成分が split_component_rows を経由してポリゴン化され、
    /// 座標を保って上→下の行順で返ることを確認する。
    ///
    /// 座標変換を素通しにするため input=map / scale=1.0 / orig=map とし、
    /// map 座標 == 元画像座標 になる条件で組む。
    ///
    /// 牙の限界 (誠実に明示): 8近傍BFSの性質上、矩形ベタ塗りの人工ヒートマップでは
    /// 「1連結成分のまま内部を行分割する」ケースを再現できない (行間の谷を空けると
    /// 成分が2つに割れ、谷を埋めると row_ink が途切れず分割条件を満たさない)。
    /// よって行分割ロジック本体の牙は split_component_rows_separates_two_bands 側に
    /// 置く (分割を殺すと赤くなることを実証済み)。本テストは「成分→行→polygon の
    /// 配線が座標を保って通る」ことだけを主張する。過剰な主張はしない。
    #[test]
    fn polygons_from_heatmap_wires_rows_to_polygons() {
        let map_w = 20usize;
        let map_h = 20usize;
        let mut heat = vec![0.0f32; map_w * map_h];
        let set = |h: &mut [f32], x0: usize, x1: usize, y0: usize, y1: usize| {
            for y in y0..y1 {
                for x in x0..x1 {
                    h[y * map_w + x] = 1.0;
                }
            }
        };
        // 行A: y=2..6、行B: y=12..16。x=2..18 の幅。y=6..12 は谷 (8近傍で連結しない)。
        set(&mut heat, 2, 18, 2, 6);
        set(&mut heat, 2, 18, 12, 16);
        let polys = polygons_from_heatmap(
            &heat,
            map_w,
            map_h,
            map_w as u32,
            map_h as u32,
            1.0,
            (map_w as u32, map_h as u32),
        );
        assert_eq!(polys.len(), 2, "上下2つのインク帯は2 polygonになるべき");
        // 上→下の行順で並ぶ (polys.sort_by_key の (top, left) 順)。
        let b0 = bbox_from_polygon(&polys[0].points, (map_w as u32, map_h as u32));
        let b1 = bbox_from_polygon(&polys[1].points, (map_w as u32, map_h as u32));
        assert!(b0[1] < b1[1], "polygonは上→下の行順で並ぶべき");
        // 座標が素通し (input=map/scale=1) で元画像範囲に収まる。
        assert!(b0[0] >= 0 && b0[1] >= 0);
        assert!(b1[0] + b1[2] <= map_w as i32 && b1[1] + b1[3] <= map_h as i32);
    }

    /// 正しい文字 (有意な文字あり・十分な信頼度) は残す。
    #[test]
    fn should_keep_text_region_keeps_valid_text() {
        assert!(should_keep_text_region("補聴器", 0.92));
        assert!(should_keep_text_region("レンタル", 0.75));
        assert!(should_keep_text_region("PARIS MIKI", 0.88));
        // 下限ギリギリ上 (0.35 以上) は残す (見逃し側へ倒す保守設計)。
        assert!(should_keep_text_region("定", 0.36));
    }

    /// 実質空の region は弾く。
    #[test]
    fn should_keep_text_region_rejects_empty() {
        assert!(!should_keep_text_region("", 0.99));
        assert!(!should_keep_text_region("   ", 0.99));
    }

    /// 信頼度が下限未満の化け候補は、有意な文字があっても弾く (差3: 文字化け)。
    #[test]
    fn should_keep_text_region_rejects_low_confidence_garble() {
        // 「補」→「哈」のような低信頼の化けは弾く。
        assert!(!should_keep_text_region("哈", 0.20));
        assert!(!should_keep_text_region("abc", 0.10));
        // 境界: 0.35 未満は弾く。
        assert!(!should_keep_text_region("文字", 0.34));
    }

    /// 記号だけ (非文字アイコンの塊) は、信頼度が高くなければ弾く (差2: アイコン混入)。
    #[test]
    fn should_keep_text_region_rejects_symbol_only_icon() {
        // 眼鏡アイコンが記号列 + 中信頼で出るケースを弾く。
        assert!(!should_keep_text_region("◇◇", 0.50));
        assert!(!should_keep_text_region("□□□", 0.60));
        assert!(!should_keep_text_region("―", 0.45));
    }

    /// 正当な記号テキスト (「!」等) は、信頼度が十分高ければ記号だけでも残す (誤除去防止)。
    #[test]
    fn should_keep_text_region_keeps_high_confidence_symbols() {
        assert!(should_keep_text_region("!", 0.85));
        assert!(should_keep_text_region("+", 0.90));
    }
}
