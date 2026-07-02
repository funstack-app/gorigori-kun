use std::path::Path;

use image::{ImageBuffer, Luma};

use crate::edit::sam2::Sam2Session;

/// 自動物体分解のグリッド走査パラメータ。
///
/// 変更方法: 各定数を直接書き換える。UI から可変にしたいのは「採用数の多寡」だけなので
/// 点数・閾値はコード定数に固定し、採用数は run_auto_object_masks の引数で受ける
/// (MagicLayerPanel のトグルから渡ってくる)。
///
/// なぜこの値か:
/// - GRID: 16x16 = 256 点。SAM2 の公式 automatic mask generator は 32x32 を既定とするが、
///   ここは encoder 1 回 + decoder を点数分回すため、点数がそのまま速度に効く。物体レイヤー化は
///   「主要物体だけ拾えれば十分」で細部の網羅は不要なので 16x16 に落として速度を優先する。
/// - EDGE_MARGIN: 端 6% を避ける。画像の縁ちょうどのクリックは背景や見切れた物体を拾いやすく、
///   レイヤーとして役に立たないため走査対象から外す。
const GRID: u32 = 16;
const EDGE_MARGIN: f32 = 0.06;

/// 面積下限: 画像全体の 0.5%。これ未満は「小さすぎてレイヤーにする価値がない断片」として捨てる。
const MIN_AREA_RATIO: f64 = 0.005;
/// 面積上限: 画像全体の 90%。これ超は「背景丸ごと」を拾っている扱いで捨てる (物体ではない)。
const MAX_AREA_RATIO: f64 = 0.90;
/// 予測スコア下限。SAM2 の IoU 予測がこれ未満のマスクは信頼できないので捨てる。
const MIN_SCORE: f32 = 0.80;
/// NMS の IoU 閾値。これを超えて重なる 2 マスクは同一物体とみなし、高スコア側だけ残す。
const NMS_IOU: f64 = 0.60;
/// 既存レイヤー (人物/テキスト) との重複判定閾値。物体マスクの面積のうちこの割合以上が
/// 既存領域に覆われていたら「二重レイヤー」として除外する (カバー率ベース)。
const EXISTING_OVERLAP_COVER: f64 = 0.50;

/// 採用物体数の上限 (安全弁)。UI で「多め」を選んでもこれを超えない。
/// なぜ上限: 過去評価で「17パーツが平らに並ぶと非エンジニアに認知負荷」の指摘があり、
/// レイヤー数を絞ることを優先する。
pub const MAX_OBJECTS_HARD_CAP: usize = 12;
/// 既定の採用物体数 (UI トグル「自動」相当)。
pub const DEFAULT_OBJECT_COUNT: usize = 6;

/// 採用された物体マスク 1 件。
#[derive(Debug, Clone)]
pub struct ObjectMask {
    /// 元画像同寸の 2 値マスク (255=対象)。grab.rs の切り抜きロジックへ渡す。
    pub mask: ImageBuffer<Luma<u8>, Vec<u8>>,
    /// SAM2 IoU 予測スコア。診断/将来のマニフェスト記録用に保持 (現状は未消費)。
    #[allow(dead_code)]
    pub score: f32,
    /// マスクの白画素数。診断/将来のソート再利用用に保持 (現状は呼び出し側で未消費)。
    #[allow(dead_code)]
    pub area: u64,
}

/// 内部候補 (フィルタ/NMS 前)。
struct Candidate {
    mask: ImageBuffer<Luma<u8>, Vec<u8>>,
    score: f32,
    area: u64,
}

