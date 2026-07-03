//! 被写体マスクの離れ小島分離。
//!
//! BiRefNet の salient マスクは「ロボット+ボール」のように複数の独立した被写体を
//! 1枚に融合して返す (実測 2026-07-03 実写プローブ: バスケコートのロボットとボールが
//! 1つの前景レイヤーになり、ボールだけ動かせなかった)。最大連結成分だけを被写体とし、
//! 十分大きい離れ小島は独立した物体レイヤーへ分離できるよう、成分ごとのマスクに割る。

use image::{ImageBuffer, Luma};

/// 離れ小島とみなす最小面積 (画像全体比)。これ未満の断片はノイズとして被写体側に残す
/// (細かい断片を物体レイヤー化するとレイヤー一覧が汚れる)。
const MIN_SATELLITE_AREA_RATIO: f64 = 0.003;
/// 面積比とは別の絶対下限 (px)。小さい画像で比率下限が数px になるのを防ぐ。
const MIN_SATELLITE_AREA_ABS: u64 = 256;
/// 分離する離れ小島の最大数 (安全弁)。マスク破綻で断片が大量に出たときの暴走防止。
const MAX_SATELLITES: usize = 4;
/// 成分連結の橋渡し距離 (px)。この距離以内で近接する断片は同一被写体とみなす
/// (腕と胴が細い隙間で切れて誤分離するのを防ぐ)。
const LINK_RADIUS: i32 = 8;

/// 分離結果。subject_mask + satellites は入力マスクの白画素の分割 (小さすぎる断片は
/// subject 側に残す)。すべて入力と同寸で、画素値は入力のソフトエッジ値を保持する。
pub struct SubjectSplit {
    /// 最大成分 (=主要被写体) のマスク。
    pub subject_mask: ImageBuffer<Luma<u8>, Vec<u8>>,
    /// 被写体から離れた独立成分のマスク群 (面積降順)。
    pub satellites: Vec<ImageBuffer<Luma<u8>, Vec<u8>>>,
}

