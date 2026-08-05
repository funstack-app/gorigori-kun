use std::path::{Path, PathBuf};

use image::{GenericImageView, ImageBuffer, Rgba};
use ort::value::Tensor;

use crate::edit::registry::{all_models, model_path};
use crate::edit::runtime::EditRuntime;

/// SCHP ATR-18 の入力サイズ (512x512 固定ストレッチ)。
const INPUT_SIZE: u32 = 512;
const INPUT_PIXELS: usize = (INPUT_SIZE as usize) * (INPUT_SIZE as usize);
const NUM_CLASSES: usize = 18;

/// ATR 18 クラスの日本語ラベル (preprocessor_config / model card の id2label と対応)。
/// index = クラスID。背景(0)はレイヤー化しない。
const ATR_LABELS_JA: [&str; NUM_CLASSES] = [
    "背景",       // 0 Background
    "帽子",       // 1 Hat
    "髪",         // 2 Hair
    "サングラス", // 3 Sunglasses
    "上衣",       // 4 Upper-clothes
    "スカート",   // 5 Skirt
    "パンツ",     // 6 Pants
    "ワンピース", // 7 Dress
    "ベルト",     // 8 Belt
    "左の靴",     // 9 Left-shoe
    "右の靴",     // 10 Right-shoe
    "顔",         // 11 Face
    "左脚",       // 12 Left-leg
    "右脚",       // 13 Right-leg
    "左腕",       // 14 Left-arm
    "右腕",       // 15 Right-arm
    "バッグ",     // 16 Bag
    "スカーフ",   // 17 Scarf
];

/// 認識された 1 パーツ = 1 レイヤー分。元解像度の透過 PNG を書き出す。
#[derive(Debug, Clone)]
pub struct HumanPartLayer {
    pub class_id: usize,
    pub label: String,
    /// 元解像度の透過 PNG パス (該当パーツのみ不透明、他は透明)。
    pub image_path: PathBuf,
    /// このパーツが画像に占めるピクセル数 (小さすぎる誤検出を間引く判断材料)。
    pub pixel_count: u64,
}

pub struct HumanParseResult {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<HumanPartLayer>,
}

