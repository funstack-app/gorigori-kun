use std::path::Path;

use image::{GenericImageView, ImageBuffer, Luma, Rgb};
use ort::value::Tensor;

use crate::edit::registry::find_model;
use crate::edit::runtime::EditRuntime;

const LAMA_SIZE: u32 = 512;

/// マスククラスタの橋渡し距離 (px)。この距離以内のマスク断片は1クラスタとして
/// 同じクロップで修復する (近接する文字行を別々に直すと継ぎ目が出る)。
const CLUSTER_LINK_RADIUS: i32 = 24;

/// クロップ一辺の下限 (px)。マスクが小さくても最低この文脈を LaMa に見せる
/// (= LAMA_SIZE と同値なら縮小なしのネイティブ解像度修復になる)。
const MIN_CROP_SIDE: u32 = 512;

/// 「細長い帯マスク」とみなす短辺の上限 (px)。これ以下ならタイル (512 ネイティブ) 内に
/// 無傷の文脈が十分残るため、縮小せずタイル分割修復できる。テキスト行は通常これに収まる。
const THIN_BAND_MAX: u32 = 300;

/// ネイティブタイルの重なり文脈 (px)。隣接タイルはこの幅ずつ重ねて継ぎ目を馴染ませる。
const TILE_MARGIN: u32 = 64;

/// 「滑らかな文脈」とみなす無傷画素の輝度標準偏差の上限。これ未満のクラスタは
/// LaMa でなく決定論補間フィルで埋める。
/// 実測根拠 (2026-07-03): 体育館の壁 (補間が自然/LaMaは幻覚) std=16.7、
/// ネオン街 (LaMaが自然/補間は滲む) std=63.0。中間の30で切る。
const SMOOTH_CONTEXT_STD: f64 = 30.0;

