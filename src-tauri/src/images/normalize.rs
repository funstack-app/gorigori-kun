//! 生成画像の規格寸法への決定論正規化。
//!
//! 通常生成（PromptComposer 経由）の aspect 指定は、プロンプト文言のヒントに
//! 過ぎず寸法を保証しない。実測ではモデル出力が量子化寸法へ収束し、
//! 16:9 要求に 1672×941（−0.06%）のような微小ジッタから、3:4 要求に
//! 1024×1536（=2:3、−11.1%）のような「別比率へのスナップ」まで揺れる。
//!
//! そこで生成物の回収点（`batch_gen.rs` の src→dest コピー）で規格寸法へ
//! 正規化する。±10% 以内はセンタークロップで黙って確定し、超過は失敗扱い
//! （自動再生成はせず、素材は `_raw.png` として救済保存する）。
//!
//! 適用は `enforceAspect` の明示オプトイン時のみ。マスク編集・img2img・
//! 漫画ページは「出力＝元画像と同じ解像度」が正のため対象外。

use std::path::Path;

/// aspect ラベル → 規格寸法。
///
/// すべてモデルの量子化ネイティブ寸法から**拡大なし**（最大 −4.5% の縮小）で
/// 到達できる、比率が厳密な固定値。
///
/// 表に無いラベルは `None` を返し、呼び出し側は素通しコピーする
/// （フェイルオープン。表と UI のドリフトで生成が全滅する事故を防ぐ）。
///
/// フロント側の選択肢は `src/lib/store/composer.ts` の `ASPECT_OPTIONS`。
/// 比率を追加するときは両方を同時に更新すること。
pub fn canonical_size(aspect_label: &str) -> Option<(u32, u32)> {
    match aspect_label {
        // 1672×941（実測 239 枚）から縮小 0.957 + クロップ 0.05%
        "16:9" => Some((1600, 900)),
        // 941×1672（実測 49 枚）から縮小 0.957 + クロップ 0.05%
        "9:16" => Some((900, 1600)),
        // 1254×1254（実測 104 枚）から縮小 0.957・クロップ 0
        "1:1" => Some((1200, 1200)),
        // Instagram フィード縦の業界標準寸法。想定ネイティブ 1086×1448 から
        // 縮小 0.994 + クロップ 6.25%（拡大なしで到達）
        "4:5" => Some((1080, 1350)),
        _ => None,
    }
}

/// サイズ不一致エラーの接頭辞。人間可読かつ機械判別可能にするための固定文字列。
/// リトライループの中断判定（`is_size_mismatch_error`）がこれを見る。
pub const SIZE_MISMATCH_PREFIX: &str = "生成サイズ不一致: ";

/// エラー文字列がサイズ不一致（＝自動再生成しても直らない確定的失敗）かを判定する。
pub fn is_size_mismatch_error(error: &str) -> bool {
    error.starts_with(SIZE_MISMATCH_PREFIX)
}

/// 実出力 w×h が規格 tw×th から ±10% 以内か。
///
/// u128 の交差乗算で判定する。比率を浮動小数にすると境界値（ちょうど +10.0%）の
/// 判定が丸め方向に依存して揺れるため、整数演算に固定する。境界は PASS に含める。
/// u32 最大値同士の積でも溢れないよう u128 を使う（u64 では理論上オーバーフローする）。
fn within_tolerance(w: u32, h: u32, tw: u32, th: u32) -> bool {
    let (w, h, tw, th) = (w as u128, h as u128, tw as u128, th as u128);
    100 * w * th <= 110 * tw * h && 100 * tw * h <= 110 * w * th
}

