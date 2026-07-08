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
    let det_spec = find_model("ppocrv6-small-det")
        .ok_or_else(|| "model spec not found: ppocrv6-small-det".to_string())?;
    let rec_spec = find_model("ppocrv6-small-rec")
        .ok_or_else(|| "model spec not found: ppocrv6-small-rec".to_string())?;
    ocr_image_with_probmap_with_models(runtime, input_path, &det_spec, &rec_spec).await
}

/// det/rec モデルを差し替え可能な実体。既定は [`ocr_image_with_probmap`] が small を渡す。
///
/// なぜ分離するか: OCR ティア (small/medium) の A/B 実測をテストから行うため
/// (magic_layer_e2e の ab probe が medium spec を渡す)。前処理・辞書は PP-OCRv6
/// ファミリー共通の想定なので、モデルファイルの差し替えだけで同一パイプラインが走る。
pub(crate) async fn ocr_image_with_probmap_with_models(
    runtime: &EditRuntime,
    input_path: &Path,
    det_spec: &crate::edit::registry::ModelSpec,
    rec_spec: &crate::edit::registry::ModelSpec,
) -> Result<(Vec<TextRegion>, Option<TextProbMap>), String> {
    tracing::info!(target: "codex.edit", "ocr: 画像デコード開始");
    let img = image::open(input_path).map_err(|e| format!("open: {e}"))?;
    tracing::info!(target: "codex.edit", "ocr: 画像デコード完了 {}x{}", img.width(), img.height());

    tracing::info!(target: "codex.edit", "ocr: detセッション取得開始");
    let det_session = runtime.get_session(det_spec).await?;
    tracing::info!(target: "codex.edit", "ocr: detection開始 {}x{}", img.width(), img.height());
    let (polygons, prob_map) = {
        let mut session = det_session.lock().await;
        run_paddleocr_detection(&mut session, &img)?
    };
    tracing::info!(target: "codex.edit", "ocr: detection完了 polygons={}", polygons.len());

    let rec_session = runtime.get_session(rec_spec).await?;

    let mut regions = Vec::new();
    let mut session = rec_session.lock().await;
    for poly in polygons.iter() {
        let bbox = bbox_from_polygon(&poly.points, img.dimensions());
        if bbox[2] <= 0 || bbox[3] <= 0 {
            continue;
        }
        // 行頭/行末アイコン分離: 元画像インクの広い谷で「アイコン疑いの端の塊」候補を取り、
        // 疑い側だけ先に認識してみる。非文字なら残り (rest) だけを region にする。
        // 文字だったら分割を捨てて従来どおり bbox 全体を 1 region にする (文字を粉砕しない)。
        // 複数パーツのアイコン (実測: 眼鏡=レンズ2個) は 1 回では剥がれないので、
        // 非文字と判定される限り繰り返す (上限 3 回。認識コストの暴走防止)。
        let mut effective = (bbox, poly.points.to_vec());
        for _ in 0..3 {
            let Some(cand) = icon_split_candidate(&img, effective.0) else {
                break;
            };
            let crop = crop_axis_aligned(&img, cand.suspect)?;
            let (s_text, s_conf) = run_paddleocr_recognition(&mut session, &crop)?;
            if should_keep_text_region(&s_text, s_conf) {
                break;
            }
            tracing::info!(
                target: "codex.edit",
                "ocr: 端の非文字塊 (アイコン疑い) を切り離し text={:?} bbox={:?} -> rest={:?}",
                s_text, effective.0, cand.rest
            );
            let [x, y, w, h] = cand.rest;
            effective = (
                cand.rest,
                vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
            );
        }
        let (bbox, polygon) = effective;
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
            id: format!("region-{:04}", regions.len()),
            bbox,
            polygon,
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
            // 各行を、さらに列方向の「広い谷」で横分割する (行頭アイコンと文字塊の分離)。
            // 語間・字間の狭いスペースでは切らない (split_row_into_cols の gap_min_width)。
            for seg in split_row_into_cols(row, &pixels) {
                let [r_min_x, r_min_y, r_w, r_h] = seg;
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
    // 行間の谷を「絶対0」で判定すると、実バナーで行間に薄く乗るノイズ (下線・囲み枠・
    // にじみ・JPEG ノイズが縦に貫通) で谷が埋まり、複数行が1行に潰れる。
    // 谷は行内ピークに対する相対的な薄さで判定する: ピークの一定割合未満なら行間とみなす。
    // (本家 PaddleOCR の水平投影による行分離を軽量化した相対しきい値法)
    let peak_ink = row_ink.iter().copied().max().unwrap_or(0);
    // 谷しきい値: ピークの 15%。行内の密なインク (ピーク近辺) と、行間の薄いノイズを分ける。
    // ピークが小さい (数画素の細い塊) 場合は 1 未満に丸まり、実質「絶対0」判定に戻る
    // (退行しない = 単一行の細い塊を過分割しない)。
    let valley_ceiling = peak_ink * 15 / 100;
    let is_inked = |v: usize| v > valley_ceiling;
    // row 帯を切り出す (谷=valley_ceiling 以下の連続が行間)。
    let mut rows: Vec<[usize; 4]> = Vec::new();
    let mut band_start: Option<usize> = None;
    for local_y in 0..h {
        let inked = is_inked(row_ink[local_y]);
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

/// 1 行 bbox (map 座標) と、その行に属する画素の map 座標を受け取り、**列の垂直投影**
/// (各 x のインク画素数) の「広い谷」で左右に分割した bbox の列を返す。
///
/// なぜ必要か: DB 検出器は、行頭の**アイコン**と隣接する文字列を 1 つの水平連結成分に
/// まとめることがある (実測: パリミキ眼鏡アイコンが "OO PARIS MIK" として PARIS と同一
/// region に混入。conf=0.933 と高信頼なので認識後フィルタでは弾けない)。列投影の広い谷で
/// アイコンを別 region に切り離すと、切り離された "OO" 側は記号のみ region になり
/// [`should_keep_text_region`] が除外する。
///
/// 過分割の防止 (最重要): 単語間の狭いスペース ("PARIS_MIKI" の語間) では切らない。
/// 谷の幅が**行高の一定割合以上**の「広いギャップ」のときだけ分割する。日本語の字間・
/// 英単語の語間は行高より狭いので保持され、アイコンと文字塊の間 (視覚的に明確に空く) だけ
/// 切れる。谷が無い / 広いギャップが無ければ入力 bbox をそのまま1件返す (退行しない)。
fn split_row_into_cols(row_bbox: [usize; 4], pixels: &[(usize, usize)]) -> Vec<[usize; 4]> {
    let [min_x, min_y, w, h] = row_bbox;
    if pixels.is_empty() || h == 0 || w == 0 {
        return vec![row_bbox];
    }
    // この行に属する画素だけを列インクとして数える (y は行帯内に限定)。
    let mut col_ink = vec![0usize; w];
    for &(x, y) in pixels {
        if y >= min_y && y < min_y + h && x >= min_x && x < min_x + w {
            col_ink[x - min_x] += 1;
        }
    }
    // 広いギャップの下限幅: 行高の 60%。これ以上連続してインクの薄い列が続いたら
    // 「アイコンと文字塊の間」等の意味的な区切りとみなす。語間・字間 (行高より狭い) は
    // これを超えないので保持される。行が極端に低い場合の下限として最低 4px を保証。
    let gap_min_width = (h * 60 / 100).max(4);
    let inked_bands = bands_from_ink_profile(&col_ink, gap_min_width);
    if inked_bands.len() <= 1 {
        // 分割する広い谷が無い = 単一の文字塊。退行しない。
        return vec![row_bbox];
    }
    inked_bands
        .into_iter()
        .map(|(s, e)| [min_x + s, min_y, e - s, h])
        .collect()
}

/// インク量プロファイル (列ごとの前景画素数) を「広い谷」で帯に分割する共通コア。
///
/// 列の薄さ判定はピークの 12% 未満をインクなし相当とする (行分離と同じ相対しきい値の思想)。
/// `gap_min_width` 以上続く谷だけを「分割する谷」として扱い、狭い谷 (語間・字間) では
/// 帯を切らない。返り値は (start, end 排他) の帯列。全列が谷なら空を返す。
fn bands_from_ink_profile(ink: &[usize], gap_min_width: usize) -> Vec<(usize, usize)> {
    let peak = ink.iter().copied().max().unwrap_or(0);
    let ceiling = peak * 12 / 100;
    let mut bands: Vec<(usize, usize)> = Vec::new();
    let mut band_start: Option<usize> = None;
    let mut gap_run = 0usize;
    for (i, &v) in ink.iter().enumerate() {
        if v > ceiling {
            if band_start.is_none() {
                band_start = Some(i);
            }
            gap_run = 0;
        } else {
            gap_run += 1;
            // 広いギャップに達したら、直前の帯を確定する。
            if gap_run >= gap_min_width {
                if let Some(start) = band_start.take() {
                    // 帯の終端は、ギャップが始まる直前。
                    let end = i + 1 - gap_run;
                    if end > start {
                        bands.push((start, end));
                    }
                }
            }
        }
    }
    if let Some(start) = band_start {
        bands.push((start, ink.len()));
    }
    bands
}

/// 行頭/行末アイコン分離の候補。`suspect` (アイコンかもしれない端の塊) を先に認識して
/// 非文字なら `rest` だけを region にする。文字なら分割せず元 bbox 全体を使う。
struct IconSplitCandidate {
    /// アイコン疑いの端の塊 (元画像座標 bbox)。
    suspect: [i32; 4],
    /// 残りの文字塊 (元画像座標 bbox)。谷で分かれた帯をすべてマージしたもの。
    rest: [i32; 4],
}

/// 検出 bbox (元画像座標) から、**元画像のインク** (二値化した前景) の列投影を使って
/// 「行頭/行末のアイコン疑い塊 + 残りの文字塊」の分離候補を返す。
///
/// なぜ確率マップでなく元画像を見るか: DB 検出器の確率マップは太字ロゴ等で region 全体が
/// ベタ塗りになる (実測: パリミキ広告の "OO PARIS MIKI" 行は全 481 列がインク充填で谷ゼロ)。
/// マップ上の谷では行頭アイコンと文字塊を切り離せないが、元画像には白い隙間が実在する。
///
/// なぜ「全部の谷で切る」のではなく「端の1塊だけ候補にする」のか: 幅だけを基準に全谷で
/// 切ると、字間の広いロゴが粉砕される (実測: "PARIS MIKI" が PAR/LS/M/K に割れて文字を
/// 失った)。ここでは幾何情報だけで確定せず、**候補を返して認識結果に判定させる**。
/// suspect が文字だったら呼び出し側は分割を捨てて従来どおり全体を 1 region にするので、
/// 文字列が粉砕される経路は存在しない。
///
/// 二値化は Otsu。前景/背景の極性は bbox 縁 1px の多数派クラスを背景とみなして決める
/// (白地に紺文字でも、紺地に白文字でも動く)。谷は幅が行高の 60% 以上の「広いギャップ」のみ。
/// 端の塊は「残り全体より狭い」ときだけアイコン疑いにする (文の後半を suspect にしない)。
fn icon_split_candidate(img: &DynamicImage, bbox: [i32; 4]) -> Option<IconSplitCandidate> {
    let [bx, by, bw, bh] = bbox;
    if bw < 8 || bh < 4 {
        return None;
    }
    let (w, h) = (bw as usize, bh as usize);
    // bbox 内の輝度を取り出す (元画像から直接読む。crop の再確保はしない)。
    let mut luma = vec![0u8; w * h];
    for dy in 0..h {
        for dx in 0..w {
            let px = img.get_pixel((bx + dx as i32) as u32, (by + dy as i32) as u32);
            let [r, g, b, _] = px.0;
            luma[dy * w + dx] =
                ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
        }
    }
    let threshold = otsu_threshold(&luma);
    // 縁 1px の多数派を「背景」とみなす。dark 側が縁の多数派なら ink = bright 側。
    let mut border_dark = 0usize;
    let mut border_total = 0usize;
    for dx in 0..w {
        for dy in [0, h - 1] {
            border_total += 1;
            if luma[dy * w + dx] < threshold {
                border_dark += 1;
            }
        }
    }
    for dy in 0..h {
        for dx in [0, w - 1] {
            border_total += 1;
            if luma[dy * w + dx] < threshold {
                border_dark += 1;
            }
        }
    }
    let ink_is_dark = border_dark * 2 < border_total;
    let mut col_ink = vec![0usize; w];
    for dy in 0..h {
        for dx in 0..w {
            let dark = luma[dy * w + dx] < threshold;
            if dark == ink_is_dark {
                col_ink[dx] += 1;
            }
        }
    }
    let gap_min_width = (h * 60 / 100).max(4);
    let bands = bands_from_ink_profile(&col_ink, gap_min_width);
    if bands.len() < 2 {
        return None;
    }
    // 帯 (local x 区間) を元画像座標 bbox へ。文字の縁を欠かさないよう左右 2px 広げる。
    let pad = 2i32;
    let to_bbox = |s: usize, e: usize| -> [i32; 4] {
        let left = (bx + s as i32 - pad).max(bx);
        let right = (bx + e as i32 + pad).min(bx + bw);
        [left, by, right - left, bh]
    };
    let first = bands[0];
    let last = bands[bands.len() - 1];
    // 行頭側を優先。suspect は「残り全体より狭い」こと (文の大半を suspect にしない)。
    let lead_w = first.1 - first.0;
    let lead_rest_w = last.1 - bands[1].0;
    if lead_w < lead_rest_w {
        return Some(IconSplitCandidate {
            suspect: to_bbox(first.0, first.1),
            rest: to_bbox(bands[1].0, last.1),
        });
    }
    // 行末側 (テキストの後ろにアイコンが付く型)。
    let tail_w = last.1 - last.0;
    let tail_rest_w = bands[bands.len() - 2].1 - first.0;
    if tail_w < tail_rest_w {
        return Some(IconSplitCandidate {
            suspect: to_bbox(last.0, last.1),
            rest: to_bbox(first.0, bands[bands.len() - 2].1),
        });
    }
    None
}

/// グレースケールヒストグラムから Otsu の判別分析で二値化しきい値を求める。
/// 全画素が同輝度など分離不能な場合は 128 を返す。
fn otsu_threshold(luma: &[u8]) -> u8 {
    let mut hist = [0u64; 256];
    for &v in luma {
        hist[v as usize] += 1;
    }
    let total = luma.len() as u64;
    if total == 0 {
        return 128;
    }
    let sum_all: u64 = hist
        .iter()
        .enumerate()
        .map(|(v, &c)| v as u64 * c)
        .sum();
    let mut best_t = 128u8;
    let mut best_var = -1.0f64;
    let mut w0 = 0u64;
    let mut sum0 = 0u64;
    for t in 0..256usize {
        w0 += hist[t];
        if w0 == 0 {
            continue;
        }
        let w1 = total - w0;
        if w1 == 0 {
            break;
        }
        sum0 += t as u64 * hist[t];
        let m0 = sum0 as f64 / w0 as f64;
        let m1 = (sum_all - sum0) as f64 / w1 as f64;
        let var = w0 as f64 * w1 as f64 * (m0 - m1) * (m0 - m1);
        if var > best_var {
            best_var = var;
            best_t = (t + 1).min(255) as u8;
        }
    }
    best_t
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

    /// 行間の谷にノイズ画素が薄く残っていても、2行に分離される。
    ///
    /// なぜ必要か: 実バナーは行間が完全にインク0になることは稀 (下線・囲み枠・にじみ・
    /// JPEG ノイズが縦に貫通する)。谷を「絶対0」で判定すると、行間にノイズ1画素が
    /// 乗るだけで谷が埋まり「レンタル / 補聴器」が1行に潰れる。谷は行内ピークに対する
    /// 相対的な薄さで判定する必要がある。
    #[test]
    fn split_component_rows_separates_bands_with_noisy_valley() {
        // 成分 bbox: x=10, y=0, w=20, h=10。
        // 行A: y=0..3 (幅20の密なインク=各行20画素)、行B: y=6..9 (同)。
        // 行間 y=3..6 は「完全な0」ではなく、各 y に 1 画素だけノイズが乗る。
        let bbox_map = [10usize, 0, 20, 10];
        let mut pixels = Vec::new();
        for y in 0..3 {
            for x in 10..30 {
                pixels.push((x, y));
            }
        }
        // 行間の谷: 各 y に 1 画素だけノイズ (絶対0ではないが、行内ピーク20に対し薄い)。
        for y in 3..6 {
            pixels.push((10, y));
        }
        for y in 6..9 {
            for x in 10..30 {
                pixels.push((x, y));
            }
        }
        let rows = split_component_rows(bbox_map, &pixels);
        assert_eq!(
            rows.len(),
            2,
            "行間にノイズが薄く残っても、行内ピークに対して十分薄ければ谷として2行に分離されるべき"
        );
    }

    /// 行頭アイコンと文字塊が「広い水平ギャップ」で離れていれば、横に2分割される。
    ///
    /// これが「OO PARIS MIK」の眼鏡アイコン "OO" を PARIS から切り離す核心。
    /// 切り離された "OO" 側は記号のみ region になり should_keep_text_region が弾く。
    #[test]
    fn split_row_into_cols_separates_icon_from_text() {
        // 行 bbox: x=0, y=0, w=40, h=10。
        // アイコン塊: x=0..8 (幅8)。広いギャップ: x=8..20 (幅12 >= h*0.6=6)。文字塊: x=20..40。
        let row_bbox = [0usize, 0, 40, 10];
        let mut pixels = Vec::new();
        for y in 0..10 {
            for x in 0..8 {
                pixels.push((x, y));
            }
            for x in 20..40 {
                pixels.push((x, y));
            }
        }
        let segs = split_row_into_cols(row_bbox, &pixels);
        assert_eq!(segs.len(), 2, "アイコンと文字塊は広いギャップで2分割されるべき");
        // 左=アイコン塊、右=文字塊。
        assert_eq!(segs[0][0], 0, "左セグは x=0 から");
        assert!(segs[1][0] >= 20, "右セグは文字塊 (x>=20) から始まる");
    }

    /// 語間・字間の「狭いスペース」では横分割しない (退行防止)。
    ///
    /// "PARIS MIKI" の語間 (行高より狭い) で切ると単語がバラバラになる。
    /// gap_min_width = 行高の60% 未満のギャップは保持する。
    #[test]
    fn split_row_into_cols_keeps_words_with_narrow_gap() {
        // 行 bbox: x=0, y=0, w=30, h=10。gap_min_width = max(6, 4) = 6。
        // 塊A: x=0..12。狭いギャップ: x=12..15 (幅3 < 6)。塊B: x=15..30。
        let row_bbox = [0usize, 0, 30, 10];
        let mut pixels = Vec::new();
        for y in 0..10 {
            for x in 0..12 {
                pixels.push((x, y));
            }
            for x in 15..30 {
                pixels.push((x, y));
            }
        }
        let segs = split_row_into_cols(row_bbox, &pixels);
        assert_eq!(segs.len(), 1, "狭いギャップ (語間) では分割せず1件のままにすべき");
        assert_eq!(segs[0], row_bbox);
    }

    /// 「アイコン塊 + 広い白ギャップ + 文字塊」の合成画像から、行頭側を suspect、
    /// 残りを rest とする分離候補が返る。確率マップがベタ塗りでも効く経路の核心。
    #[test]
    fn icon_split_candidate_detects_leading_icon() {
        // 200x40 の白画像。インク: x=10..40 (アイコン相当) と x=70..190 (文字相当)。
        // ギャップ x=40..70 は幅 30 >= 行高24*0.6=14 なので候補になる。
        let mut img = image::RgbImage::from_pixel(200, 40, image::Rgb([255, 255, 255]));
        for y in 10..30 {
            for x in 10..40 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
            for x in 70..190 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
        }
        let img = DynamicImage::ImageRgb8(img);
        let cand = icon_split_candidate(&img, [5, 8, 190, 24]).expect("候補が返るべき");
        assert!(
            cand.suspect[0] <= 10 && cand.suspect[0] + cand.suspect[2] >= 35,
            "suspect が行頭アイコンを覆う: {:?}",
            cand.suspect
        );
        assert!(
            cand.rest[0] <= 70 && cand.rest[0] + cand.rest[2] >= 185,
            "rest が文字塊を覆う: {:?}",
            cand.rest
        );
    }

    /// 行末側にアイコンが付く型 (文字塊 + ギャップ + 小塊) では行末側が suspect になる。
    #[test]
    fn icon_split_candidate_detects_trailing_icon() {
        let mut img = image::RgbImage::from_pixel(200, 40, image::Rgb([255, 255, 255]));
        for y in 10..30 {
            for x in 10..130 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
            for x in 160..190 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
        }
        let img = DynamicImage::ImageRgb8(img);
        let cand = icon_split_candidate(&img, [5, 8, 190, 24]).expect("候補が返るべき");
        assert!(
            cand.suspect[0] >= 130,
            "suspect が行末の小塊: {:?}",
            cand.suspect
        );
        assert!(
            cand.rest[0] <= 10 && cand.rest[0] + cand.rest[2] >= 125,
            "rest が前方の文字塊: {:?}",
            cand.rest
        );
    }

    /// 紺地に白インク (極性反転) でも、縁の多数派判定で ink=白 と解釈して候補を返せる。
    #[test]
    fn icon_split_candidate_handles_inverted_polarity() {
        let mut img = image::RgbImage::from_pixel(200, 40, image::Rgb([20, 30, 80]));
        for y in 10..30 {
            for x in 10..40 {
                img.put_pixel(x, y, image::Rgb([255, 255, 255]));
            }
            for x in 70..190 {
                img.put_pixel(x, y, image::Rgb([255, 255, 255]));
            }
        }
        let img = DynamicImage::ImageRgb8(img);
        assert!(
            icon_split_candidate(&img, [5, 8, 190, 24]).is_some(),
            "紺地白文字でも候補が返るべき"
        );
    }

    /// 狭いギャップ (語間相当) や谷なしでは候補を出さない。極小 bbox もパニックしない。
    #[test]
    fn icon_split_candidate_ignores_narrow_gap_and_solid() {
        // ギャップ x=40..48 は幅 8 < 行高24*0.6=14 なので候補なし。
        let mut img = image::RgbImage::from_pixel(200, 40, image::Rgb([255, 255, 255]));
        for y in 10..30 {
            for x in 10..40 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
            for x in 48..190 {
                img.put_pixel(x, y, image::Rgb([20, 30, 80]));
            }
        }
        let img = DynamicImage::ImageRgb8(img);
        assert!(icon_split_candidate(&img, [5, 8, 190, 24]).is_none());
        assert!(icon_split_candidate(&img, [0, 0, 6, 3]).is_none());
    }

    /// Otsu しきい値は二峰性ヒストグラムを暗部と明部の間で切る。
    #[test]
    fn otsu_threshold_separates_bimodal() {
        let mut luma = vec![30u8; 100];
        luma.extend(vec![220u8; 100]);
        let t = otsu_threshold(&luma);
        assert!(t > 30 && t <= 220, "しきい値が二峰の間にあるべき: {t}");
        assert_eq!(otsu_threshold(&[]), 128, "空入力はフォールバック値");
    }

    /// 画素が空 / 単一塊なら入力 bbox をそのまま返す (フォールバック、パニックしない)。
    #[test]
    fn split_row_into_cols_empty_and_single_fallback() {
        let row_bbox = [3usize, 3, 20, 8];
        assert_eq!(split_row_into_cols(row_bbox, &[]), vec![row_bbox]);
        // 単一の連続塊 (ギャップなし) は分割しない。
        let mut pixels = Vec::new();
        for y in 3..11 {
            for x in 3..23 {
                pixels.push((x, y));
            }
        }
        assert_eq!(split_row_into_cols(row_bbox, &pixels), vec![row_bbox]);
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
