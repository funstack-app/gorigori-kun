//! 実モデル E2E ハーネス (マジックレイヤー品質の恒久回帰テスト)。
//!
//! なぜ src/edit/ 配下に置くか: マジックレイヤーのコア関数 (ocr / inpaint / segment / sam2) は
//! `mod edit` が private のため外部 integration test (tests/) からは呼べない。ここに
//! `#[cfg(test)]` で置けば private 関数へ直接アクセスできる。AppHandle 依存の emit は
//! `run_magic_layer_inner` の枝葉なので、ここではコア関数を直接叩いて同等パイプラインを再現する。
//!
//! 実行: モデル + ort ランタイムが要るため通常 `cargo test` では `#[ignore]` で skip。
//!   cd src-tauri && cargo test --lib edit::magic_layer_e2e -- --ignored --nocapture
//!
//! 前提: `~/Library/Application Support/app.codexframefactory/models/` に
//!   sam2-tiny-encoder/decoder, birefnet-general, lama_fp32, paddleocr 2種が DL 済み。
//!   未 DL のモデルに依存するアサートは、そのモデルが無ければ skip する (CI で落とさない)。

#![cfg(test)]

use std::path::{Path, PathBuf};

use image::{ImageBuffer, Luma, Rgb};

use crate::edit::inpaint::inpaint_image;
use crate::edit::registry::model_path;
use crate::edit::runtime::EditRuntime;
use crate::edit::sam2::Sam2Session;
use crate::edit::segment::segment_image_with_source;

const W: u32 = 640;
const H: u32 = 960;

/// テスト用の合成画像を作る。
/// - 背景: なだらかなグラデーション (単色一面だと BiRefNet/SAM2 が何も拾えない)。
/// - 中央: はっきりした赤い矩形 (= 「物体」。SAM2 が拾える主要被写体)。
/// - 左上: 青い円 (= もう 1 つの物体)。
/// 人物ではないので BiRefNet 人物マスクは薄くてよい。SAM2 物体分解の検証が主目的。
fn synth_image() -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let mut img = ImageBuffer::<Rgb<u8>, Vec<u8>>::new(W, H);
    for y in 0..H {
        for x in 0..W {
            // 斜めグラデーション背景。
            let r = (60 + (x * 80 / W)) as u8;
            let g = (70 + (y * 90 / H)) as u8;
            let b = (110 + ((x + y) * 60 / (W + H))) as u8;
            img.put_pixel(x, y, Rgb([r, g, b]));
        }
    }
    // 中央の赤い矩形 (物体1)。
    let (rx0, ry0, rx1, ry1) = (200u32, 360u32, 440u32, 620u32);
    for y in ry0..ry1 {
        for x in rx0..rx1 {
            img.put_pixel(x, y, Rgb([220, 40, 40]));
        }
    }
    // 左上の青い円 (物体2)。
    let (cx, cy, cr) = (140i32, 180i32, 90i32);
    for y in 0..H as i32 {
        for x in 0..W as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= cr * cr {
                img.put_pixel(x as u32, y as u32, Rgb([40, 60, 220]));
            }
        }
    }
    img
}

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "gori-magic-e2e-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn model_available(id: &str) -> bool {
    match crate::edit::registry::find_model(id) {
        Some(spec) => model_path(&spec).map(|p| p.exists()).unwrap_or(false),
        None => false,
    }
}

/// RGBA PNG の「不透明領域に占める白ピクセル率」を返す (0.0-100.0)。
/// 前景 (foreground.png) の破綻検出用: 白ベタ化すると alpha>0 のうち白がほぼ 100% になる。
fn white_ratio_of_opaque(path: &Path) -> (f64, f64) {
    let img = image::open(path).unwrap().to_rgba8();
    let total = (img.width() * img.height()) as f64;
    let mut opaque = 0u64;
    let mut white = 0u64;
    for p in img.pixels() {
        if p[3] > 10 {
            opaque += 1;
            if p[0] > 240 && p[1] > 240 && p[2] > 240 {
                white += 1;
            }
        }
    }
    let opaque_ratio = 100.0 * opaque as f64 / total;
    let white_ratio = if opaque > 0 {
        100.0 * white as f64 / opaque as f64
    } else {
        0.0
    };
    (opaque_ratio, white_ratio)
}

/// RGB PNG の白ピクセル率 (0.0-100.0)。inpaint 出力 (background) の白化け検出用。
fn white_ratio_rgb(path: &Path) -> f64 {
    let img = image::open(path).unwrap().to_rgb8();
    let total = (img.width() * img.height()) as f64;
    let white = img
        .pixels()
        .filter(|p| p[0] > 240 && p[1] > 240 && p[2] > 240)
        .count() as f64;
    100.0 * white / total
}