/// 画像をマスク領域だけ LaMa で修復して保存する。
///
/// 方式 (2026-07-03 全面改修): マスクのクラスタごとに周辺文脈を含む正方形クロップを取り、
/// クロップを 512x512 で LaMa 修復 → **マスク画素だけ**を元画像へ合成する。
///
/// なぜクロップ+合成か: 旧実装は画像全体を 512x512 に潰して修復し、その全面アップスケールを
/// そのまま保存していた。これは (1) マスク外の無傷領域まで全面ボケる、(2) 修復跡が
/// 1/3解像度の再構成になり文字の消し跡が「読めるゴースト」になる、の2重の品質破綻だった
/// (実測: 1672x941 のタイトル消しで滲んだ文字が残存、被写体のジャージ印字まで劣化)。
/// クロップなら縮小率が局所で済み (小さいマスクはほぼ等倍)、合成でマスク外は原画素のまま。
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
    if mask.dimensions() != (orig_w, orig_h) {
        return Err(format!(
            "mask size mismatch: img={orig_w}x{orig_h} mask={}x{}",
            mask.width(),
            mask.height()
        ));
    }

    // マスクが空なら原画像コピー (修復対象なし)。
    let clusters = mask_cluster_bboxes(&mask);
    if clusters.is_empty() {
        img.to_rgb8()
            .save(output_path)
            .map_err(|e| format!("save (no mask): {e}"))?;
        return Ok(());
    }

    let spec =
        find_model("lama-onnx").ok_or_else(|| "model spec not found: lama-onnx".to_string())?;
    let session = runtime.get_session(&spec).await?;

    // work に修復結果を積み上げる。後続クラスタのクロップは修復済み画素を文脈として見る
    // (隣接クラスタの境界に矛盾した模様が出にくい)。
    //
    // クラスタ単位の失敗は全体を止めない: LaMa の FFC ノードが環境依存で稀に失敗する
    // (実機 2026-07-03: 'GetElementType is not implemented'。テストでは未再現)。
    // 失敗したクラスタは元画素のまま残し (=その箇所だけ消えない)、他クラスタと
    // パイプライン全体は続行する。全クラスタ失敗時のみ Err を返す。
    let mut work = img.to_rgb8();
    let mut failed = 0usize;
    let mut lama_attempted = 0usize;
    let mut last_error = String::new();
    // 滑らか文脈クラスタは補間フィルへ回す (LaMa はここで幻覚を出す)。
    let mut smooth_mask: Option<ImageBuffer<Luma<u8>, Vec<u8>>> = None;
    let mut lama_thin_clusters: Vec<[u32; 4]> = Vec::new();
    for bbox in &clusters {
        // 塗り方の自動使い分け: 文脈が滑らか → 決定論補間 / 複雑 → LaMa。
        let context_std = context_luma_std(&work, &mask, *bbox, orig_w, orig_h);
        if context_std < SMOOTH_CONTEXT_STD {
            tracing::info!(
                target: "codex.edit",
                "inpaint: cluster bbox={:?} 滑らか文脈 (std={:.1}) → 補間フィル",
                bbox,
                context_std
            );
            let sm = smooth_mask
                .get_or_insert_with(|| ImageBuffer::from_pixel(orig_w, orig_h, Luma([0u8])));
            let [bx, by, bw, bh] = *bbox;
            for y in by..(by + bh).min(orig_h) {
                for x in bx..(bx + bw).min(orig_w) {
                    if mask.get_pixel(x, y)[0] > 127 {
                        sm.put_pixel(x, y, Luma([255u8]));
                    }
                }
            }
            continue;
        }
        lama_attempted += 1;
        let crop = context_crop(*bbox, orig_w, orig_h);
        let scale = crop[2].max(crop[3]) as f64 / LAMA_SIZE as f64;
        // 細長い帯 (テキスト行等) は縮小せず 512 ネイティブタイルの列で修復する。
        // 縮小修復は消し跡がぼやけ、文字状のノイズが出やすい (実測 2026-07-03)。
        // 太い塊 (人物跡地等) はタイル内が全面マスクになり文脈を失うので従来のクロップ縮小。
        let thin_band = bbox[2].min(bbox[3]) <= THIN_BAND_MAX;
        if thin_band {
            lama_thin_clusters.push(*bbox);
        }
        let result = if scale > 1.05 && thin_band && orig_w.min(orig_h) >= LAMA_SIZE {
            let tiles = native_tiles(*bbox, orig_w, orig_h);
            tracing::info!(
                target: "codex.edit",
                "inpaint: cluster bbox={:?} をネイティブ{}タイルで修復",
                bbox,
                tiles.len()
            );
            let mut tile_result = Ok(());
            for tile in tiles {
                if let Err(e) = inpaint_crop(&session, &mut work, &mask, tile).await {
                    tile_result = Err(e);
                    break;
                }
            }
            tile_result
        } else {
            tracing::info!(
                target: "codex.edit",
                "inpaint: cluster bbox={:?} crop={:?} (縮小率 {:.2}x)",
                bbox,
                crop,
                scale
            );
            inpaint_crop(&session, &mut work, &mask, crop).await
        };
        if let Err(reason) = result {
            failed += 1;
            tracing::warn!(
                target: "codex.edit",
                "inpaint: cluster bbox={bbox:?} の修復に失敗、元画素のまま続行 ({reason})"
            );
            last_error = reason;
        }
    }
    if lama_attempted > 0 && failed == lama_attempted && smooth_mask.is_none() {
        return Err(format!(
            "inpaint: 全{failed}クラスタの修復に失敗 (最後のエラー: {last_error})"
        ));
    }

    // 滑らか文脈クラスタをまとめて補間フィル (決定論・瞬時・幻覚ゼロ)。
    if let Some(sm) = smooth_mask.as_ref() {
        fill_masked_interpolate(&mut work, sm);
    }

    // 仕上げ: 消し跡の残渣再修復 (2026-07-03)。LaMa は暗い背景上の文字帯に、明るい
    // グリフ状の模様を幻覚する癖がある (fp32/int8・縮小/ネイティブの全条件で実測)。
    // 修復画素のうち周辺の無傷背景から輝度が大きく外れたものを残渣として検出し、
    // その画素だけ1回再修復する。2回目は幻覚の種 (文字のグロー等) がもう存在しない
    // ため、周辺のきれいな背景から埋まる。対象は細長い帯クラスタのみ (物体跡地の
    // 正当なハイライト補完を巻き込まない)。
    let mut residue = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(orig_w, orig_h, Luma([0u8]));
    let mut residue_area = 0u64;
    for bbox in &lama_thin_clusters {
        residue_area += mark_residue(&work, &mask, *bbox, orig_w, orig_h, &mut residue);
    }
    if residue_area > 0 {
        let residue = crate::edit::grab::dilate_mask_pub(&residue, 4);
        tracing::info!(
            target: "codex.edit",
            "inpaint: 残渣{}pxを検出、再修復パスを実行",
            residue_area
        );
        for bbox in mask_cluster_bboxes(&residue) {
            let crop = context_crop(bbox, orig_w, orig_h);
            if let Err(reason) = inpaint_crop(&session, &mut work, &residue, crop).await {
                tracing::warn!(target: "codex.edit", "inpaint: 残渣再修復に失敗、そのまま続行 ({reason})");
            }
        }
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    work.save(output_path).map_err(|e| format!("save: {e}"))?;
    Ok(())
}

