use std::path::{Path, PathBuf};

use image::{GenericImageView, ImageBuffer, Luma, Rgba};

use crate::edit::inpaint::inpaint_image;
use crate::edit::runtime::EditRuntime;

/// 切り抜き時のエッジ精緻化の既定強度。argmax 由来の二値マスクは縁が数 px 甘いので
/// 1px 締めて背景色のにじみを消し、1px フェザーで階段状の輪郭をアンチエイリアスする。
/// 小さめに固定＝主体をほぼ削らずジャギーだけ抑える安全側。
const EDGE_ERODE_PX: i32 = 1;
const EDGE_FEATHER_PX: i32 = 1;

/// マジックグラブ 1 回分の結果。
/// - object_png: マスク領域だけを切り抜いた透過 PNG。bbox のサイズにクロップ済み。
/// - bbox: 元画像ピクセル座標での [x, y, width, height]。フロントがこの位置に置く。
/// - filled_background_path: 掴んだオブジェクトの穴を LaMa で補完した背景画像。
pub struct GrabResult {
    pub object_png_path: PathBuf,
    pub bbox: [i32; 4],
    pub filled_background_path: PathBuf,
    pub width: u32,
    pub height: u32,
}

/// マスク(白=対象)と元画像から「掴めるオブジェクト透過PNG」と「穴を埋めた背景」を作る。
///
/// なぜこの分離: Canva Magic Grab 相当の体験は「対象をレイヤーとして持ち上げる」+「跡地を
/// 自然に埋める」の2つが揃って初めて成立する。切り抜きだけだと動かした跡が透明の穴になり、
/// 背景補完だけだと持ち上げるレイヤーが無い。両方を1コマンドで返してフロントがアトミックに
/// キャンバスへ反映する。
///
/// object_png はマスクの bbox にクロップして返す。理由: フルサイズ透過PNGを毎回積むと
/// 連続グラブでキャンバスが重くなり、fabric レイヤーの当たり判定も画面全体になってしまう。
/// bbox クロップ + bbox 位置指定なら「掴んだ部分だけ」が動く自然な挙動になる。
pub async fn grab_object(
    runtime: &EditRuntime,
    input_path: &Path,
    mask_path: &Path,
    output_dir: &Path,
) -> Result<GrabResult, String> {
    let img = image::open(input_path).map_err(|e| format!("open input: {e}"))?;
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("input image has zero size".to_string());
    }

    // マスクは SAM2 predict が返すフルサイズ (元画像と同寸) を前提にしつつ、
    // 万一サイズがずれても Nearest で合わせる (マスクは2値なので Nearest が正しい)。
    let mask_luma = image::open(mask_path)
        .map_err(|e| format!("open mask: {e}"))?
        .to_luma8();
    let mask = if mask_luma.width() == orig_w && mask_luma.height() == orig_h {
        mask_luma
    } else {
        image::imageops::resize(
            &mask_luma,
            orig_w,
            orig_h,
            image::imageops::FilterType::Nearest,
        )
    };

    // マスクの bounding box を求める (白=対象がどこにあるか)。
    let bbox = mask_bbox(&mask)
        .ok_or_else(|| "マスクが空です。対象をもう一度クリックしてください。".to_string())?;
    let [bx, by, bw, bh] = bbox;

    // オブジェクト透過PNG: bbox にクロップし、マスクの alpha を焼く。
    // 焼く前にエッジ精緻化（縁を1px締めてハロー除去 + 境界を1pxフェザーでアンチエイリアス）。
    let refined = refine_mask_edge(&mask, EDGE_ERODE_PX, EDGE_FEATHER_PX);
    let rgba = img.to_rgba8();
    let mut object = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(bw, bh);
    for oy in 0..bh {
        for ox in 0..bw {
            let sx = bx + ox;
            let sy = by + oy;
            let alpha = refined.get_pixel(sx, sy)[0];
            let p = rgba.get_pixel(sx, sy);
            object.put_pixel(ox, oy, Rgba([p[0], p[1], p[2], alpha]));
        }
    }

    std::fs::create_dir_all(output_dir).map_err(|e| format!("mkdir grab dir: {e}"))?;
    let object_png_path = output_dir.join("object.png");
    object
        .save(&object_png_path)
        .map_err(|e| format!("save object png: {e}"))?;

    // 背景補完: 穴が確実に消えるようマスクを少し膨張させてから LaMa へ渡す。
    // 元マスクちょうどだと縁に被写体の色が残り「幽霊」が出るため、数px広げて塗る。
    let dilated = dilate_mask(&mask, 6);
    let dilated_mask_path = output_dir.join("grab-mask.png");
    dilated
        .save(&dilated_mask_path)
        .map_err(|e| format!("save dilated mask: {e}"))?;

    let filled_background_path = output_dir.join("filled-background.png");
    inpaint_image(
        runtime,
        input_path,
        &dilated_mask_path,
        &filled_background_path,
    )
    .await?;

    Ok(GrabResult {
        object_png_path,
        // フロントは i32 の [x, y, w, h] を期待する。bbox は画像内の値なので i32 に収まる。
        bbox: [bx as i32, by as i32, bw as i32, bh as i32],
        filled_background_path,
        width: orig_w,
        height: orig_h,
    })
}

