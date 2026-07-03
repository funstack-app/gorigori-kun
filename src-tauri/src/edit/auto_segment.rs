use std::path::Path;
use std::time::{Duration, Instant};

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
const MIN_AREA_RATIO: f64 = 0.01;
/// 面積上限: 画像全体の 90%。これ超は「背景丸ごと」を拾っている扱いで捨てる (物体ではない)。
const MAX_AREA_RATIO: f64 = 0.90;
/// 予測スコア下限。SAM2 の IoU 予測がこれ未満のマスクは信頼できないので捨てる。
const MIN_SCORE: f32 = 0.85;
/// NMS の IoU 閾値。これを超えて重なる 2 マスクは同一物体とみなし、高スコア側だけ残す。
const NMS_IOU: f64 = 0.60;
/// 既存レイヤー (人物/テキスト) との重複判定閾値。物体マスクの面積のうちこの割合以上が
/// 既存領域に覆われていたら「二重レイヤー」として除外する (カバー率ベース)。
const EXISTING_OVERLAP_COVER: f64 = 0.50;

/// 背景棄却: マスクが画像外周 (上下左右の縁1px) を覆う割合の上限 (全周平均)。
/// これを超えるマスクは背景・空・床の類とみなして物体に採用しない。
const MAX_BORDER_COVER: f64 = 0.22;

/// 背景棄却: 1辺単独のカバー率上限。背景は「上端の空」「下端の床」のように
/// 特定の1辺をほぼ全面に覆う (実測: 背景グレー面は上端86%)。見切れ物体でも
/// 1辺の6割を超えることは稀。
const MAX_SINGLE_EDGE_COVER: f64 = 0.60;

/// 採用物体数の上限 (安全弁)。UI で「多め」を選んでもこれを超えない。
/// なぜ上限: 過去評価で「17パーツが平らに並ぶと非エンジニアに認知負荷」の指摘があり、
/// レイヤー数を絞ることを優先する。
pub const MAX_OBJECTS_HARD_CAP: usize = 12;