/// 残渣検出: クラスタの文脈クロップ内で、無傷背景の輝度分布 (p5/p95) から大きく外れた
/// 修復画素を residue へ白でマークする。マークした画素数を返す。
///
/// なぜ p5/p95 基準か: 平均±閾値だと光筋等のグラデーションで誤検出する。無傷画素の
/// 5〜95 パーセンタイル帯 + マージンを「背景としてありえる輝度」とみなし、そこから
/// 外れた修復画素 (暗い壁の上の白い幻覚 = p95 超え) だけを残渣と判定する。
const RESIDUE_MARGIN: i32 = 40;

/// クラスタの文脈クロップ内の無傷画素の輝度標準偏差 (塗り方選択用)。
fn context_luma_std(
    work: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    bbox: [u32; 4],
    orig_w: u32,
    orig_h: u32,
) -> f64 {
    let [cx, cy, cw, ch] = context_crop(bbox, orig_w, orig_h);
    let mut sum = 0f64;
    let mut sq = 0f64;
    let mut n = 0f64;
    for yy in cy..cy + ch {
        for xx in cx..cx + cw {
            if mask.get_pixel(xx, yy)[0] <= 127 {
                let p = work.get_pixel(xx, yy);
                let l = (299 * p[0] as u32 + 587 * p[1] as u32 + 114 * p[2] as u32) as f64 / 1000.0;
                sum += l;
                sq += l * l;
                n += 1.0;
            }
        }
    }
    if n < 100.0 {
        // 文脈が無いに等しい → 複雑扱い (LaMa に任せる)。
        return f64::MAX;
    }
    let mean = sum / n;
    (sq / n - mean * mean).max(0.0).sqrt()
}