/// マスク bbox にクロップした透過 PNG を保存し、[x, y, w, h] を返す (背景補完はしない)。
///
/// grab_object のクロップ部分だけを切り出した再利用ヘルパ。Magic Layer の物体分解では
/// 物体ごとに inpaint せず「全物体+人物の union マスクで背景を一括 inpaint」するため、
/// ここでは切り抜きのみ行う。rgba は元画像の RGBA、mask は元画像同寸の 2 値マスク。
pub fn crop_object_png(
    rgba: &ImageBuffer<Rgba<u8>, Vec<u8>>,
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    output_path: &Path,
) -> Result<[i32; 4], String> {
    let bbox = mask_bbox(mask).ok_or_else(|| "object mask is empty".to_string())?;
    let [bx, by, bw, bh] = bbox;

    // 焼く前にエッジ精緻化（grab_object と同じ処理でジャギー/ハローを抑える）。
    let refined = refine_mask_edge(mask, EDGE_ERODE_PX, EDGE_FEATHER_PX);
    let mut object = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(bw, bh);
    for oy in 0..bh {
        for ox in 0..bw {
            let sx = bx + ox;
            let sy = by + oy;
            let alpha = refined.get_pixel(sx, sy)[0];
            let p = rgba.get_pixel(sx, sy);
            object.put_pixel(ox, oy, Rgba([p[0], p[1], p[2], alpha]));
        }
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir object dir: {e}"))?;
    }
    object
        .save(output_path)
        .map_err(|e| format!("save object png: {e}"))?;

    Ok([bx as i32, by as i32, bw as i32, bh as i32])
}

/// マスクを radius px 膨張させて返す (公開版。auto_segment の union マスクを LaMa へ
/// 渡す前に縁の幽霊を飲み込ませるため)。
pub fn dilate_mask_pub(
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    radius: i32,
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    dilate_mask(mask, radius)
}

/// 白画素 (>127) の存在範囲を [x, y, w, h] で返す。全部黒なら None。
fn mask_bbox(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> Option<[u32; 4]> {
    let (w, h) = mask.dimensions();
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;
    for y in 0..h {
        for x in 0..w {
            if mask.get_pixel(x, y)[0] > 127 {
                found = true;
                if x < min_x {
                    min_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if x > max_x {
                    max_x = x;
                }
                if y > max_y {
                    max_y = y;
                }
            }
        }
    }
    if !found {
        return None;
    }
    Some([min_x, min_y, max_x - min_x + 1, max_y - min_y + 1])
}

/// マスクを radius px 膨張させる (白領域を広げる)。矩形カーネルの単純膨張。
/// LaMa へ渡す前に縁の被写体残りを飲み込ませるため。
fn dilate_mask(
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    radius: i32,
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let (w, h) = mask.dimensions();
    let mut out = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            if mask.get_pixel(x as u32, y as u32)[0] <= 127 {
                continue;
            }
            let x0 = (x - radius).max(0);
            let y0 = (y - radius).max(0);
            let x1 = (x + radius).min(w as i32 - 1);
            let y1 = (y + radius).min(h as i32 - 1);
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    out.put_pixel(xx as u32, yy as u32, Luma([255u8]));
                }
            }
        }
    }
    out
}

