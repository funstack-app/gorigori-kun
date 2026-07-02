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
use crate::edit::magic_layer::generate_text_mask;
use crate::edit::ocr::ocr_image_with_probmap;
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


/// テストでも tracing を見えるようにする (購読者が無いと debug/info が全て闇に消える)。
fn init_test_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("edit.auto_segment=debug,codex.edit=info")
        .with_test_writer()
        .try_init();
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

/// マスクの白画素数と重心 (x,y ピクセル座標) を返す。
fn mask_stats(mask: &ImageBuffer<Luma<u8>, Vec<u8>>) -> (u64, f64, f64) {
    let mut area = 0u64;
    let mut sx = 0f64;
    let mut sy = 0f64;
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 127 {
            area += 1;
            sx += x as f64;
            sy += y as f64;
        }
    }
    if area == 0 {
        (0, 0.0, 0.0)
    } else {
        (area, sx / area as f64, sy / area as f64)
    }
}

/// クリック点がデコーダに効いていることの品質回帰テスト (高速・2点のみ)。
///
/// 真因: クリック点を指しても「ほぼ画像全体」の同一マスクしか返らないと、物体分解が
/// 背景1種類に潰れる。ここでは赤矩形の中心と青円の中心を predict し、
///   - マスク面積が対象物体の面積の 0.5〜2.0 倍
///   - マスク重心が対象物体の内側
/// を機械検証する。緑になれば「点に依存して正しいマスクが返る」ことの証拠。
#[tokio::test]
#[ignore]
async fn sam2_click_point_localizes_object() {
    init_test_tracing();
    if !model_available("sam2-tiny-encoder") || !model_available("sam2-tiny-decoder") {
        eprintln!("[skip] sam2 モデル未DL");
        return;
    }
    let dir = tmp_dir("sam2-click");
    let img = synth_image();
    let input = dir.join("input.png");
    img.save(&input).unwrap();

    let mut session = Sam2Session::new_dedicated().expect("new_dedicated");
    session.embed_image(&input).await.expect("embed_image");

    // --- 赤矩形 (200,360)-(440,620): 面積 240*260 = 62,400px、中心 (320,490) ---
    let red_area = 240.0 * 260.0;
    let raw = session
        .predict_raw_mask((320.0 / W as f32, 490.0 / H as f32))
        .await
        .expect("predict red-center");
    let (area, cx, cy) = mask_stats(&raw.mask);
    eprintln!(
        "赤矩形: score={:.3} area={} (期待 {:.0}±) 重心=({:.0},{:.0})",
        raw.score, area, red_area, cx, cy
    );
    assert!(
        area as f64 >= red_area * 0.5 && area as f64 <= red_area * 2.0,
        "赤矩形マスク面積 {} が矩形面積 {:.0} の 0.5〜2.0 倍から外れた (クリック点が効いていない)",
        area,
        red_area
    );
    assert!(
        (200.0..440.0).contains(&cx) && (360.0..620.0).contains(&cy),
        "赤矩形マスク重心 ({:.0},{:.0}) が矩形内 (200..440, 360..620) にない",
        cx,
        cy
    );

    // --- 青円 中心 (140,180) 半径 90: 面積 π*90^2 ≈ 25,447px ---
    let blue_area = std::f64::consts::PI * 90.0 * 90.0;
    let raw = session
        .predict_raw_mask((140.0 / W as f32, 180.0 / H as f32))
        .await
        .expect("predict blue-center");
    let (area, cx, cy) = mask_stats(&raw.mask);
    eprintln!(
        "青円: score={:.3} area={} (期待 {:.0}±) 重心=({:.0},{:.0})",
        raw.score, area, blue_area, cx, cy
    );
    assert!(
        area as f64 >= blue_area * 0.5 && area as f64 <= blue_area * 2.0,
        "青円マスク面積 {} が円面積 {:.0} の 0.5〜2.0 倍から外れた (クリック点が効いていない)",
        area,
        blue_area
    );

    eprintln!("=== CLICK POINT OK: 赤矩形・青円ともに点依存でローカライズ ===");
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
    init_test_tracing();
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

    // 合成画像は「人物なし」で、赤矩形・青円がそのまま検出対象の物体。
    // ところが BiRefNet はこの2つの鮮明な図形を **前景 (人物相当)** として拾う
    // (foreground opaque≈14.5% = 赤62,400+青25,447 とほぼ一致)。その前景マスクを
    // exclude に渡すと、SAM2 が正しく当てた赤矩形(covered≈0.99)・青円(covered≈0.99)が
    // 「人物と二重」として全部 既存重複棄却 され、採用0件になる (2026-07-02 実機 E2E の真因)。
    //
    // 実運用では person_mask = 人物のみで、人物と重ならない物体 (背景の小物・乗り物等) は
    // 残る。合成画像は人物が存在しないので、人物 exclude を渡すこと自体が現実と乖離する
    // テスト配線バグ。ここでは exclude=None で「物体分解そのもの」を検証する。
    // (exclude 重複除外ロジックの単体検証は auto_segment.rs の covered_by テストで担保済み。)
    let masks = run_auto_object_masks(&session, None, 6)
        .await
        .expect("run_auto_object_masks failed");
    let _ = build_exclude_mask; // 実運用側 (magic_layer.rs) で使用。ここでは未使用。

    eprintln!("=== object masks 採用: {} 件 ===", masks.len());
    for (i, m) in masks.iter().enumerate() {
        let (_a, cx, cy) = mask_stats(&m.mask);
        eprintln!(
            "  object[{i}] area={} score={:.3} 重心=({:.0},{:.0})",
            m.area, m.score, cx, cy
        );
    }

    // (b) predict 失敗 0 件: 採用が 1 件以上ある = decoder が動いた証拠。
    //     全点 dtype エラーだと採用 0 件になる (旧バグの症状)。
    //     (c) 物体マスク 1 件以上採用。
    assert!(
        !masks.is_empty(),
        "(b)(c) 物体マスクが 0 件. dtype エラーで全点 predict 失敗した可能性 (旧バグ再発). \
         合成画像には赤矩形と青円があるので 1 件以上採れるはず。"
    );

    // (c') 採用物体の中に「赤矩形」または「青円」が実際に含まれる (点依存の物体分解が
    //      機能している証拠。whole-scene マスクに潰れていたらここで落ちる)。
    let red_center = (320.0, 490.0);
    let blue_center = (140.0, 180.0);
    let hit_object = |cx: f64, cy: f64| {
        masks.iter().any(|m| {
            let (_a, mcx, mcy) = mask_stats(&m.mask);
            (mcx - cx).abs() < 60.0 && (mcy - cy).abs() < 60.0
        })
    };
    assert!(
        hit_object(red_center.0, red_center.1) || hit_object(blue_center.0, blue_center.1),
        "(c') 採用物体の重心が赤矩形(320,490)にも青円(140,180)にも近くない. \
         物体分解が背景 whole-scene に潰れている疑い。"
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

/// 実写プローブ: 実画像でフルパイプラインを回し、成果物を書き出して目視判定に供する。
/// 品質のハードアサートはせず (実写の正解は人間が判定)、破綻検知だけアサートする。
///   GORI_E2E_IMAGE=<入力画像> GORI_E2E_OUT=<出力dir> \
///   cargo test --lib edit::magic_layer_e2e::magic_layer_real_image_probe -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn magic_layer_real_image_probe() {
    init_test_tracing();
    let Ok(input) = std::env::var("GORI_E2E_IMAGE") else {
        eprintln!("[skip] GORI_E2E_IMAGE 未指定");
        return;
    };
    let input = PathBuf::from(input);
    let out = std::env::var("GORI_E2E_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| tmp_dir("real"));
    std::fs::create_dir_all(&out).unwrap();

    for id in ["birefnet-general", "sam2-tiny-encoder", "sam2-tiny-decoder"] {
        if !model_available(id) {
            eprintln!("[skip] {id} 未DL");
            return;
        }
    }

    let runtime = EditRuntime::new();
    let segment_result = segment_image_with_source(&runtime, &input, &input, &out)
        .await
        .expect("segment failed");
    let (w, h) = (segment_result.width, segment_result.height);
    let (fg_opaque, fg_white) = white_ratio_of_opaque(&segment_result.foreground_path);
    eprintln!("[probe] segment {w}x{h} fg_opaque={fg_opaque:.1}% fg_white={fg_white:.1}%");
    assert!(fg_white < 20.0, "前景が白ベタ破綻 ({fg_white:.1}%)");

    use crate::edit::auto_segment::{build_exclude_mask, run_auto_object_masks};
    let mut session = Sam2Session::new_dedicated().expect("new_dedicated");
    session.embed_image(&input).await.expect("embed");
    let exclude = build_exclude_mask(w, h, Some(&segment_result.mask_path), &[]);
    let masks = run_auto_object_masks(&session, Some(&exclude), 12)
        .await
        .expect("auto masks");
    eprintln!("[probe] objects={} 件", masks.len());

    let rgba = image::open(&input).unwrap().to_rgba8();
    let mut union = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    if let Ok(person) = image::open(&segment_result.mask_path) {
        let person = person.to_luma8();
        if person.width() == w && person.height() == h {
            for (dst, src) in union.pixels_mut().zip(person.pixels()) {
                if src[0] > 127 {
                    *dst = Luma([255u8]);
                }
            }
        }
    }
    for (i, m) in masks.iter().enumerate() {
        let p = out.join(format!("object-{i}.png"));
        let bbox =
            crate::edit::grab::crop_object_png(&rgba, &m.mask, &p).expect("crop object");
        eprintln!(
            "[probe] object[{i}] area={} score={:.3} bbox={:?} -> {}",
            m.area,
            m.score,
            bbox,
            p.display()
        );
        for (dst, src) in union.pixels_mut().zip(m.mask.pixels()) {
            if src[0] > 127 {
                *dst = Luma([255u8]);
            }
        }
    }
    let union_path = out.join("union-mask.png");
    crate::edit::grab::dilate_mask_pub(&union, 6)
        .save(&union_path)
        .unwrap();
    let background = out.join("background-filled.png");
    inpaint_image(&runtime, &input, &union_path, &background)
        .await
        .expect("inpaint");
    let bg_white = white_ratio_rgb(&background);
    eprintln!("[probe] 背景補完 白率={bg_white:.1}% -> {}", background.display());
    assert!(bg_white < 50.0, "背景補完が白化け ({bg_white:.1}%)");
    eprintln!("[probe] 完了: {}", out.display());
}

/// 実 PaddleOCR で DB 確率マップ → ストロークマスクを作り、bbox 矩形マスクより塗り面積が
/// 小さいことを機械検証する (2026-07-02 マスク精度改善の恒久回帰テスト)。
///
/// 疑似文字: 白パネルの中に黒の太い縦線 (文字ストローク相当) を並べる。DB 検出器はこれを
/// テキスト状の連結領域として拾い、確率マップは黒ストローク位置だけ高確率になる。同じ入力・
/// 同じ採用 region に対し、確率マップ有り (ストローク) と無し (bbox 矩形) を両方生成し、
/// 前者の白画素数が後者より少ないことをアサートする。
///
/// フォールバック整合も同時確認: prob_map=None で従来 bbox 矩形が返ること (挙動退行ゼロ)。
#[tokio::test]
#[ignore]
async fn text_mask_stroke_smaller_than_bbox_real_ocr() {
    init_test_tracing();
    if !model_available("ppocrv6-small-det") || !model_available("ppocrv6-small-rec") {
        eprintln!("[skip] ppocrv6 モデル未DL");
        return;
    }
    let dir = tmp_dir("text-mask");

    // 640x200 のグレー背景に「白パネル + 黒の太い縦線群」(疑似文字)。
    let (iw, ih) = (640u32, 200u32);
    let mut img = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_pixel(iw, ih, Rgb([180, 190, 200]));
    // 白パネル (80,70)-(560,140)。
    for y in 70u32..140 {
        for x in 80u32..560 {
            img.put_pixel(x, y, Rgb([245, 245, 245]));
        }
    }
    // 黒の縦線 (文字ストローク相当): パネル内で 40px 間隔・幅 10px。
    for y in 82u32..128 {
        for x in 100u32..540 {
            if (x - 100) % 40 < 10 {
                img.put_pixel(x, y, Rgb([15, 15, 15]));
            }
        }
    }
    let input = dir.join("input.png");
    img.save(&input).unwrap();

    let runtime = EditRuntime::new();
    let (raw_regions, prob_map) = ocr_image_with_probmap(&runtime, &input)
        .await
        .expect("ocr_image_with_probmap failed");
    eprintln!(
        "[text-mask] raw_regions={} probmap={}",
        raw_regions.len(),
        prob_map.is_some()
    );
    if raw_regions.is_empty() {
        eprintln!("[skip] DB 検出器が疑似文字を拾わなかった (モデル差)。この機のモデルでは検証不能。");
        return;
    }
    assert!(
        prob_map.is_some(),
        "regions を検出したのに確率マップが None (upscale_prob_map の座標系判定が誤り)"
    );

    // 疑似文字 (黒縦線) は認識器が実文字として読めず text が空/ノイズになりうる。ここで
    // 検証したいのは「実 DB 確率マップ + 実検出 bbox」でストロークが矩形より小さいこと
    // (= 新規経路 upscale_prob_map + build_stroke_mask の実モデル動作)。そこで認識テキストだけ
    // 既知の採用テキストに差し替え、bbox と確率マップは実 OCR の実体をそのまま使う。
    let regions: Vec<crate::edit::ocr::TextRegion> = raw_regions
        .into_iter()
        .map(|mut r| {
            r.text = "SALE".to_string();
            r
        })
        .collect();

    // ストローク方式 (確率マップ有り)。
    let stroke_path = dir.join("stroke-mask.png");
    generate_text_mask(&input, &regions, prob_map.as_ref(), &stroke_path)
        .expect("stroke mask");
    let stroke_area = count_white(&stroke_path);

    // bbox 矩形フォールバック (確率マップ無し = 挙動退行ゼロの確認)。
    let bbox_path = dir.join("bbox-mask.png");
    generate_text_mask(&input, &regions, None, &bbox_path).expect("bbox mask");
    let bbox_area = count_white(&bbox_path);

    eprintln!(
        "[text-mask] stroke_area={stroke_area} bbox_area={bbox_area} 比={:.3} -> {}",
        stroke_area as f64 / bbox_area.max(1) as f64,
        dir.display()
    );

    assert!(stroke_area > 0, "ストロークマスクが空 (文字を消せない)");
    assert!(bbox_area > 0, "bbox マスクが空 (採用 region 無し)");
    assert!(
        stroke_area < bbox_area,
        "実 OCR でもストローク方式が矩形以上に塗っている (stroke={stroke_area} bbox={bbox_area}). \
         マスク精度改善が効いていない。"
    );
}

/// Luma PNG の白画素 (>127) 数。
fn count_white(path: &Path) -> u64 {
    let m = image::open(path).unwrap().to_luma8();
    m.pixels().filter(|p| p[0] > 127).count() as u64
}

/// 実 PP-OCRv6 で任意の実画像を認識し、全 region のテキストを出力する検証プローブ。
///
/// 用途: v5→v6 差し替えで「バスケ」→「ハスケ」濁点落ちが解消したことの実画像確認。
///   GORI_E2E_IMAGE=<入力画像> \
///   cargo test --lib edit::magic_layer_e2e::ocr_recognize_real_image_probe -- --ignored --nocapture
///
/// GORI_OCR_EXPECT を指定すると、認識結果のどれかにその部分文字列が含まれることをアサートする
/// (例: GORI_OCR_EXPECT=バスケ)。未指定なら認識テキストの出力のみ (破綻検知はしない)。
#[tokio::test]
#[ignore]
async fn ocr_recognize_real_image_probe() {
    init_test_tracing();
    let Ok(input) = std::env::var("GORI_E2E_IMAGE") else {
        eprintln!("[skip] GORI_E2E_IMAGE 未指定");
        return;
    };
    if !model_available("ppocrv6-small-det") || !model_available("ppocrv6-small-rec") {
        eprintln!("[skip] ppocrv6 モデル未DL");
        return;
    }
    let input = PathBuf::from(input);
    let runtime = EditRuntime::new();
    let (regions, _prob) = ocr_image_with_probmap(&runtime, &input)
        .await
        .expect("ocr_image_with_probmap failed");

    eprintln!("=== OCR 認識結果 ({} regions) ===", regions.len());
    let mut joined = String::new();
    for (i, r) in regions.iter().enumerate() {
        eprintln!(
            "  [{i:02}] conf={:.3} lang={:?} bbox={:?} text={:?}",
            r.confidence, r.language, r.bbox, r.text
        );
        joined.push_str(&r.text);
        joined.push('\n');
    }
    eprintln!("=== 全文結合 ===\n{joined}");

    if let Ok(expect) = std::env::var("GORI_OCR_EXPECT") {
        assert!(
            joined.contains(&expect),
            "期待文字列 {:?} が認識結果に含まれない。濁点落ち等の誤認識の疑い。\n認識全文:\n{joined}",
            expect
        );
        eprintln!("=== OK: 期待文字列 {:?} を認識結果に検出 ===", expect);
    }
}