fn mark_residue(
    work: &ImageBuffer<Rgb<u8>, Vec<u8>>,
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    bbox: [u32; 4],
    orig_w: u32,
    orig_h: u32,
    residue: &mut ImageBuffer<Luma<u8>, Vec<u8>>,
) -> u64 {
    let [cx, cy, cw, ch] = context_crop(bbox, orig_w, orig_h);
    let luma =
        |p: &Rgb<u8>| -> i32 { (299 * p[0] as i32 + 587 * p[1] as i32 + 114 * p[2] as i32) / 1000 };

    // 無傷画素の輝度ヒストグラムから p5/p95 を取る。
    let mut hist = [0u64; 256];
    let mut total = 0u64;
    for yy in cy..cy + ch {
        for xx in cx..cx + cw {
            if mask.get_pixel(xx, yy)[0] <= 127 {
                hist[luma(work.get_pixel(xx, yy)) as usize] += 1;
                total += 1;
            }
        }
    }
    if total < 1000 {
        return 0; // 文脈が少なすぎて分布が信用できない。
    }
    let percentile = |q: f64| -> i32 {
        let target = (total as f64 * q) as u64;
        let mut acc = 0u64;
        for (v, &count) in hist.iter().enumerate() {
            acc += count;
            if acc >= target {
                return v as i32;
            }
        }
        255
    };
    let low = percentile(0.05) - RESIDUE_MARGIN;
    let high = percentile(0.95) + RESIDUE_MARGIN;

    let mut marked = 0u64;
    for yy in cy..cy + ch {
        for xx in cx..cx + cw {
            if mask.get_pixel(xx, yy)[0] > 127 {
                let v = luma(work.get_pixel(xx, yy));
                if v < low || v > high {
                    residue.put_pixel(xx, yy, Luma([255u8]));
                    marked += 1;
                }
            }
        }
    }
    marked
}

