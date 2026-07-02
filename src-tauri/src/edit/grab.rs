use std::path::{Path, PathBuf};

use image::{GenericImageView, ImageBuffer, Luma, Rgba};

use crate::edit::inpaint::inpaint_image;
use crate::edit::runtime::EditRuntime;

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
    let bbox = mask_bbox(&mask).ok_or_else(|| {
        "マスクが空です。対象をもう一度クリックしてください。".to_string()
    })?;
    let [bx, by, bw, bh] = bbox;

    // オブジェクト透過PNG: bbox にクロップし、マスクの alpha を焼く。
    let rgba = img.to_rgba8();
    let mut object = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(bw, bh);
    for oy in 0..bh {
        for ox in 0..bw {
            let sx = bx + ox;
            let sy = by + oy;
            let alpha = mask.get_pixel(sx, sy)[0];
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
    inpaint_image(runtime, input_path, &dilated_mask_path, &filled_background_path).await?;

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

    let mut object = ImageBuffer::<Rgba<u8>, Vec<u8>>::new(bw, bh);
    for oy in 0..bh {
        for ox in 0..bw {
            let sx = bx + ox;
            let sy = by + oy;
            let alpha = mask.get_pixel(sx, sy)[0];
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