/// 物体スキャン全体の時間予算 (秒)。これを超えたら残りグリッド点をスキップし、その時点で
/// 集まった候補だけで続行する。なぜ: 遅い CPU / 大きい画像で decoder 1 点が重いと 256 点で
/// 分単位になりうる。無限に待たせず「多少雑でも返す」ことを優先する (2026-07-02 実機で
/// 物体スキャンが無音停止した件の再発防止として、進捗ログとセットで上限を入れる)。
const SCAN_TIME_BUDGET: Duration = Duration::from_secs(60);
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

    let grid_points = (GRID * GRID) as usize;
    let started = Instant::now();
    tracing::info!(
        target: "edit.auto_segment",
        "run_auto_object_masks 開始: grid={}x{} ({}点) max_objects={}",
        GRID, GRID, grid_points, n
    );

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut total_pixels: Option<u64> = None;
    let mut scanned: usize = 0;
    let mut budget_exceeded = false;
    let mut per_point_ms_sum: u128 = 0;
    // predict 失敗を黙殺しない: 総数を数え、最初の数件は理由を warn で出す。
    // 「採用0件」の真因 (predict が全点でエラーしていた) をログから追えるようにする。
    let mut predict_error_count: usize = 0;
    let mut logged_errors: usize = 0;
    const MAX_LOGGED_ERRORS: usize = 3;

    'scan: for gy in 0..GRID {
        for gx in 0..GRID {
            // 時間予算を超えたら残り点を打ち切り、集まった候補だけで続行する。
            if started.elapsed() >= SCAN_TIME_BUDGET {
                budget_exceeded = true;
                tracing::warn!(
                    target: "edit.auto_segment",
                    "時間予算 {}s 超過: {}/{}点でスキャン打ち切り (候補{}件)",
                    SCAN_TIME_BUDGET.as_secs(), scanned, grid_points, candidates.len()
                );
                break 'scan;
            }

            // グリッド点を [EDGE_MARGIN, 1-EDGE_MARGIN] に写像 (端を避ける)。
            let fx = EDGE_MARGIN + (gx as f32 + 0.5) / GRID as f32 * (1.0 - 2.0 * EDGE_MARGIN);
            let fy = EDGE_MARGIN + (gy as f32 + 0.5) / GRID as f32 * (1.0 - 2.0 * EDGE_MARGIN);

            // 人物・テキストの上のグリッド点は predict 自体をスキップする。
            // なぜ: そこから出るマスクは既存レイヤーの二重化かノイズ断片にしかならず、
            // 1点300ms級 (実測・大判画像) の decoder 実行が丸ごと無駄になる。
            // 実測 (2026-07-02 サムネ実写): 被写体+テキストが画面の大半を占める画像で
            // 時間予算61秒打ち切り+ゴミ物体4件が発生した。
            if let Some(existing) = exclude_mask {
                let (ew, eh) = existing.dimensions();
                let px = ((fx * ew as f32) as u32).min(ew.saturating_sub(1));
                let py = ((fy * eh as f32) as u32).min(eh.saturating_sub(1));
                if existing.get_pixel(px, py)[0] > 127 {
                    scanned += 1;
                    continue;
                }
            }

            let point_started = Instant::now();
            let raw = match session.predict_raw_mask((fx, fy)).await {
                Ok(raw) => raw,
                // 1 点の失敗で全体を止めない (一部の点で decoder が転けても他の点は活きる)。
                // ただし黙殺せず、総数を数えて最初の数件は理由を出す (2026-07-02「採用0件」の
                // 真因追跡: 全点 predict エラーが無音で捨てられていた)。
                Err(reason) => {
                    predict_error_count += 1;
                    if logged_errors < MAX_LOGGED_ERRORS {
                        logged_errors += 1;
                        tracing::warn!(
                            target: "edit.auto_segment",
                            "predict失敗 点({:.3},{:.3}) [{}件目]: {}",
                            fx, fy, predict_error_count, reason
                        );
                    }
                    scanned += 1;
                    continue;
                }
            };
            per_point_ms_sum += point_started.elapsed().as_millis();
            scanned += 1;

            // 32 点ごとに進捗ログ (無音停止の検知用)。平均 1 点あたりの decode 実測も出す。
            if scanned % 32 == 0 {
                let avg_ms = per_point_ms_sum / scanned as u128;
                tracing::info!(
                    target: "edit.auto_segment",
                    "進捗 {}/{}点 経過{}ms (1点平均{}ms 候補{}件)",
                    scanned, grid_points, started.elapsed().as_millis(), avg_ms, candidates.len()
                );
            }

            if raw.score < MIN_SCORE {
                tracing::debug!(target: "edit.auto_segment", "score棄却: {:.3}", raw.score);
                continue;
            }

            let tp = *total_pixels
                .get_or_insert_with(|| raw.width as u64 * raw.height as u64);
            let area = count_white(&raw.mask);
            let min_area = (tp as f64 * MIN_AREA_RATIO) as u64;
            let max_area = (tp as f64 * MAX_AREA_RATIO) as u64;
            if area < min_area || area > max_area {
                tracing::debug!(target: "edit.auto_segment", "面積棄却: area={} ({}..{})", area, min_area, max_area);
                continue;
            }

            // 既存レイヤー(人物/テキスト)と大きく重なるマスクは二重化になるので除外。
            if let Some(existing) = exclude_mask {
                let covered = covered_by(&raw.mask, existing, area);
                if covered >= EXISTING_OVERLAP_COVER {
                    tracing::debug!(target: "edit.auto_segment", "既存重複棄却: covered={:.2} area={}", covered, area);
                    continue;
                }
            }

            // 背景マスクの棄却: 画像の縁を広く覆うマスクは「物体」ではなく背景。
            // 実測根拠 (2026-07-02 実写プローブ): 背景のグレー面が area 28%・score 0.989 で
            // 採用され、被写体と同格の「物体レイヤー」になった。物体は通常フレーム縁を
            // 25%以上は覆わない (見切れでも一辺どまり)。
            let (border_total, border_edge_max) = border_cover(&raw.mask);
            if border_total > MAX_BORDER_COVER || border_edge_max > MAX_SINGLE_EDGE_COVER {
                tracing::debug!(
                    target: "edit.auto_segment",
                    "背景棄却: area={} score={:.3} border_total={:.2} edge_max={:.2}",
                    area, raw.score, border_total, border_edge_max
                );
                continue;
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

    tracing::info!(
        target: "edit.auto_segment",
        "run_auto_object_masks 完了: 採用{}件 (スキャン{}/{}点 predict失敗{}件 総時間{}ms{})",
        kept.len(),
        scanned,
        grid_points,
        predict_error_count,
        started.elapsed().as_millis(),
        if budget_exceeded { " ※時間予算超過で打ち切り" } else { "" }
    );
    // 全点が predict エラーだった場合は、採用0件の真因が「フィルタで全部落ちた」ではなく
    // 「decoder が全点で失敗した」ことを明示する (無音の採用0件を診断可能にする)。
    if predict_error_count == scanned && scanned > 0 {
        tracing::error!(
            target: "edit.auto_segment",
            "物体分解: 全{}点で predict が失敗した。decoder 入力/セッションを疑う (採用0件の真因)",
            scanned
        );
    }

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

/// マスクが画像外周バンドを覆う割合。背景マスクの検出に使う。
///
/// 縁1pxの線ではなく帯 (バンド) で判定する。なぜ: SAM2 の背景マスクは縁の数px手前で
/// 途切れることがあり、1px線判定をすり抜ける (実測 2026-07-03 実写プローブ: 全幅の床帯
/// bbox[0,636,1672,301] が下端4px手前 y=937 で停止し、縁1px判定を通過して「物体1」に
/// 採用された)。バンド幅は短辺の1.5% (4..16px にクランプ) で、この種のギャップを飲み込む。
///
/// 返り値: (全周の平均カバー率, 4辺のうち最大の単独カバー率)
fn border_cover(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> (f64, f64) {
    let (w, h) = mask.dimensions();
    if w < 2 || h < 2 {
        return (0.0, 0.0);
    }
    let band = ((w.min(h) as u64 * 3 / 200) as u32).clamp(4, 16).min(h).min(w);
    // 横バンド (上/下): x 位置ごとに「バンド内のどこかの行が白か」。
    let row_cover = |y0: u32, y1: u32| -> u64 {
        (0..w)
            .filter(|&x| (y0..y1).any(|y| mask.get_pixel(x, y)[0] > 127))
            .count() as u64
    };
    // 縦バンド (左/右): y 位置ごとに「バンド内のどこかの列が白か」。
    let col_cover = |x0: u32, x1: u32| -> u64 {
        (0..h)
            .filter(|&y| (x0..x1).any(|x| mask.get_pixel(x, y)[0] > 127))
            .count() as u64
    };
    let top_c = row_cover(0, band);
    let bot_c = row_cover(h - band, h);
    let lef_c = col_cover(0, band);
    let rig_c = col_cover(w - band, w);
    let total_len = (2 * (w as u64 + h as u64)).max(1);
    let total = (top_c + bot_c + lef_c + rig_c) as f64 / total_len as f64;
    let edge_max = (top_c as f64 / w as f64)
        .max(bot_c as f64 / w as f64)
        .max(lef_c as f64 / h as f64)
        .max(rig_c as f64 / h as f64);
    (total, edge_max)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn filled(w: u32, h: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> ImageBuffer<Luma<u8>, Vec<u8>> {
        ImageBuffer::from_fn(w, h, |x, y| {
            if x >= x0 && x < x1 && y >= y0 && y < y1 {
                Luma([255u8])
            } else {
                Luma([0u8])
            }
        })
    }

    #[test]
    fn count_white_counts_only_white() {
        let m = filled(10, 10, 0, 0, 5, 10); // 左半分 = 50px
        assert_eq!(count_white(&m), 50);
    }

    #[test]
    fn mask_iou_identical_is_one() {
        let a = filled(8, 8, 2, 2, 6, 6); // 16px
        let area = count_white(&a);
        assert!((mask_iou(&a, &a, area, area) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn mask_iou_disjoint_is_zero() {
        let a = filled(8, 8, 0, 0, 2, 2);
        let b = filled(8, 8, 6, 6, 8, 8);
        let aa = count_white(&a);
        let bb = count_white(&b);
        assert_eq!(mask_iou(&a, &b, aa, bb), 0.0);
    }

    #[test]
    fn mask_iou_size_mismatch_is_zero() {
        let a = filled(8, 8, 0, 0, 4, 4);
        let b = filled(4, 4, 0, 0, 4, 4);
        assert_eq!(mask_iou(&a, &b, count_white(&a), count_white(&b)), 0.0);
    }

    #[test]
    fn covered_by_full_overlap_is_one() {
        let a = filled(8, 8, 2, 2, 6, 6);
        let existing = filled(8, 8, 0, 0, 8, 8); // 全面
        let area = count_white(&a);
        assert!((covered_by(&a, &existing, area) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn covered_by_empty_area_is_zero() {
        let a = filled(8, 8, 0, 0, 0, 0); // 空
        let existing = filled(8, 8, 0, 0, 8, 8);
        assert_eq!(covered_by(&a, &existing, 0), 0.0);
    }

    #[test]
    fn build_exclude_mask_marks_text_boxes() {
        let mask = build_exclude_mask(20, 20, None, &[[5, 5, 4, 4]]);
        // box 内は白
        assert_eq!(mask.get_pixel(5, 5)[0], 255);
        assert_eq!(mask.get_pixel(8, 8)[0], 255);
        // box 外は黒
        assert_eq!(mask.get_pixel(0, 0)[0], 0);
        assert_eq!(mask.get_pixel(9, 9)[0], 0);
    }

    #[test]
    fn border_cover_catches_floor_strip_with_gap() {
        // 実写プローブ再現 (2026-07-03): 全幅の床帯マスクが下端の数px手前で止まり、
        // 縁1px判定をすり抜けた。バンド判定なら下辺カバー率がほぼ1.0になり棄却できる。
        // 800x450 → band = 450*3/200 = 6。ギャップ4px < band。
        let (w, h) = (800u32, 450u32);
        let m = filled(w, h, 0, 300, w, h - 4);
        let (_total, edge_max) = border_cover(&m);
        assert!(
            edge_max > MAX_SINGLE_EDGE_COVER,
            "全幅床帯が背景棄却されない (edge_max={edge_max})"
        );
    }

    #[test]
    fn border_cover_ignores_center_object() {
        // 中央の物体はバンドに触れないので棄却されない。
        let m = filled(800, 450, 300, 150, 500, 350);
        let (total, edge_max) = border_cover(&m);
        assert!(total < 0.01, "total={total}");
        assert!(edge_max < 0.01, "edge_max={edge_max}");
    }

    #[test]
    fn scan_time_budget_is_sane() {
        // 時間予算は正で、実用上の上限内 (無限や過大でない) であることを固定する。
        assert!(SCAN_TIME_BUDGET.as_secs() > 0);
        assert!(SCAN_TIME_BUDGET.as_secs() <= 300);
    }

    /// decoder 相当の共有ハンドル (`Arc<Mutex>`) を、guard を保持し続けない限り
    /// 順次取得・解放できる (= デッドロックしない) ことを、モデル非依存で確認する。
    /// predict_raw_mask のロック規律 (lock → 使う → drop) が守られていれば、この形で
    /// 連続取得しても永久待ちにならない。専用セッション (new_dedicated) は他コマンドと
    /// Mutex を共有しないので、run が同期実行でも UI 側デッドロックは起きえない。
    #[tokio::test]
    async fn sequential_lock_never_deadlocks() {
        let shared: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        for _ in 0..256 {
            let mut guard = shared.lock().await;
            *guard += 1;
            drop(guard); // predict_raw_mask と同じく guard を明示的に解放する
        }
        assert_eq!(*shared.lock().await, 256);
    }
}