/// 自動物体分解の本体。embed 済みの SAM2 セッションを使い、グリッド点を総当たり predict →
/// 面積/スコアフィルタ → 既存レイヤー(人物/テキスト)との重複除外 → NMS 重複排除 →
/// 面積順に上位 N 個を返す。
///
/// # 引数
/// - `session`: 既に `embed_image` 済みの SAM2 セッション。encoder は呼ばない。
/// - `exclude_mask`: 人物マスク・テキスト領域を白(>127)で塗った元画像同寸マスク。
///    None のとき重複除外はスキップ。
/// - `max_objects`: 採用する物体数の上限 (`MAX_OBJECTS_HARD_CAP` で頭打ち)。
///
/// # なぜ SAM2 を単一正クリック点で回すか
/// grab.rs / edit_sam2 と同じ「1 正クリック点でその位置の物体を切り出す」経路を流用する。
/// 公式の自動マスク生成 (mask NMS + stability score) をフル移植せず、既存の
/// decoder 呼び出しをグリッド化するだけにして実装面積とモデル依存を最小化する。
pub async fn run_auto_object_masks(
    session: &Sam2Session,
    exclude_mask: Option<&ImageBuffer<Luma<u8>, Vec<u8>>>,
    max_objects: usize,
) -> Result<Vec<ObjectMask>, String> {
    let n = max_objects.min(MAX_OBJECTS_HARD_CAP).max(1);

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut total_pixels: Option<u64> = None;

    for gy in 0..GRID {
        for gx in 0..GRID {
            // グリッド点を [EDGE_MARGIN, 1-EDGE_MARGIN] に写像 (端を避ける)。
            let fx = EDGE_MARGIN + (gx as f32 + 0.5) / GRID as f32 * (1.0 - 2.0 * EDGE_MARGIN);
            let fy = EDGE_MARGIN + (gy as f32 + 0.5) / GRID as f32 * (1.0 - 2.0 * EDGE_MARGIN);

            let raw = match session.predict_raw_mask((fx, fy)).await {
                Ok(raw) => raw,
                // 1 点の失敗で全体を止めない (一部の点で decoder が転けても他の点は活きる)。
                Err(_) => continue,
            };

            if raw.score < MIN_SCORE {
                continue;
            }

            let tp = *total_pixels
                .get_or_insert_with(|| raw.width as u64 * raw.height as u64);
            let area = count_white(&raw.mask);
            let min_area = (tp as f64 * MIN_AREA_RATIO) as u64;
            let max_area = (tp as f64 * MAX_AREA_RATIO) as u64;
            if area < min_area || area > max_area {
                continue;
            }

            // 既存レイヤー(人物/テキスト)と大きく重なるマスクは二重化になるので除外。
            if let Some(existing) = exclude_mask {
                let covered = covered_by(&raw.mask, existing, area);
                if covered >= EXISTING_OVERLAP_COVER {
                    continue;
                }
            }

            candidates.push(Candidate {
                mask: raw.mask,
                score: raw.score,
                area,
            });
        }
    }

    // NMS 重複排除: 高スコア順に見て、既採用と IoU>NMS_IOU なら捨てる。
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<Candidate> = Vec::new();
    for cand in candidates {
        let overlaps = kept
            .iter()
            .any(|k| mask_iou(&cand.mask, &k.mask, cand.area, k.area) > NMS_IOU);
        if !overlaps {
            kept.push(cand);
        }
    }

    // 面積順 (大きい物体を優先) に並べ替えて上位 N 個を採用。
    kept.sort_by(|a, b| b.area.cmp(&a.area));
    kept.truncate(n);

    Ok(kept
        .into_iter()
        .map(|c| ObjectMask {
            mask: c.mask,
            score: c.score,
            area: c.area,
        })
        .collect())
}

/// 白画素(>127)を数える。
fn count_white(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> u64 {
    mask.pixels().filter(|p| p[0] > 127).count() as u64
}

/// a のうち existing に覆われている割合 (a_area は a の白画素数)。
fn covered_by(
    a: &ImageBuffer<Luma<u8>, Vec<u8>>,
    existing: &ImageBuffer<Luma<u8>, Vec<u8>>,
    a_area: u64,
) -> f64 {
    if a_area == 0 {
        return 0.0;
    }
    // サイズがずれている場合は保守的に重複無し扱い (誤って全物体を捨てないため)。
    if a.dimensions() != existing.dimensions() {
        return 0.0;
    }
    let mut both = 0u64;
    for (pa, pe) in a.pixels().zip(existing.pixels()) {
        if pa[0] > 127 && pe[0] > 127 {
            both += 1;
        }
    }
    both as f64 / a_area as f64
}

/// 2 マスクの IoU (a_area/b_area は各白画素数)。サイズ不一致は 0。
fn mask_iou(
    a: &ImageBuffer<Luma<u8>, Vec<u8>>,
    b: &ImageBuffer<Luma<u8>, Vec<u8>>,
    a_area: u64,
    b_area: u64,
) -> f64 {
    if a.dimensions() != b.dimensions() || (a_area == 0 && b_area == 0) {
        return 0.0;
    }
    let mut inter = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        if pa[0] > 127 && pb[0] > 127 {
            inter += 1;
        }
    }
    let union = a_area + b_area - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// テキスト領域 bbox 群と、あれば人物マスク PNG を合成した「除外マスク」を作る。
/// 元画像同寸。物体分解時に既存レイヤーと二重にならないよう覆う領域を白で塗る。
///
/// - `person_mask_path`: BiRefNet の切り抜きマスク PNG (無ければ None)。
/// - `text_boxes`: `[x, y, w, h]` の配列 (元画像ピクセル座標)。
pub fn build_exclude_mask(
    width: u32,
    height: u32,
    person_mask_path: Option<&Path>,
    text_boxes: &[[i32; 4]],
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let mut mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(width, height, Luma([0u8]));

    if let Some(path) = person_mask_path {
        if let Ok(person) = image::open(path) {
            let person = person.to_luma8();
            let person = if person.width() == width && person.height() == height {
                person
            } else {
                image::imageops::resize(
                    &person,
                    width,
                    height,
                    image::imageops::FilterType::Nearest,
                )
            };
            for (dst, src) in mask.pixels_mut().zip(person.pixels()) {
                if src[0] > 127 {
                    *dst = Luma([255u8]);
                }
            }
        }
    }

    for [x, y, w, h] in text_boxes.iter().copied() {
        if w <= 0 || h <= 0 {
            continue;
        }
        let x0 = x.max(0) as u32;
        let y0 = y.max(0) as u32;
        let x1 = ((x + w).min(width as i32)).max(0) as u32;
        let y1 = ((y + h).min(height as i32)).max(0) as u32;
        for yy in y0..y1 {
            for xx in x0..x1 {
                mask.put_pixel(xx, yy, Luma([255u8]));
            }
        }
    }

    mask
}