/// マスクを連結成分に分割し、最大成分を被写体、面積条件を満たす他成分を離れ小島として返す。
///
/// 連結判定は LINK_RADIUS で膨張したマスク上で行い (近接断片の橋渡し)、出力マスクの
/// 画素値は元マスクの値をそのまま使う (ソフトエッジ保持)。成分が1つ以下なら
/// satellites は空で、subject_mask は入力のクローン。
pub fn split_subject_mask(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> SubjectSplit {
    let (w, h) = mask.dimensions();
    let total = w as u64 * h as u64;
    if total == 0 {
        return SubjectSplit {
            subject_mask: mask.clone(),
            satellites: Vec::new(),
        };
    }

    // 橋渡し膨張したマスク上で BFS ラベリング (4連結)。
    let dilated = crate::edit::grab::dilate_mask_pub(mask, LINK_RADIUS);
    let mut labels: Vec<u32> = vec![0; (w * h) as usize];
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let mut next_label: u32 = 0;
    let mut queue: Vec<(u32, u32)> = Vec::new();

    for sy in 0..h {
        for sx in 0..w {
            if dilated.get_pixel(sx, sy)[0] <= 127 || labels[idx(sx, sy)] != 0 {
                continue;
            }
            next_label += 1;
            labels[idx(sx, sy)] = next_label;
            queue.clear();
            queue.push((sx, sy));
            while let Some((x, y)) = queue.pop() {
                let mut visit = |nx: u32, ny: u32| {
                    if dilated.get_pixel(nx, ny)[0] > 127 && labels[idx(nx, ny)] == 0 {
                        labels[idx(nx, ny)] = next_label;
                        queue.push((nx, ny));
                    }
                };
                if x > 0 {
                    visit(x - 1, y);
                }
                if x + 1 < w {
                    visit(x + 1, y);
                }
                if y > 0 {
                    visit(x, y - 1);
                }
                if y + 1 < h {
                    visit(x, y + 1);
                }
            }
        }
    }

    if next_label <= 1 {
        return SubjectSplit {
            subject_mask: mask.clone(),
            satellites: Vec::new(),
        };
    }

    // 成分面積は「元マスクの白画素 (>127)」で数える (膨張分を含めない)。
    let mut areas: Vec<u64> = vec![0; (next_label + 1) as usize];
    for y in 0..h {
        for x in 0..w {
            if mask.get_pixel(x, y)[0] > 127 {
                areas[labels[idx(x, y)] as usize] += 1;
            }
        }
    }

    let subject_label = (1..=next_label)
        .max_by_key(|&l| areas[l as usize])
        .unwrap_or(1);

    // 離れ小島の採用: 面積条件を満たすものを面積降順で最大 MAX_SATELLITES 件。
    let min_area = ((total as f64 * MIN_SATELLITE_AREA_RATIO) as u64).max(MIN_SATELLITE_AREA_ABS);
    let mut satellite_labels: Vec<u32> = (1..=next_label)
        .filter(|&l| l != subject_label && areas[l as usize] >= min_area)
        .collect();
    satellite_labels.sort_by(|&a, &b| areas[b as usize].cmp(&areas[a as usize]));
    satellite_labels.truncate(MAX_SATELLITES);

    if satellite_labels.is_empty() {
        return SubjectSplit {
            subject_mask: mask.clone(),
            satellites: Vec::new(),
        };
    }

    // 出力マスクを構築。元マスクの非ゼロ画素 (ソフトエッジ含む) を成分ラベルで振り分け、
    // 未ラベル or 非採用の小成分は被写体側に残す (従来挙動からの欠落を作らない)。
    let mut subject = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    let mut satellites: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = satellite_labels
        .iter()
        .map(|_| ImageBuffer::from_pixel(w, h, Luma([0u8])))
        .collect();
    for y in 0..h {
        for x in 0..w {
            let v = mask.get_pixel(x, y)[0];
            if v == 0 {
                continue;
            }
            let label = labels[idx(x, y)];
            match satellite_labels.iter().position(|&s| s == label) {
                Some(i) => satellites[i].put_pixel(x, y, Luma([v])),
                None => subject.put_pixel(x, y, Luma([v])),
            }
        }
    }

    SubjectSplit {
        subject_mask: subject,
        satellites,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn count_white(m: &ImageBuffer<Luma<u8>, Vec<u8>>) -> u64 {
        m.pixels().filter(|p| p[0] > 127).count() as u64
    }

    #[test]
    fn splits_distant_ball_from_subject() {
        // ロボ(大きい塊) + ボール(離れた塊) を模す。ボールは面積条件を満たす距離のある島。
        let mut m = blank(400, 300);
        fill_rect(&mut m, 250, 60, 380, 280); // 被写体 130x220
        fill_rect(&mut m, 40, 200, 110, 270); // ボール 70x70 = 4900px (>0.3%=360)
        let split = split_subject_mask(&m);
        assert_eq!(split.satellites.len(), 1, "ボールが分離されない");
        assert_eq!(count_white(&split.satellites[0]), 70 * 70);
        assert_eq!(count_white(&split.subject_mask), 130 * 220);
    }

    #[test]
    fn keeps_nearby_fragments_together() {
        // LINK_RADIUS 以内の隙間で切れた断片 (腕と胴など) は同一被写体のまま。
        let mut m = blank(400, 300);
        fill_rect(&mut m, 100, 50, 200, 250);
        fill_rect(&mut m, 205, 50, 260, 250); // 隙間5px < LINK_RADIUS*2
        let split = split_subject_mask(&m);
        assert!(split.satellites.is_empty(), "近接断片が誤分離された");
    }

    #[test]
    fn tiny_specks_stay_with_subject() {
        // 面積下限未満のノイズ断片は物体化せず被写体側に残る (画素の欠落なし)。
        let mut m = blank(400, 300);
        fill_rect(&mut m, 150, 50, 300, 250);
        fill_rect(&mut m, 20, 20, 30, 30); // 100px < 下限
        let split = split_subject_mask(&m);
        assert!(split.satellites.is_empty());
        assert_eq!(count_white(&split.subject_mask), count_white(&m));
    }

    #[test]
    fn single_component_returns_clone() {
        let mut m = blank(100, 100);
        fill_rect(&mut m, 10, 10, 90, 90);
        let split = split_subject_mask(&m);
        assert!(split.satellites.is_empty());
        assert_eq!(count_white(&split.subject_mask), count_white(&m));
    }

    #[test]
    fn soft_edge_values_are_preserved() {
        // ソフトエッジ (中間値) が出力に保持される。
        let mut m = blank(200, 100);
        fill_rect(&mut m, 10, 20, 70, 80); // 被写体 60x60 (最大成分)
        m.put_pixel(70, 40, Luma([90u8])); // 被写体の縁のソフト画素
        fill_rect(&mut m, 150, 30, 190, 70); // 離れ小島 40x40=1600 (>max(0.3%=60,256))
        let split = split_subject_mask(&m);
        assert_eq!(split.satellites.len(), 1);
        assert_eq!(split.subject_mask.get_pixel(70, 40)[0], 90);
    }
}