/// マスクを radius px 収縮させて返す (dilate の逆)。二値マスクの縁を削り、
/// 切り抜き時に背景色がにじむハローを除去するために使う。
fn erode_mask(
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    radius: i32,
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let (w, h) = mask.dimensions();
    if radius <= 0 {
        return mask.clone();
    }
    let mut out = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([255u8]));
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            // 前景でない画素の周辺 radius を 0 に塗る = 前景側が radius 削れる。
            if mask.get_pixel(x as u32, y as u32)[0] > 127 {
                continue;
            }
            let x0 = (x - radius).max(0);
            let y0 = (y - radius).max(0);
            let x1 = (x + radius).min(w as i32 - 1);
            let y1 = (y + radius).min(h as i32 - 1);
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    out.put_pixel(xx as u32, yy as u32, Luma([0u8]));
                }
            }
        }
    }
    out
}

/// 二値マスクの境界だけにアンチエイリアス（中間アルファ）を与える精緻化。
///
/// - `erode_px`: まず縁を削る。argmax 由来の二値マスクは背景側へ数 px はみ出しがちで、
///   そのまま焼くと縁に背景色がにじむ（ハロー）。削って締める。
/// - `feather_px`: 収縮後マスクに (2*feather_px+1) 四方の箱平均を掛けて 0/255 の階段を
///   中間値へならす。完全内部(全近傍255)と完全外部(全近傍0)は値が変わらず、境界帯だけ滑らかになる。
///   → 主体の中身は削れず、ギザギザした輪郭だけがアンチエイリアスされる。
///
/// 両方 0 のときは入力をそのまま返す（既存挙動を壊さない安全既定）。決定論・純関数。
pub fn refine_mask_edge(
    mask: &ImageBuffer<Luma<u8>, Vec<u8>>,
    erode_px: i32,
    feather_px: i32,
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let eroded = if erode_px > 0 {
        erode_mask(mask, erode_px)
    } else {
        mask.clone()
    };
    if feather_px <= 0 {
        return eroded;
    }
    let (w, h) = eroded.dimensions();
    let r = feather_px;
    let mut out = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let x0 = (x - r).max(0);
            let y0 = (y - r).max(0);
            let x1 = (x + r).min(w as i32 - 1);
            let y1 = (y + r).min(h as i32 - 1);
            let mut sum: u32 = 0;
            let mut count: u32 = 0;
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    sum += eroded.get_pixel(xx as u32, yy as u32)[0] as u32;
                    count += 1;
                }
            }
            out.put_pixel(x as u32, y as u32, Luma([(sum / count) as u8]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中央に白い正方形を持つ二値マスクを作る。
    fn square_mask(size: u32, inset: u32) -> ImageBuffer<Luma<u8>, Vec<u8>> {
        let mut m = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(size, size, Luma([0u8]));
        for y in inset..(size - inset) {
            for x in inset..(size - inset) {
                m.put_pixel(x, y, Luma([255u8]));
            }
        }
        m
    }

    #[test]
    fn refine_is_noop_when_both_zero() {
        let m = square_mask(20, 5);
        let out = refine_mask_edge(&m, 0, 0);
        assert_eq!(m, out, "erode/feather ともに0なら入力そのまま");
    }

    #[test]
    fn feather_introduces_midtones_only_on_border() {
        let m = square_mask(20, 5); // 白領域 [5,15)
        let out = refine_mask_edge(&m, 0, 1);
        // 完全内部（境界から2px以上内側）は255のまま
        assert_eq!(out.get_pixel(10, 10)[0], 255, "内部は不変");
        // 完全外部（境界から2px以上外側）は0のまま
        assert_eq!(out.get_pixel(0, 0)[0], 0, "外部は不変");
        // 境界画素には中間値が出る（0でも255でもない）
        let edge = out.get_pixel(5, 10)[0];
        assert!(edge > 0 && edge < 255, "境界に中間アルファ (実際: {edge})");
    }

    #[test]
    fn erode_shrinks_foreground() {
        let m = square_mask(20, 5); // 白領域 [5,15)
        let eroded = erode_mask(&m, 1);
        // 縁 (5,10) は削れて0、内部 (7,10) は残って255
        assert_eq!(eroded.get_pixel(5, 10)[0], 0, "縁は収縮で消える");
        assert_eq!(eroded.get_pixel(7, 10)[0], 255, "内部は残る");
    }
}