/// 人物パーツ自動認識 (SCHP)。画像から髪・顔・上衣・パンツ等を 1 回の推論で
/// 全部位同時に検出し、各パーツを元解像度の透過 PNG として書き出す。
pub async fn human_parse_image(
    runtime: &EditRuntime,
    input_path: &Path,
    output_dir: &Path,
) -> Result<HumanParseResult, String> {
    let spec = all_models()
        .into_iter()
        .find(|spec| spec.id == "schp-atr-18")
        .ok_or_else(|| "SCHP model spec not found".to_string())?;

    // モデル未DLなら、生の英語エラー (get_session の "model not downloaded") ではなく
    // 日本語で案内する。非エンジニア向け配布アプリのため (フォーク評価指摘)。
    if !model_path(&spec)?.exists() {
        return Err(
            "人物パーツ分解モデルが未ダウンロードです。モード選択の「モデルを追加」から取得してください。"
                .to_string(),
        );
    }

    let session = runtime.get_session(&spec).await?;

    let img = image::open(input_path).map_err(|e| format!("image open: {e}"))?;
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("image has zero width or height".to_string());
    }

    // 512x512 へストレッチ (アスペクト比保持なし。SCHPImageProcessor と一致)。
    let resized = img.resize_exact(
        INPUT_SIZE,
        INPUT_SIZE,
        image::imageops::FilterType::Triangle, // bilinear 相当
    );
    let rgb = resized.to_rgb8();

    // RGB のまま /255 → (x-mean)/std。mean/std は BGR-trained 由来だが SCHP は
    // RGB チャネルに直接適用する (preprocessor_config / image_processing_schp.py で確認済み)。
    let mean = [0.406f32, 0.456, 0.485];
    let std = [0.225f32, 0.224, 0.229];
    let mut input_data = vec![0f32; 3 * INPUT_PIXELS];
    for (i, p) in rgb.pixels().enumerate() {
        input_data[i] = (p[0] as f32 / 255.0 - mean[0]) / std[0];
        input_data[INPUT_PIXELS + i] = (p[1] as f32 / 255.0 - mean[1]) / std[1];
        input_data[2 * INPUT_PIXELS + i] = (p[2] as f32 / 255.0 - mean[2]) / std[2];
    }

    // 推論 → logits (1, 18, 512, 512)。各ピクセルを argmax してラベルマップを得る。
    // present_bits: 出現したクラスID集合 (後段で class 毎の全画素再走査を消すため)。
    let (label_map_512, present_bits): (Vec<u8>, u32) = {
        let input_tensor = Tensor::from_array((
            [1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
            input_data,
        ))
        .map_err(|e| format!("tensor: {e}"))?;

        let mut guard = session.lock().await;
        let outputs = guard
            .run(ort::inputs!["pixel_values" => input_tensor])
            .map_err(|e| format!("run: {e}"))?;
        if outputs.len() == 0 {
            return Err("human parse output is empty".to_string());
        }
        let (_shape, logits) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("extract: {e}"))?;
        if logits.len() < NUM_CLASSES * INPUT_PIXELS {
            return Err(format!(
                "unexpected logits size: {} (expected {})",
                logits.len(),
                NUM_CLASSES * INPUT_PIXELS
            ));
        }
        argmax_label_map(logits)
    };

    tokio::fs::create_dir_all(output_dir)
        .await
        .map_err(|e| format!("output dir: {e}"))?;

    // 512 のラベルマップを元解像度へ最近傍展開する (O(W×H) を 1 回だけ)。
    // 以前は class 毎に全画素を再走査+座標再計算していて 4K×多クラスで重かった。
    // 座標計算は u64 経由でオーバーフローを防ぐ (極端な横長画像で x*512 が u32 を超える)。
    let rgba = img.to_rgba8();
    let mut label_map_full = vec![0u8; (orig_w as usize) * (orig_h as usize)];
    for y in 0..orig_h {
        let sy = ((y as u64 * INPUT_SIZE as u64 / orig_h as u64) as u32).min(INPUT_SIZE - 1);
        for x in 0..orig_w {
            let sx = ((x as u64 * INPUT_SIZE as u64 / orig_w as u64) as u32).min(INPUT_SIZE - 1);
            let src = sy as usize * INPUT_SIZE as usize + sx as usize;
            let dst = y as usize * orig_w as usize + x as usize;
            label_map_full[dst] = label_map_512[src];
        }
    }

    // 元解像度換算で極小 (全体の 0.05% 未満) のパーツは誤検出として間引く。
    let min_pixels = ((orig_w as u64) * (orig_h as u64)) / 2000;

    // 各クラスのマスクを適用して透過 PNG を書き出す。present_bits に立っている
    // クラスだけ処理する (出現しないクラスはスキップ、512 全画素の再走査は不要)。
    let mut layers = Vec::new();
    for class_id in 1..NUM_CLASSES {
        if present_bits & (1u32 << class_id) == 0 {
            continue;
        }

        let mut part = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(orig_w, orig_h);
        let mut pixel_count: u64 = 0;
        for (x, y, p) in rgba.enumerate_pixels() {
            let idx = y as usize * orig_w as usize + x as usize;
            if label_map_full[idx] as usize == class_id {
                part.put_pixel(x, y, Rgba([p[0], p[1], p[2], p[3]]));
                pixel_count += 1;
            } else {
                part.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }

        if pixel_count < min_pixels {
            continue;
        }

        let label = ATR_LABELS_JA[class_id].to_string();
        let file_name = format!("part-{class_id:02}.png");
        let path = output_dir.join(file_name);
        part.save(&path)
            .map_err(|e| format!("save part {class_id}: {e}"))?;
        layers.push(HumanPartLayer {
            class_id,
            label,
            image_path: path,
            pixel_count,
        });
    }

    if layers.is_empty() {
        return Err(
            "人物パーツを認識できませんでした。人物が写った画像でお試しください。".to_string(),
        );
    }

    Ok(HumanParseResult {
        width: orig_w,
        height: orig_h,
        layers,
    })
}

/// logits (NUM_CLASSES, H, W) の chw レイアウトを各ピクセル argmax してラベルマップ化し、
/// 同時に「出現したクラスID集合」を bitset (u32) で返す (後段の present 再走査を消すため)。
/// NaN 防御: INT8 量子化で稀に NaN が出ても黙って背景に倒さず、有限値のみで比較する。
fn argmax_label_map(logits: &[f32]) -> (Vec<u8>, u32) {
    let mut label_map = vec![0u8; INPUT_PIXELS];
    let mut present_bits: u32 = 0;
    for idx in 0..INPUT_PIXELS {
        let mut best_class = 0usize;
        let mut best_val = f32::NEG_INFINITY;
        for class_id in 0..NUM_CLASSES {
            let v = logits[class_id * INPUT_PIXELS + idx];
            // NaN は比較から除外 (v > best_val は NaN で false になり据え置かれるが、
            // 明示的に有限チェックして意図を残す)。
            if v.is_finite() && v > best_val {
                best_val = v;
                best_class = class_id;
            }
        }
        label_map[idx] = best_class as u8;
        present_bits |= 1u32 << best_class;
    }
    (label_map, present_bits)
}