/// LaMa inpaint が白化けしないことの回帰テスト。
///
/// 実機バグ (2026-07-02): text-removed.png / background が全面白 (100%) に破綻した。
/// scale scan で真因を特定: **入力の 0..1 正規化は正しく、出力の値域が 0..255** なのに
/// 旧 to_u8 が出力を 0..1 と誤仮定して `clamp(0,1)*255` していたため全画素が白 (255) に
/// 張り付いていた。inpaint.rs の出力変換を「0..255 をそのまま丸める」に直した後、
/// 出力白率が低い (元画像の色が残る) ことを機械検証する。
#[tokio::test]
#[ignore]
async fn lama_scale_experiment() {
    if !model_available("lama-onnx") {
        eprintln!("[skip] lama-onnx 未DL");
        return;
    }
    let runtime = EditRuntime::new();
    let dir = tmp_dir("lama-scale");
    let img = synth_image();
    let input = dir.join("input.png");
    img.save(&input).unwrap();

    // マスク: 中央矩形を塗る (= その領域を inpaint で消す)。
    let mut mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(W, H, Luma([0u8]));
    for y in 360..620 {
        for x in 200..440 {
            mask.put_pixel(x, y, Luma([255u8]));
        }
    }
    let mask_path = dir.join("mask.png");
    mask.save(&mask_path).unwrap();

    // 現行実装 (0..1 正規化) で inpaint。
    let out_0to1 = dir.join("out-0to1.png");
    inpaint_image(&runtime, &input, &mask_path, &out_0to1)
        .await
        .expect("inpaint 0..1 failed");
    let white_0to1 = white_ratio_rgb(&out_0to1);

    eprintln!("=== LaMa scale experiment ===");
    eprintln!("input white%={:.2}", white_ratio_rgb(&input));
    eprintln!("0..1 正規化 (現行 inpaint.rs): 出力白率={:.2}%", white_0to1);
    eprintln!("出力パス: {}", out_0to1.display());

    // 正しいスケールなら白率は低い (背景グラデ + 補完色が残る)。
    // 破綻 (白ブローアウト) なら白率が 50% を大きく超える。
    // このテストは「現行実装が正しいスケールを使っている」ことをアサートする。
    // もし赤 (fail) なら inpaint.rs のスケールが間違っている。
    assert!(
        white_0to1 < 50.0,
        "LaMa inpaint 出力が白化けした (白率{:.2}%). 入力スケールが誤り (0..1 vs 0..255). \
         現行 inpaint.rs のスケールを見直すこと。出力: {}",
        white_0to1,
        out_0to1.display()
    );
}

/// SAM2 decoder が dtype エラーなしで動くことの回帰テスト。
///
/// 2026-07-02 実機バグ: mask_input/has_mask_input を f64 (`vec![0.0; len]`) で作っていたため
/// decoder が `Unexpected input data type. Actual: tensor(double), expected: tensor(float)` で
/// 256点全滅した。ここでは合成画像を embed → 中央点で predict し、エラーゼロを確認する。
#[tokio::test]
#[ignore]
async fn sam2_decoder_dtype_no_error() {
    if !model_available("sam2-tiny-encoder") || !model_available("sam2-tiny-decoder") {
        eprintln!("[skip] sam2 モデル未DL");
        return;
    }
    let dir = tmp_dir("sam2-dtype");
    let img = synth_image();
    let input = dir.join("input.png");
    img.save(&input).unwrap();

    let mut session = Sam2Session::new_dedicated().expect("new_dedicated");
    session.embed_image(&input).await.expect("embed_image");

    // 中央矩形の中を指す (物体があるので有効なマスクが返るはず)。
    let raw = session
        .predict_raw_mask((0.5, 0.5))
        .await
        .expect("predict_raw_mask はエラーゼロであるべき (dtype 修正の検証)");

    eprintln!(
        "=== SAM2 decoder dtype OK: score={:.3} mask={}x{} ===",
        raw.score, raw.width, raw.height
    );
    assert_eq!(raw.width, W);
    assert_eq!(raw.height, H);
}