/// クロップ領域を 512x512 で LaMa 修復し、クロップ内のマスク画素だけ work へ書き戻す。
async fn inpaint_crop(
    session: &std::sync::Arc<tokio::sync::Mutex<ort::session::Session>>,
    work: &mut ImageBuffer<Rgb<u8>, Vec<u8>>,
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    crop: [u32; 4],
) -> Result<(), String> {
    let [cx, cy, cw, ch] = crop;

    let crop_img = image::imageops::crop_imm(work, cx, cy, cw, ch).to_image();
    let crop_mask = image::imageops::crop_imm(mask, cx, cy, cw, ch).to_image();

    let img_512 = image::imageops::resize(
        &crop_img,
        LAMA_SIZE,
        LAMA_SIZE,
        image::imageops::FilterType::Lanczos3,
    );
    let mask_512 = image::imageops::resize(
        &crop_mask,
        LAMA_SIZE,
        LAMA_SIZE,
        image::imageops::FilterType::Nearest,
    );

    let plane = (LAMA_SIZE * LAMA_SIZE) as usize;
    let mut img_data = vec![0f32; plane * 3];
    let mut mask_data = vec![0f32; plane];
    for (i, p) in img_512.pixels().enumerate() {
        img_data[i] = p[0] as f32 / 255.0;
        img_data[plane + i] = p[1] as f32 / 255.0;
        img_data[plane * 2 + i] = p[2] as f32 / 255.0;
    }
    for (i, p) in mask_512.pixels().enumerate() {
        mask_data[i] = if p[0] > 127 { 1.0 } else { 0.0 };
        // マスク下の画素を入力段でゼロ化する。LaMa 本家は forward 内で img*(1-mask) するが、
        // この ONNX export が同処理を内包している保証がない。実測 (2026-07-03): ゼロ化なしだと
        // 消したはずの文字が読める形で復元される (=マスク越しに元画素が漏れている)。
        // export が内包していてもゼロ化は no-op なので、常に行って安全側に倒す。
        if mask_data[i] >= 1.0 {
            img_data[i] = 0.0;
            img_data[plane + i] = 0.0;
            img_data[plane * 2 + i] = 0.0;
        }
    }

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

    let out_512 = {
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
        let mut out = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(LAMA_SIZE, LAMA_SIZE);
        for y in 0..LAMA_SIZE {
            for x in 0..LAMA_SIZE {
                let i = (y * LAMA_SIZE + x) as usize;
                out.put_pixel(
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
        out
    };

    // クロップ寸法へ戻し、マスク画素だけ合成する (マスク外は原画素のまま)。
    let out_crop = image::imageops::resize(&out_512, cw, ch, image::imageops::FilterType::Lanczos3);
    for yy in 0..ch {
        for xx in 0..cw {
            if crop_mask.get_pixel(xx, yy)[0] > 127 {
                work.put_pixel(cx + xx, cy + yy, *out_crop.get_pixel(xx, yy));
            }
        }
    }
    Ok(())
}

/// テキスト消去の正規経路: マスクを決定論補間で埋めて保存する (LaMa 不使用)。
/// 入出力はファイルパス (magic_layer / edit_words のテキスト消去から呼ぶ)。
pub fn remove_text_by_interpolation(
    input_path: &Path,
    mask_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut img = image::open(input_path)
        .map_err(|e| format!("open: {e}"))?
        .to_rgb8();
    let mask = image::open(mask_path)
        .map_err(|e| format!("mask open: {e}"))?
        .to_luma8();
    if mask.dimensions() != img.dimensions() {
        return Err("text mask size mismatch".to_string());
    }
    fill_masked_interpolate(&mut img, &mask);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    img.save(output_path).map_err(|e| format!("save: {e}"))
}

/// テキスト帯用の決定論フィル: マスク画素を上下左右の最近傍無傷画素から距離加重で
/// 補間し、マスク内だけ平滑化する。LaMa を使わない。
///
/// なぜ (2026-07-03 実測): LaMa は文字帯の穴に明るいグリフ状の模様を幻覚する癖があり、
/// マスク方式 (ストローク/矩形)・解像度 (縮小/ネイティブ)・残渣再修復のどの組でも
/// 完全には消えなかった。文字は細い帯なので、上下の無傷背景からの補間で十分自然に
/// 埋まり、決定論なので毎回同じ結果になる (STΛCK指摘「テキストは別ロジックに」)。
pub fn fill_masked_interpolate(
    img: &mut ImageBuffer<Rgb<u8>, Vec<u8>>,
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
) {
    let (w, h) = img.dimensions();
    if mask.dimensions() != (w, h) || w == 0 || h == 0 {
        return;
    }
    let masked = |x: u32, y: u32| mask.get_pixel(x, y)[0] > 127;

    // 各方向の最近傍無傷画素 (距離と色) を2パスずつで前計算する。
    type Ref = Option<(u32, [f64; 3])>;
    let mut up: Vec<Ref> = vec![None; (w * h) as usize];
    let mut down: Vec<Ref> = vec![None; (w * h) as usize];
    let mut left: Vec<Ref> = vec![None; (w * h) as usize];
    let mut right: Vec<Ref> = vec![None; (w * h) as usize];
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let color = |img: &ImageBuffer<Rgb<u8>, Vec<u8>>, x: u32, y: u32| -> [f64; 3] {
        let p = img.get_pixel(x, y);
        [p[0] as f64, p[1] as f64, p[2] as f64]
    };

    for x in 0..w {
        let mut last: Option<(u32, [f64; 3])> = None;
        for y in 0..h {
            if masked(x, y) {
                up[idx(x, y)] = last.map(|(ly, c)| (y - ly, c));
            } else {
                last = Some((y, color(img, x, y)));
            }
        }
        let mut last: Option<(u32, [f64; 3])> = None;
        for y in (0..h).rev() {
            if masked(x, y) {
                down[idx(x, y)] = last.map(|(ly, c)| (ly - y, c));
            } else {
                last = Some((y, color(img, x, y)));
            }
        }
    }
    for y in 0..h {
        let mut last: Option<(u32, [f64; 3])> = None;
        for x in 0..w {
            if masked(x, y) {
                left[idx(x, y)] = last.map(|(lx, c)| (x - lx, c));
            } else {
                last = Some((x, color(img, x, y)));
            }
        }
        let mut last: Option<(u32, [f64; 3])> = None;
        for x in (0..w).rev() {
            if masked(x, y) {
                right[idx(x, y)] = last.map(|(lx, c)| (lx - x, c));
            } else {
                last = Some((x, color(img, x, y)));
            }
        }
    }

    // 距離加重 (1/d) で4方向を合成。
    for y in 0..h {
        for x in 0..w {
            if !masked(x, y) {
                continue;
            }
            let mut acc = [0f64; 3];
            let mut weight = 0f64;
            for r in [&up, &down, &left, &right] {
                if let Some((d, c)) = r[idx(x, y)] {
                    let wgt = 1.0 / (d.max(1) as f64);
                    for ch in 0..3 {
                        acc[ch] += c[ch] * wgt;
                    }
                    weight += wgt;
                }
            }
            if weight > 0.0 {
                img.put_pixel(
                    x,
                    y,
                    Rgb([
                        (acc[0] / weight).round().clamp(0.0, 255.0) as u8,
                        (acc[1] / weight).round().clamp(0.0, 255.0) as u8,
                        (acc[2] / weight).round().clamp(0.0, 255.0) as u8,
                    ]),
                );
            }
        }
    }

    // マスク内だけ 3x3 平均を2回かけ、列方向の筋を均す。
    for _ in 0..2 {
        let snapshot = img.clone();
        for y in 0..h {
            for x in 0..w {
                if !masked(x, y) {
                    continue;
                }
                let mut acc = [0u32; 3];
                let mut n = 0u32;
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let p = snapshot.get_pixel(nx as u32, ny as u32);
                        acc[0] += p[0] as u32;
                        acc[1] += p[1] as u32;
                        acc[2] += p[2] as u32;
                        n += 1;
                    }
                }
                img.put_pixel(
                    x,
                    y,
                    Rgb([(acc[0] / n) as u8, (acc[1] / n) as u8, (acc[2] / n) as u8]),
                );
            }
        }
    }
}

/// マスクをクラスタ (近接断片をまとめた連結成分) に分け、各クラスタの bbox を返す。
/// 面積順ではなく走査順。空マスクなら空 Vec。
fn mask_cluster_bboxes(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> Vec<[u32; 4]> {
    let (w, h) = mask.dimensions();
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let linked = crate::edit::grab::dilate_mask_pub(mask, CLUSTER_LINK_RADIUS);
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let mut labels: Vec<u32> = vec![0; (w * h) as usize];
    let mut next_label = 0u32;
    let mut queue: Vec<(u32, u32)> = Vec::new();
    // ラベルごとの bbox は「元マスクの白画素」だけで作る (膨張分を含めない)。
    let mut bboxes: Vec<Option<[u32; 4]>> = vec![None];

    for sy in 0..h {
        for sx in 0..w {
            if linked.get_pixel(sx, sy)[0] <= 127 || labels[idx(sx, sy)] != 0 {
                continue;
            }
            next_label += 1;
            bboxes.push(None);
            labels[idx(sx, sy)] = next_label;
            queue.clear();
            queue.push((sx, sy));
            while let Some((x, y)) = queue.pop() {
                if mask.get_pixel(x, y)[0] > 127 {
                    let b = &mut bboxes[next_label as usize];
                    *b = Some(match *b {
                        None => [x, y, x, y],
                        Some([x0, y0, x1, y1]) => [x0.min(x), y0.min(y), x1.max(x), y1.max(y)],
                    });
                }
                let mut visit = |nx: u32, ny: u32, queue: &mut Vec<(u32, u32)>| {
                    if linked.get_pixel(nx, ny)[0] > 127 && labels[idx(nx, ny)] == 0 {
                        labels[idx(nx, ny)] = next_label;
                        queue.push((nx, ny));
                    }
                };
                if x > 0 {
                    visit(x - 1, y, &mut queue);
                }
                if x + 1 < w {
                    visit(x + 1, y, &mut queue);
                }
                if y > 0 {
                    visit(x, y - 1, &mut queue);
                }
                if y + 1 < h {
                    visit(x, y + 1, &mut queue);
                }
            }
        }
    }

    bboxes
        .into_iter()
        .flatten()
        .map(|[x0, y0, x1, y1]| [x0, y0, x1 - x0 + 1, y1 - y0 + 1])
        .collect()
}

/// 細長い帯マスクを覆う 512 ネイティブタイル列を返す。帯の長軸に沿って
/// TILE_MARGIN ずつ重ねながら並べ、各タイルは画像内にクランプする。
/// 前提: 画像短辺 >= LAMA_SIZE (呼び出し側で確認済み)。
fn native_tiles(bbox: [u32; 4], w: u32, h: u32) -> Vec<[u32; 4]> {
    let side = LAMA_SIZE.min(w).min(h);
    let [bx, by, bw, bh] = bbox;
    let step = (side - 2 * TILE_MARGIN).max(1);
    let mut tiles = Vec::new();
    if bw >= bh {
        // 横帯: y はバンド中心に固定、x をスライドする。
        let ty = (by + bh / 2).saturating_sub(side / 2).min(h - side);
        let end = (bx + bw + TILE_MARGIN).min(w);
        let mut x = bx.saturating_sub(TILE_MARGIN);
        loop {
            let tx = x.min(w - side);
            tiles.push([tx, ty, side, side]);
            if tx + side >= end {
                break;
            }
            x += step;
        }
    } else {
        // 縦帯: x をバンド中心に固定、y をスライドする。
        let tx = (bx + bw / 2).saturating_sub(side / 2).min(w - side);
        let end = (by + bh + TILE_MARGIN).min(h);
        let mut y = by.saturating_sub(TILE_MARGIN);
        loop {
            let ty = y.min(h - side);
            tiles.push([tx, ty, side, side]);
            if ty + side >= end {
                break;
            }
            y += step;
        }
    }
    tiles
}

/// マスク bbox の周辺文脈を含む正方形寄りのクロップ領域を返す ([x, y, w, h])。
///
/// 一辺 = clamp(マスク長辺の2倍, MIN_CROP_SIDE, 画像短辺)。bbox 中心に置き、画像内に
/// クランプする。マスクが画像短辺より大きいときは正方形にできないため、bbox を包含する
/// 範囲まで辺を伸ばす (縮小率は上がるが欠けはしない)。
fn context_crop(bbox: [u32; 4], w: u32, h: u32) -> [u32; 4] {
    let [bx, by, bw, bh] = bbox;
    let side = (bw.max(bh).saturating_mul(2))
        .max(MIN_CROP_SIDE)
        .min(w.min(h));
    // 一辺 side の正方形で bbox を包含できないときは、その軸だけ bbox サイズまで広げる。
    let cw = side.max(bw).min(w);
    let ch = side.max(bh).min(h);
    let cx = (bx + bw / 2).saturating_sub(cw / 2).min(w - cw);
    let cy = (by + bh / 2).saturating_sub(ch / 2).min(h - ch);
    // bbox がクロップからはみ出す場合は端に寄せて包含する。
    let cx = cx.min(bx).max((bx + bw).saturating_sub(cw));
    let cy = cy.min(by).max((by + bh).saturating_sub(ch));
    [cx, cy, cw, ch]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// LaMa ONNX の入出力シェイプを実物から出力する診断プローブ (モデルDL済み環境専用)。
    ///   cargo test --lib edit::inpaint::tests::lama_session_io_probe -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn lama_session_io_probe() {
        let runtime = EditRuntime::new();
        let spec = find_model("lama-onnx").expect("spec");
        let session = runtime.get_session(&spec).await.expect("session");
        let session = session.lock().await;
        for input in session.inputs() {
            eprintln!("[lama] input: {} {:?}", input.name(), input.dtype());
        }
        for output in session.outputs() {
            eprintln!("[lama] output: {} {:?}", output.name(), output.dtype());
        }
    }

    fn blank(w: u32, h: u32) -> ImageBuffer<Luma<u8>, Vec<u8>> {
        ImageBuffer::from_pixel(w, h, Luma([0u8]))
    }

    fn fill_rect(m: &mut ImageBuffer<Luma<u8>, Vec<u8>>, x0: u32, y0: u32, x1: u32, y1: u32) {
        for y in y0..y1 {
            for x in x0..x1 {
                m.put_pixel(x, y, Luma([255u8]));
            }
        }
    }

    fn contains(crop: [u32; 4], bbox: [u32; 4]) -> bool {
        crop[0] <= bbox[0]
            && crop[1] <= bbox[1]
            && crop[0] + crop[2] >= bbox[0] + bbox[2]
            && crop[1] + crop[3] >= bbox[1] + bbox[3]
    }

    #[test]
    fn clusters_merge_nearby_and_split_distant() {
        let mut m = blank(1600, 900);
        fill_rect(&mut m, 100, 100, 300, 130); // 行1
        fill_rect(&mut m, 100, 150, 300, 180); // 行2 (20px 下 → 同クラスタ)
        fill_rect(&mut m, 1200, 700, 1300, 760); // 遠い塊 (別クラスタ)
        let clusters = mask_cluster_bboxes(&m);
        assert_eq!(clusters.len(), 2, "clusters={clusters:?}");
    }

    #[test]
    fn empty_mask_has_no_clusters() {
        assert!(mask_cluster_bboxes(&blank(64, 64)).is_empty());
    }

    #[test]
    fn context_crop_contains_bbox_and_stays_in_bounds() {
        let (w, h) = (1672u32, 941u32);
        for bbox in [
            [94, 456, 732, 42],   // 横長タイトル (実測値)
            [415, 592, 185, 178], // ボール
            [0, 0, 40, 40],       // 左上角
            [1600, 900, 72, 41],  // 右下角
            [10, 10, 1650, 900],  // ほぼ全面
        ] {
            let crop = context_crop(bbox, w, h);
            assert!(contains(crop, bbox), "bbox={bbox:?} crop={crop:?}");
            assert!(
                crop[0] + crop[2] <= w && crop[1] + crop[3] <= h,
                "crop={crop:?}"
            );
            assert!(crop[2] >= MIN_CROP_SIDE.min(w) || crop[2] >= bbox[2]);
        }
    }

    #[test]
    fn context_crop_small_mask_is_native_resolution() {
        // 小さいマスクのクロップは 512 一辺 → LaMa 入力で縮小なし (等倍修復)。
        let crop = context_crop([800, 400, 60, 60], 1672, 941);
        assert_eq!((crop[2], crop[3]), (512, 512));
    }

    #[test]
    fn native_tiles_cover_horizontal_band() {
        // 実測のタイトル帯 (739x101) 相当。全タイルが 512 ネイティブで帯全域を覆う。
        let bbox = [86u32, 396, 739, 101];
        let (w, h) = (1672u32, 941u32);
        let tiles = native_tiles(bbox, w, h);
        assert!(tiles.len() >= 2, "tiles={tiles:?}");
        for t in &tiles {
            assert_eq!((t[2], t[3]), (512, 512));
            assert!(t[0] + t[2] <= w && t[1] + t[3] <= h);
            // バンドの縦範囲を必ず含む。
            assert!(t[1] <= bbox[1] && t[1] + t[3] >= bbox[1] + bbox[3]);
        }
        // x 方向の被覆: バンド左端〜右端が少なくとも1タイルに含まれる。
        let covers = |px: u32| tiles.iter().any(|t| t[0] <= px && px < t[0] + t[2]);
        assert!(covers(bbox[0]));
        assert!(covers(bbox[0] + bbox[2] - 1));
        assert!(covers(bbox[0] + bbox[2] / 2));
    }

    #[test]
    fn native_tiles_cover_vertical_band() {
        let bbox = [800u32, 100, 80, 700];
        let (w, h) = (1672u32, 941u32);
        let tiles = native_tiles(bbox, w, h);
        for t in &tiles {
            assert_eq!((t[2], t[3]), (512, 512));
            assert!(t[0] + t[2] <= w && t[1] + t[3] <= h);
            assert!(t[0] <= bbox[0] && t[0] + t[2] >= bbox[0] + bbox[2]);
        }
        let covers = |py: u32| tiles.iter().any(|t| t[1] <= py && py < t[1] + t[3]);
        assert!(covers(bbox[1]));
        assert!(covers(bbox[1] + bbox[3] - 1));
    }
}