/// `src` を検査し、許容内なら規格寸法へ cover 正規化して `dest` に PNG 保存する。
///
/// - 規格表に無い `aspect_label`: 素通しコピー + warn（フェイルオープン）
/// - 許容内（±10%）: `resize_to_fill`（拡縮 + センタークロップ、Lanczos3）で
///   規格寸法ちょうどの PNG を `dest` に保存。raw は残さない
/// - 許容超過: `src` を `raw_dest` へ救済コピーした上で `SIZE_MISMATCH_PREFIX`
///   で始まる `Err` を返す（枠は消費済みなので素材を捨てない）
///
/// 復号失敗など**サイズ不一致以外**のエラーは接頭辞を付けない。一時故障の
/// 可能性があるため、呼び出し側のリトライ対象のままにする。
pub fn normalize_or_salvage(
    src: &Path,
    dest: &Path,
    raw_dest: &Path,
    aspect_label: &str,
) -> Result<(), String> {
    let Some((tw, th)) = canonical_size(aspect_label) else {
        tracing::warn!(
            target: "codex.images.normalize",
            "規格寸法テーブルに無い aspect '{aspect_label}' のため正規化せず素通しします"
        );
        std::fs::copy(src, dest).map_err(|e| format!("出力コピー失敗: {e}"))?;
        return Ok(());
    };

    let img = image::open(src).map_err(|e| format!("生成画像の読み込みに失敗しました: {e}"))?;
    let (w, h) = {
        use image::GenericImageView as _;
        img.dimensions()
    };

    if !within_tolerance(w, h, tw, th) {
        // 枠（生成クレジット）は既に消費済み。素材を捨てず救済保存してから失敗を返す。
        let raw_file_name = raw_dest
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "(不明)".to_string());
        // 救済コピーの成否で文言を分ける。exec 経路の src は一時フォルダにあり
        // 処理終了で消えるため、失敗したのに「残しています」と言うと素材の所在を
        // 偽ることになる（ユーザーは戻せない画像を探しに行く）。
        let salvage_note = match std::fs::copy(src, raw_dest) {
            Ok(_) => format!("素材は {raw_file_name} に残しています。"),
            Err(e) => {
                tracing::warn!(
                    target: "codex.images.normalize",
                    "サイズ不一致画像の救済コピーに失敗しました: {e}"
                );
                format!("素材の救済保存にも失敗したため、この画像は残っていません（{e}）。")
            }
        };
        return Err(format!(
            "{SIZE_MISMATCH_PREFIX}生成画像（実測 {w}×{h}）が要求 {aspect_label} から10%を超えて外れています。\
             この1枚は失敗扱いにしました（自動再生成はしません）。{salvage_note}"
        ));
    }

    // cover: 枠を覆う倍率でリサイズ → 中央クロップ。`images.rs` の resize_one と同型。
    let filled = img.resize_to_fill(tw, th, image::imageops::FilterType::Lanczos3);
    filled
        .save_with_format(dest, image::ImageFormat::Png)
        .map_err(|e| format!("正規化画像の書き出しに失敗しました: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView as _;

    /// 指定寸法の単色 PNG を作って書き出す。
    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
        let path = dir.join(name);
        let buf: image::RgbaImage =
            image::ImageBuffer::from_pixel(w, h, image::Rgba([10, 200, 90, 255]));
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        path
    }

    /// DoD-1: 規格寸法テーブルが設計 §4 と完全一致し、未知ラベルは None。
    #[test]
    fn canonical_size_matches_the_spec_table() {
        assert_eq!(canonical_size("16:9"), Some((1600, 900)));
        assert_eq!(canonical_size("9:16"), Some((900, 1600)));
        assert_eq!(canonical_size("1:1"), Some((1200, 1200)));
        assert_eq!(canonical_size("4:5"), Some((1080, 1350)));
        assert_eq!(canonical_size("3:2"), None);
        assert_eq!(canonical_size("3:4"), None);
        assert_eq!(canonical_size(""), None);
    }

    /// DoD-2: ネイティブ実測寸法の入力が、規格寸法ちょうどの PNG になる。
    #[test]
    fn native_outputs_normalize_to_exact_canonical_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            ("16:9", 1672u32, 941u32, 1600u32, 900u32),
            ("9:16", 941, 1672, 900, 1600),
            ("1:1", 1254, 1254, 1200, 1200),
            ("4:5", 1086, 1448, 1080, 1350),
        ];
        for (i, (label, w, h, tw, th)) in cases.iter().enumerate() {
            let src = write_png(dir.path(), &format!("src{i}.png"), *w, *h);
            let dest = dir.path().join(format!("dest{i}.png"));
            let raw = dir.path().join(format!("raw{i}.png"));
            normalize_or_salvage(&src, &dest, &raw, label).unwrap();
            let out = image::open(&dest).unwrap();
            assert_eq!(out.dimensions(), (*tw, *th), "label={label}");
        }
    }

    /// DoD-3: 拡大方向（規格より小さい入力）も失敗にせず規格に揃える。
    #[test]
    fn undersized_input_is_upscaled_to_canonical_size() {
        let dir = tempfile::tempdir().unwrap();
        let src = write_png(dir.path(), "small.png", 768, 1376);
        let dest = dir.path().join("dest.png");
        let raw = dir.path().join("raw.png");
        normalize_or_salvage(&src, &dest, &raw, "9:16").unwrap();
        assert_eq!(image::open(&dest).unwrap().dimensions(), (900, 1600));
    }

    /// DoD-4: ±10% 境界を両側から挟む。境界ちょうどは PASS。
    #[test]
    fn tolerance_boundary_is_inclusive_at_exactly_ten_percent() {
        // 基準 900×1600。
        assert!(within_tolerance(990, 1600, 900, 1600), "+10.0% は許容内");
        assert!(!within_tolerance(991, 1600, 900, 1600), "+10.1% は許容外");
        assert!(within_tolerance(819, 1600, 900, 1600), "-9.9% は許容内");
        assert!(!within_tolerance(818, 1600, 900, 1600), "-10.03% は許容外");
    }

    /// DoD-4（経路込み）: 境界の外側が SIZE_MISMATCH_PREFIX で始まる Err になる。
    #[test]
    fn boundary_failure_returns_prefixed_error() {
        let dir = tempfile::tempdir().unwrap();
        let src = write_png(dir.path(), "edge.png", 991, 1600);
        let dest = dir.path().join("dest.png");
        let raw = dir.path().join("raw.png");
        let err = normalize_or_salvage(&src, &dest, &raw, "9:16").unwrap_err();
        assert!(is_size_mismatch_error(&err), "err={err}");
        assert!(err.contains("991×1600"), "実測寸法が文言に含まれる: {err}");
    }

    /// DoD-5: 実世界の逸脱クラス（別比率へのスナップ）を機械的に落とす。
    #[test]
    fn real_world_snap_deviations_are_classified_correctly() {
        // 2:3 スナップ: 9:16 要求に対し +18.5%、4:5 要求に対し −16.7%。
        assert!(!within_tolerance(1024, 1536, 900, 1600));
        assert!(!within_tolerance(1024, 1536, 1080, 1350));
        // 3:4 スナップ: 4:5 要求に対し −6.25%（クロップ確定圏）。
        assert!(within_tolerance(1086, 1448, 1080, 1350));
    }

    /// DoD-6: Err 時は raw が残り、Ok 時は raw を作らない（ストレージ倍増なし）。
    #[test]
    fn raw_is_salvaged_only_on_failure() {
        let dir = tempfile::tempdir().unwrap();

        // 失敗ケース: raw が存在し、src とバイト一致する。
        let bad = write_png(dir.path(), "bad.png", 1024, 1536);
        let bad_dest = dir.path().join("bad_dest.png");
        let bad_raw = dir.path().join("bad_raw.png");
        assert!(normalize_or_salvage(&bad, &bad_dest, &bad_raw, "9:16").is_err());
        assert!(bad_raw.exists(), "失敗時は素材を救済保存する");
        assert_eq!(
            std::fs::read(&bad).unwrap(),
            std::fs::read(&bad_raw).unwrap(),
            "救済コピーは生ファイルのバイト一致"
        );
        assert!(!bad_dest.exists(), "失敗時は dest を作らない");

        // 成功ケース: raw は作られない。
        let good = write_png(dir.path(), "good.png", 941, 1672);
        let good_dest = dir.path().join("good_dest.png");
        let good_raw = dir.path().join("good_raw.png");
        normalize_or_salvage(&good, &good_dest, &good_raw, "9:16").unwrap();
        assert!(good_dest.exists());
        assert!(!good_raw.exists(), "成功時に raw を併存させない");
    }

    /// DoD-7（片側）: サイズ不一致判定の真偽表。
    #[test]
    fn is_size_mismatch_error_only_matches_the_prefix() {
        assert!(is_size_mismatch_error(&format!(
            "{SIZE_MISMATCH_PREFIX}生成画像（実測 1024×1536）が…"
        )));
        assert!(!is_size_mismatch_error("ServerError: 500"));
        assert!(!is_size_mismatch_error(
            "生成画像の読み込みに失敗しました: x"
        ));
        assert!(!is_size_mismatch_error(""));
    }

    /// DoD-9: 規格表に無いラベルは入力寸法のまま素通しコピーされる（フェイルオープン）。
    #[test]
    fn unknown_aspect_label_passes_through_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let src = write_png(dir.path(), "src.png", 1086, 1448);
        let dest = dir.path().join("dest.png");
        let raw = dir.path().join("raw.png");
        normalize_or_salvage(&src, &dest, &raw, "3:4").unwrap();
        assert_eq!(image::open(&dest).unwrap().dimensions(), (1086, 1448));
        assert_eq!(
            std::fs::read(&src).unwrap(),
            std::fs::read(&dest).unwrap(),
            "素通しはバイト一致のコピー"
        );
        assert!(!raw.exists());
    }

    /// 外部ツール（sips 等）での寸法実測用に、正規化済み PNG を
    /// `/tmp/normcheck/` へ書き出す。通常のテスト実行では走らせない
    /// （`cargo test --lib emit_fixtures_for_sips -- --ignored` で明示実行）。
    #[test]
    #[ignore]
    fn emit_fixtures_for_sips() {
        let dir = Path::new("/tmp/normcheck");
        std::fs::create_dir_all(dir).unwrap();
        for (label, w, h, name) in [
            ("16:9", 1672u32, 941u32, "out_16x9.png"),
            ("9:16", 941, 1672, "out_9x16.png"),
            ("1:1", 1254, 1254, "out_1x1.png"),
            ("4:5", 1086, 1448, "out_4x5.png"),
        ] {
            let src = write_png(dir, &format!("src_{name}"), w, h);
            normalize_or_salvage(&src, &dir.join(name), &dir.join("raw.png"), label).unwrap();
        }
    }

    /// A-2: raw 救済コピーが失敗したときに「素材は残しています」と偽らない。
    ///
    /// exec 経路の src は一時フォルダにあり処理終了で消えるため、救済に失敗したのに
    /// 「残っている」と言うと、ユーザーは存在しないファイルを探しに行くことになる。
    /// サイズ不一致であること（＝非リトライ）自体は変わらないので接頭辞は維持する。
    #[test]
    fn failed_raw_salvage_is_reported_honestly() {
        let dir = tempfile::tempdir().unwrap();
        let src = write_png(dir.path(), "bad.png", 1024, 1536);
        let dest = dir.path().join("dest.png");
        // 存在しない中間ディレクトリ配下 → std::fs::copy が必ず失敗する。
        let raw = dir.path().join("no_such_dir").join("bad_raw.png");

        let err = normalize_or_salvage(&src, &dest, &raw, "9:16").unwrap_err();

        assert!(
            is_size_mismatch_error(&err),
            "非リトライ判定は維持する: {err}"
        );
        assert!(!raw.exists(), "救済コピーは失敗している");
        assert!(
            !err.contains("に残しています"),
            "保存できていないのに「残している」と言わない: {err}"
        );
        assert!(err.contains("残っていません"), "救済失敗を明示する: {err}");
    }

    /// 復号できない入力は SIZE_MISMATCH ではない（＝リトライ対象のまま）。
    #[test]
    fn undecodable_input_is_not_a_size_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("broken.png");
        std::fs::write(&src, b"not a png").unwrap();
        let err = normalize_or_salvage(
            &src,
            &dir.path().join("dest.png"),
            &dir.path().join("raw.png"),
            "9:16",
        )
        .unwrap_err();
        assert!(!is_size_mismatch_error(&err), "err={err}");
    }
}