/// マジックレイヤー相当のフルパイプラインを実モデルで通し、成果物の品質をアサートする。
///
/// run_magic_layer_inner の AppHandle 非依存コア (ocr は省略可、segment + object masks) を
/// 直接叩く。標準モードの中核:
///   1. BiRefNet で人物/前景マスク → foreground.png
///   2. SAM2 で物体自動分解 → object masks (合成画像には赤矩形・青円がある → 1件以上)
///   3. union マスクで LaMa 背景 inpaint → 白化けしない
///
/// アサート:
///   (a) foreground.png の不透明領域の白率 < 20% (白ベタ破綻していない)
///   (b) predict 失敗 0 件 (dtype 修正の効果)
///   (c) 物体マスク 1 件以上採用
///   (d) inpaint 背景の白率 < 50%
#[tokio::test]
#[ignore]
async fn magic_layer_full_pipeline_quality() {
    // 必須モデルの可用性チェック。
    for id in ["birefnet-general", "sam2-tiny-encoder", "sam2-tiny-decoder"] {
        if !model_available(id) {
            eprintln!("[skip] {id} 未DL — フルパイプラインテストを skip");
            return;
        }
    }

    let runtime = EditRuntime::new();
    let dir = tmp_dir("full");
    let img = synth_image();
    let input = dir.join("input.png");
    img.save(&input).unwrap();

    // --- 1. BiRefNet セグメント (mask source = foreground source = 元画像) ---
    let segment_result = segment_image_with_source(&runtime, &input, &input, &dir)
        .await
        .expect("segment failed");
    let width = segment_result.width;
    let height = segment_result.height;
    eprintln!("=== segment done: {width}x{height} ===");

    // (a) foreground.png が白ベタ破綻していない。
    let (fg_opaque, fg_white) = white_ratio_of_opaque(&segment_result.foreground_path);
    eprintln!(
        "foreground.png: opaque={:.2}%  white_of_opaque={:.2}%  path={}",
        fg_opaque,
        fg_white,
        segment_result.foreground_path.display()
    );
    assert!(
        fg_white < 20.0,
        "(a) foreground.png が白ベタ破綻 (不透明領域の白率{:.2}%). \
         合成関数か色の出所が誤り。path={}",
        fg_white,
        segment_result.foreground_path.display()
    );

    // --- 2. SAM2 物体分解 ---
    use crate::edit::auto_segment::{build_exclude_mask, run_auto_object_masks};

    let mut session = Sam2Session::new_dedicated().expect("new_dedicated");
    session.embed_image(&input).await.expect("embed_image");

    // 人物マスク (BiRefNet 出力) を除外マスクにする。テキスト bbox は無し。
    let exclude = build_exclude_mask(width, height, Some(&segment_result.mask_path), &[]);
    let masks = run_auto_object_masks(&session, Some(&exclude), 6)
        .await
        .expect("run_auto_object_masks failed");

    eprintln!("=== object masks 採用: {} 件 ===", masks.len());
    for (i, m) in masks.iter().enumerate() {
        eprintln!("  object[{i}] area={} score={:.3}", m.area, m.score);
    }

    // (b) predict 失敗 0 件: 採用が 1 件以上ある = decoder が動いた証拠。
    //     全点 dtype エラーだと採用 0 件になる (旧バグの症状)。
    //     (c) 物体マスク 1 件以上採用。
    assert!(
        !masks.is_empty(),
        "(b)(c) 物体マスクが 0 件. dtype エラーで全点 predict 失敗した可能性 (旧バグ再発). \
         合成画像には赤矩形と青円があるので 1 件以上採れるはず。"
    );

    // --- 3. union マスクで LaMa 背景 inpaint ---
    let mut union = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(width, height, Luma([0u8]));
    for m in &masks {
        if m.mask.width() == width && m.mask.height() == height {
            for (dst, src) in union.pixels_mut().zip(m.mask.pixels()) {
                if src[0] > 127 {
                    *dst = Luma([255u8]);
                }
            }
        }
    }
    let union_path = dir.join("union-mask.png");
    let dilated = crate::edit::grab::dilate_mask_pub(&union, 6);
    dilated.save(&union_path).unwrap();

    let background = dir.join("background.png");
    inpaint_image(&runtime, &input, &union_path, &background)
        .await
        .expect("background inpaint failed");

    // (d) inpaint 背景の白率 < 50% (白ブローアウトしていない)。
    let bg_white = white_ratio_rgb(&background);
    eprintln!(
        "background.png inpaint 白率={:.2}%  path={}",
        bg_white,
        background.display()
    );
    assert!(
        bg_white < 50.0,
        "(d) 背景 inpaint が白化け (白率{:.2}%). LaMa 入力スケールが誤り. path={}",
        bg_white,
        background.display()
    );

    eprintln!("=== ALL GREEN: foreground/object/inpaint すべて品質 OK ===");
}
