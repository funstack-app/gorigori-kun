//! composite キャラクターシートの規格寸法への決定論正規化。
//!
//! composite シートの比率指定はプロンプト文言のみで（`character_sheet.rs` の
//! テンプレ定数に「アスペクト比 3:4」とハードコード）、生成呼び出しに
//! サイズ/比率の引数は存在しない。実測では 3:4 指定に対し 6/6 が
//! 1024×1536（=2:3、−11.1%）へスナップした。
//!
//! そこで受領点（`character_sheet.rs` の composite `Ok(image_path)` アーム）で
//! 規格 1080×1440 へ正規化する。`normalize.rs`（通常生成の cover 正規化）とは
//! 次の 2 点が異なる:
//!
//! - **contain（レターボックス）で正規化する**。シートは三面図の英語ラベル・
//!   右下のカラーパレット・立ち絵の頭/足という「縁の情報」が仕様で、
//!   cover の 11.1% センタークロップはそれらを黙って削る。contain は
//!   情報を 1 画素も捨てない。
//! - **帯を乗法 ±15% にする**。±10%（`normalize.rs` 値）だと実測 6/6 の
//!   2:3 が全滅して登録フローが機能不能になる。±15% は 2:3（r=0.8889）を含み、
//!   シートレイアウト自体が崩壊している 9:16（0.7504）/ 1:1（1.3333）を排除する。
//!
//! 帯超過は失敗扱い（自動再生成はしない）。素材は `_raw.png` へリネームして救済する。

use std::path::Path;

use crate::images::normalize::SIZE_MISMATCH_PREFIX;

/// 一時ファイル名のプロセス内連番。PID と組み合わせて一時ファイル名を一意にする。
///
/// PID だけだと、同一プロセスが同じ stem を並行に正規化したとき同じ一時ファイル名を
/// 作って互いを踏む（一方の rename がもう一方の書きかけを持ち去る）。
static NORM_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// composite キャラクターシートの規格寸法（3:4 厳密）。
///
/// 3:4 ネイティブ実測 1086×1448 から一様縮小 0.9945・クロップ 0 で到達する
/// （拡大なし原則）。4:5 規格 1080×1350 と幅ファミリーも揃う。
pub const SHEET_CANONICAL_W: u32 = 1080;
pub const SHEET_CANONICAL_H: u32 = 1440;

/// 実出力 w×h が規格 3:4 から乗法 ±15% 以内か。
///
/// `normalize.rs::within_tolerance` と同形式の u128 交差乗算。比率を浮動小数に
/// すると境界値（ちょうど +15.0%）の判定が丸め方向に依存して揺れるため、
/// 整数演算に固定する。境界は PASS に含める。
fn within_sheet_tolerance(w: u32, h: u32) -> bool {
    let (w, h, tw, th) = (
        w as u128,
        h as u128,
        SHEET_CANONICAL_W as u128,
        SHEET_CANONICAL_H as u128,
    );
    100 * w * th <= 115 * tw * h && 100 * tw * h <= 115 * w * th
}

/// 帯が付く軸の縁 1px（左右帯なら左端・右端の各 1px 列、上下帯なら上端・下端の
/// 各 1px 行）のチャンネル別整数平均。設定・推測なしの決定論でパディング色を決める。
///
/// オフホワイト系シートでは余白が広がったようにしか見えず、White/Green/Blue の
/// 背景指定では縁がその色なので帯も同色になり、クロマキー用途を壊さない。
///
/// サンプリング元は**元画像**であって Lanczos 拡縮後の画像ではない。拡縮後の縁 1px は
/// リサンプリングで内部の色が混ざるため（細い縁ほど混色が強い）、設計が指定した
/// 「元画像の縁 1px 平均」から色がずれる。元画像から採ればフィルタに依存しない。
fn pad_fill_color(source: &image::RgbaImage, horizontal_bars: bool) -> image::Rgba<u8> {
    let (w, h) = source.dimensions();
    if w == 0 || h == 0 {
        return image::Rgba([255, 255, 255, 255]);
    }

    // u64 で累算する。最大でも 2 * 65535 * 255 程度なので溢れない。
    let mut sum = [0u64; 4];
    let mut count = 0u64;

    let mut accumulate = |px: &image::Rgba<u8>| {
        for c in 0..4 {
            sum[c] += px.0[c] as u64;
        }
        count += 1;
    };

    if horizontal_bars {
        // 左右に帯が付く → 元画像の左端列・右端列をサンプリング。
        for y in 0..h {
            accumulate(source.get_pixel(0, y));
            accumulate(source.get_pixel(w - 1, y));
        }
    } else {
        // 上下に帯が付く → 元画像の上端行・下端行をサンプリング。
        for x in 0..w {
            accumulate(source.get_pixel(x, 0));
            accumulate(source.get_pixel(x, h - 1));
        }
    }

    if count == 0 {
        return image::Rgba([255, 255, 255, 255]);
    }
    image::Rgba([
        (sum[0] / count) as u8,
        (sum[1] / count) as u8,
        (sum[2] / count) as u8,
        (sum[3] / count) as u8,
    ])
}

/// `path` のシート画像を検査し、規格 1080×1440 へ contain 正規化して**同じパスへ**上書きする。
///
/// - 既に 1080×1440: 何もしない（再エンコードしない。バイト不変）
/// - 帯内（±15%）: contain 縮小 → pad 色キャンバスへ中央 overlay → 同ディレクトリの
///   一時ファイルへ保存 → `fs::rename` で `path` を原子的に置換
/// - 帯超過: `path` を `{stem}_raw.png` へリネームし、`SIZE_MISMATCH_PREFIX` で始まる `Err`
/// - 復号エラー: 接頭辞なしの `Err`（ファイルは元名のまま。サイズ不一致と区別する）
pub fn normalize_sheet_or_salvage(path: &Path) -> Result<(), String> {
    let img = image::open(path).map_err(|e| format!("シート画像の読み込みに失敗しました: {e}"))?;
    let (w, h) = {
        use image::GenericImageView as _;
        img.dimensions()
    };

    if !within_sheet_tolerance(w, h) {
        return Err(salvage_as_raw(path, w, h));
    }

    // 規格ちょうどなら再エンコードしない（バイト不変。無駄な劣化と I/O を避ける）。
    if w == SHEET_CANONICAL_W && h == SHEET_CANONICAL_H {
        return Ok(());
    }

    let tw = SHEET_CANONICAL_W;
    let th = SHEET_CANONICAL_H;

    // contain: 枠内に収まる倍率でリサイズ（アスペクト維持）。`images.rs::resize_one` と同型。
    let scaled = img
        .resize(tw, th, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    let (sw, sh) = scaled.dimensions();

    // 帯が付く軸を決める。source が縦長すぎる（幅が足りない）→ 左右帯。
    let horizontal_bars = sw < tw;
    // パディング色は**元画像**の縁から採る（拡縮後だとリサンプリングで内部色が混ざる）。
    let pad = pad_fill_color(&img.to_rgba8(), horizontal_bars);

    let mut canvas: image::RgbaImage = image::ImageBuffer::from_pixel(tw, th, pad);
    let ox = ((tw - sw) / 2) as i64;
    let oy = ((th - sh) / 2) as i64;
    image::imageops::overlay(&mut canvas, &scaled, ox, oy);

    // watcher 監視下の out_dir に「半書きファイル」を見せないため、同ディレクトリの
    // 一時ファイルへ書いてから rename で置換する（同一ボリューム内 rename）。
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "sheet".to_string());
    // 固定名だと、同じ出力先・同じ stem を並行処理したとき互いの一時ファイルを踏む。
    // PID だけでは**同一プロセス内**の並行呼び出し（同じ stem を複数スレッドで正規化）が
    // 同じ名前を作って踏み合う（Sol指摘 2026-08-03）。プロセス内で単調増加する
    // カウンタを足して、プロセス間・プロセス内の両方で一意にする。
    let seq = NORM_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{stem}.norm-tmp-{}-{seq}.png", std::process::id()));
    canvas
        .save_with_format(&tmp, image::ImageFormat::Png)
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("正規化シートの書き出しに失敗しました: {e}")
        })?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("正規化シートの置き換えに失敗しました: {e}")
    })?;
    Ok(())
}

/// 帯超過の素材を `{stem}_raw.png` へリネームして救済し、失敗文言を組み立てる。
///
/// コピーでなくリネームなので**素材の消失経路が無い**。リネームに失敗した場合は、
/// 「元の名前のまま残っている」と言い切る前に**元ファイルの実在を確認する**。
/// 外部要因（他プロセスの削除・ボリューム切断）で元ファイルが消えていることは
/// あり得るので、無条件に所在を断言すると偽装になる（A-2「偽装しない」）。
fn salvage_as_raw(path: &Path, w: u32, h: u32) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "sheet".to_string());
    // `{stem}_raw.png` に**ファイル**が既にあると、以前の救済素材を rename で
    // 上書きしてしまう（素材の消失経路になる）。空いている連番へ退避先をずらす。
    // ディレクトリ等が居座っている場合はずらさない。rename をそこで失敗させて
    // 「改名できなかった」を正直に報告する経路（下の Err アーム）に落とす。
    let mut raw_path = path.with_file_name(format!("{stem}_raw.png"));
    let mut serial = 2u32;
    while raw_path.is_file() && serial < 1000 {
        raw_path = path.with_file_name(format!("{stem}_raw-{serial}.png"));
        serial += 1;
    }
    // 連番を撃ち尽くしても空きが無い場合、最後に作った候補は**既存ファイル**のまま。
    // そこへ rename すると以前の救済素材を上書きして消す（Sol指摘 2026-08-03）。
    // 空きが無いことを正直に報告し、素材は元の名前のまま触らずに残す。
    if raw_path.is_file() {
        let original_file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "(不明)".to_string());
        return format!(
            "{SIZE_MISMATCH_PREFIX}シート画像（実測 {w}×{h}）が規格 3:4（{SHEET_CANONICAL_W}×{SHEET_CANONICAL_H}）\
             から15%を超えて外れています。この生成は失敗扱いにしました（自動再生成はしません）。\
             退避先 {stem}_raw.png ～ {stem}_raw-999.png がすべて埋まっているため退避できませんでした。\
             素材は元の名前 {original_file_name} のまま残しています（不要な _raw ファイルを整理してください）。"
        );
    }
    let raw_file_name = raw_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "(不明)".to_string());
    let original_file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "(不明)".to_string());

    let salvage_note = match std::fs::rename(path, &raw_path) {
        Ok(()) => format!("素材は {raw_file_name} に残しています。"),
        Err(e) => {
            tracing::warn!(
                target: "codex.images.sheet_normalize",
                "サイズ不一致シートの改名に失敗しました: {e}"
            );
            // 「元の名前のまま残っています」は実在を確認してからしか言わない。
            if path.exists() {
                format!("素材は元の名前 {original_file_name} のまま残っています（改名失敗: {e}）。")
            } else {
                format!(
                    "素材の改名に失敗し（{e}）、元の {original_file_name} も見つかりません。\
                     素材は残っていません。"
                )
            }
        }
    };

    format!(
        "{SIZE_MISMATCH_PREFIX}シート画像（実測 {w}×{h}）が規格 3:4（{SHEET_CANONICAL_W}×{SHEET_CANONICAL_H}）\
         から15%を超えて外れています。この生成は失敗扱いにしました（自動再生成はしません）。{salvage_note}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::normalize::is_size_mismatch_error;
    use image::GenericImageView as _;

    /// 規格寸法の期待値をテスト側に**独立リテラル**で固定する。
    /// `SHEET_CANONICAL_W/H` を参照すると、定数を別の 3:4 寸法へ書き換えたときに
    /// テストが一緒に追従して通ってしまい、回帰検知の牙が抜ける（自己言及の罠）。
    const EXPECTED_W: u32 = 1080;
    const EXPECTED_H: u32 = 1440;

    /// 指定寸法の単色 PNG を作って書き出す。
    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
        write_png_color(dir, name, w, h, image::Rgba([10, 200, 90, 255]))
    }

    fn write_png_color(
        dir: &Path,
        name: &str,
        w: u32,
        h: u32,
        color: image::Rgba<u8>,
    ) -> std::path::PathBuf {
        let path = dir.join(name);
        let buf: image::RgbaImage = image::ImageBuffer::from_pixel(w, h, color);
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        path
    }

    /// DoD-1: 実測スナップ 1024×1536（2:3、6/6 クラス）が救済され、
    /// 1080×1440 ちょうど + 左右端が入力縁と同色のパディングになる。
    #[test]
    fn real_world_two_to_three_snap_is_contained_to_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let color = image::Rgba([10, 200, 90, 255]);
        let path = write_png_color(dir.path(), "snap.png", 1024, 1536, color);

        normalize_sheet_or_salvage(&path).unwrap();

        let out = image::open(&path).unwrap();
        assert_eq!(out.dimensions(), (EXPECTED_W, EXPECTED_H));
        let rgba = out.to_rgba8();
        // 単色入力なので、パディング色は入力縁と同色になる。
        assert_eq!(*rgba.get_pixel(0, 720), color, "左端の帯が入力縁と同色");
        assert_eq!(
            *rgba.get_pixel(EXPECTED_W - 1, 720),
            color,
            "右端の帯が入力縁と同色"
        );
        assert_eq!(*rgba.get_pixel(540, 720), color, "中央は入力色のまま");
    }

    /// DoD-2: ネイティブ 3:4（1086×1448）は contain がちょうど内接し、
    /// 全画素が入力と同色（パディング 0 の検証）。
    #[test]
    fn native_three_to_four_normalizes_without_padding() {
        let dir = tempfile::tempdir().unwrap();
        let color = image::Rgba([10, 200, 90, 255]);
        let path = write_png_color(dir.path(), "native.png", 1086, 1448, color);

        normalize_sheet_or_salvage(&path).unwrap();

        let out = image::open(&path).unwrap();
        assert_eq!(out.dimensions(), (EXPECTED_W, EXPECTED_H));
        let rgba = out.to_rgba8();
        for (_, _, px) in rgba.enumerate_pixels() {
            assert_eq!(*px, color, "パディングが 1 画素も入らない");
        }
    }

    /// DoD-3: 規格ちょうどの入力は再エンコードしない（バイト不変）。
    #[test]
    fn exact_canonical_input_is_left_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "exact.png", EXPECTED_W, EXPECTED_H);
        let before = std::fs::read(&path).unwrap();

        normalize_sheet_or_salvage(&path).unwrap();

        assert_eq!(before, std::fs::read(&path).unwrap(), "バイト不変");
    }

    /// DoD-4: ±15% 境界を両側から挟む（整数交差乗算の境界固定）。
    #[test]
    fn tolerance_boundary_is_inclusive_at_exactly_fifteen_percent() {
        // 上側: 1080 * 1.15 = 1242 ちょうど。
        assert!(within_sheet_tolerance(1242, 1440), "+15.0% は許容内");
        assert!(!within_sheet_tolerance(1243, 1440), "+15.0% 超は許容外");
        // 下側: 1080 / 1.15 = 939.13...。940 が最小の PASS。
        assert!(within_sheet_tolerance(940, 1440), "1/1.15 の内側は許容内");
        assert!(!within_sheet_tolerance(939, 1440), "1/1.15 の外側は許容外");
    }

    /// DoD-5（牙の実証）: レイアウト崩壊級のスナップを機械的に落とし、
    /// 実測 2:3 は通す。
    #[test]
    fn layout_breaking_snaps_are_rejected_and_two_to_three_passes() {
        assert!(
            within_sheet_tolerance(1024, 1536),
            "2:3 スナップ（実測6/6）は救済対象"
        );
        assert!(within_sheet_tolerance(1086, 1448), "3:4 ネイティブ");
        assert!(within_sheet_tolerance(1087, 1447), "±1px ジッタ");
        assert!(!within_sheet_tolerance(941, 1672), "9:16 は排除");
        assert!(!within_sheet_tolerance(1254, 1254), "1:1 は排除");
        assert!(!within_sheet_tolerance(1672, 941), "16:9 は排除");
    }

    /// DoD-6: FAIL 入力は `{stem}_raw.png` にリネーム救済され、元パスは消える。
    /// Err は接頭辞付きで実測寸法を含む。
    #[test]
    fn out_of_band_input_is_renamed_to_raw_and_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "cut_character-sheet_ab12.png", 1254, 1254);
        let before = std::fs::read(&path).unwrap();

        let err = normalize_sheet_or_salvage(&path).unwrap_err();

        assert!(is_size_mismatch_error(&err), "非リトライ判定: {err}");
        assert!(err.contains("1254×1254"), "実測寸法を含む: {err}");
        let raw = dir.path().join("cut_character-sheet_ab12_raw.png");
        assert!(raw.exists(), "raw へ救済されている");
        assert_eq!(before, std::fs::read(&raw).unwrap(), "リネームはバイト一致");
        assert!(
            !path.exists(),
            "元パスは残らない（リネームなのでコピーでない）"
        );
    }

    /// DoD-6（正直文言）: リネームに失敗しても素材は元名のまま残る。
    /// 「_raw に残しています」と偽らず、実態どおり報告する。
    #[test]
    fn failed_rename_is_reported_honestly() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "bad.png", 1254, 1254);
        // 同名のディレクトリを置いて rename を必ず失敗させる。
        std::fs::create_dir(dir.path().join("bad_raw.png")).unwrap();

        let err = normalize_sheet_or_salvage(&path).unwrap_err();

        assert!(is_size_mismatch_error(&err), "非リトライ判定は維持: {err}");
        assert!(path.exists(), "リネーム失敗時、素材は元名のまま残る");
        assert!(
            err.contains("元の名前 bad.png のまま"),
            "実態どおりの所在を報告する: {err}"
        );
        assert!(
            !err.contains("bad_raw.png に残しています"),
            "改名できていないのに改名先に残ったと言わない: {err}"
        );
    }

    /// 改名に失敗し、かつ元ファイルも消えている場合は「元の名前のまま残っています」と
    /// 言わない。競合削除・ボリューム切断で実際に起こりうる状態で、所在を無条件に
    /// 断言すると偽装になる（A-2「偽装しない」）。
    ///
    /// `salvage_as_raw` を直接呼ぶ。`normalize_sheet_or_salvage` 経由だと画像を読める
    /// 必要があり「読めるのに存在しない」を作れないため、救済判断だけを単離する。
    #[test]
    fn missing_original_after_failed_rename_is_not_claimed_to_remain() {
        let dir = tempfile::tempdir().unwrap();
        // 存在しないパス → rename は必ず失敗し、元ファイルも実在しない。
        let path = dir.path().join("vanished.png");
        assert!(!path.exists(), "前提: 元ファイルは無い");

        let err = salvage_as_raw(&path, 1254, 1254);

        assert!(is_size_mismatch_error(&err), "非リトライ判定は維持: {err}");
        assert!(
            !err.contains("のまま残っています"),
            "消えているのに残っていると言わない: {err}"
        );
        assert!(
            !err.contains("vanished_raw.png に残しています"),
            "改名できていないのに改名先に残ったと言わない: {err}"
        );
        assert!(
            err.contains("素材は残っていません"),
            "素材が無いことをそのまま報告する: {err}"
        );
    }

    /// DoD-7: 規格より小さい 2:3 も失敗にせず、拡大して規格へ揃える。
    #[test]
    fn undersized_input_is_upscaled_to_canonical() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "small.png", 768, 1152);

        normalize_sheet_or_salvage(&path).unwrap();

        assert_eq!(
            image::open(&path).unwrap().dimensions(),
            (EXPECTED_W, EXPECTED_H)
        );
    }

    /// DoD-8: 復号不能入力はサイズ不一致と区別され、ファイルは元名のまま残る。
    #[test]
    fn undecodable_input_is_not_a_size_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.png");
        std::fs::write(&path, b"not a png").unwrap();

        let err = normalize_sheet_or_salvage(&path).unwrap_err();

        assert!(!is_size_mismatch_error(&err), "接頭辞を付けない: {err}");
        assert!(path.exists(), "ファイルは元名のまま残る");
        assert!(
            !dir.path().join("broken_raw.png").exists(),
            "raw 救済は走らない"
        );
    }

    /// パディング色が「帯が付く軸の縁 1px の平均」であること。
    /// 中央だけ別色の入力で、帯が縁色（中央色でない）になることを確認する。
    #[test]
    fn padding_uses_the_edge_average_not_the_center() {
        let dir = tempfile::tempdir().unwrap();
        let edge = image::Rgba([250, 250, 250, 255]);
        let center = image::Rgba([0, 0, 0, 255]);
        // 2:3（左右に帯が付くクラス）で、中央に黒いブロックを置く。
        let mut buf: image::RgbaImage = image::ImageBuffer::from_pixel(1024, 1536, edge);
        for y in 400..1100 {
            for x in 200..800 {
                buf.put_pixel(x, y, center);
            }
        }
        let path = dir.path().join("edged.png");
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();

        normalize_sheet_or_salvage(&path).unwrap();

        let rgba = image::open(&path).unwrap().to_rgba8();
        let pad = *rgba.get_pixel(0, 720);
        assert_eq!(pad, edge, "帯は縁色（中央の黒でない）");
    }

    /// 上下帯クラスでもパディング色が「上端行・下端行の平均」であること。
    /// 左右帯だけを見ていると、上下帯側のサンプリング軸を取り違えても気づけない。
    #[test]
    fn horizontal_band_padding_uses_top_and_bottom_edge_average() {
        let dir = tempfile::tempdir().unwrap();
        let edge = image::Rgba([240, 30, 30, 255]);
        let center = image::Rgba([0, 0, 0, 255]);
        // 左右端は別色にしておく。上下端と左右端が同色だとサンプリング軸を
        // 取り違えても同じ答えになり、この検査に牙が無くなる。
        let side = image::Rgba([30, 30, 240, 255]);
        // 1242×1440 は許容帯の上限ぎりぎり（横に広い）→ 上下に帯が付くクラス。
        let (sw, sh) = (1242u32, 1440u32);
        let mut buf: image::RgbaImage = image::ImageBuffer::from_pixel(sw, sh, edge);
        for y in 300..1100 {
            for x in 200..1000 {
                buf.put_pixel(x, y, center);
            }
        }
        for y in 0..sh {
            buf.put_pixel(0, y, side);
            buf.put_pixel(sw - 1, y, side);
        }
        let path = dir.path().join("wide.png");
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();

        normalize_sheet_or_salvage(&path).unwrap();

        let rgba = image::open(&path).unwrap().to_rgba8();
        assert_eq!(rgba.dimensions(), (EXPECTED_W, EXPECTED_H));
        // 上端行・下端行はほぼ edge 一色（両端 2px だけ side）なので、平均は edge に
        // 極めて近い赤。左右端を採っていれば青（side）に寄るので、赤優勢で識別できる。
        for y in [0, EXPECTED_H - 1] {
            let p = rgba.get_pixel(540, y).0;
            assert!(
                p[0] > 200 && p[2] < 60,
                "上下帯が上下端の平均（赤系）でない。左右端を採った疑い: y={y} {p:?}"
            );
        }
        assert_ne!(*rgba.get_pixel(540, 0), center, "中央の黒を拾っていない");
    }

    /// パディング色は Lanczos 拡縮**後**でなく**元画像**の縁 1px から採ること。
    ///
    /// 縁を 1px だけの細いストライプにすると、拡縮後の縁 1px には隣接する内部色が
    /// リサンプリングで混ざる。元画像から採れば縁色そのものになり、拡縮後から採ると
    /// 混色した別の色になるので、両者を色で識別できる（この差がこのテストの牙）。
    #[test]
    fn padding_samples_the_source_edge_not_the_resampled_edge() {
        let dir = tempfile::tempdir().unwrap();
        let edge = image::Rgba([255, 255, 255, 255]);
        let inner = image::Rgba([0, 0, 0, 255]);
        // 2:3（左右に帯が付くクラス）。左端・右端の 1px 列だけ白、残りは黒。
        let (sw, sh) = (1024u32, 1536u32);
        let mut buf: image::RgbaImage = image::ImageBuffer::from_pixel(sw, sh, inner);
        for y in 0..sh {
            buf.put_pixel(0, y, edge);
            buf.put_pixel(sw - 1, y, edge);
        }
        let path = dir.path().join("thin-edge.png");
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();

        normalize_sheet_or_salvage(&path).unwrap();

        let rgba = image::open(&path).unwrap().to_rgba8();
        assert_eq!(rgba.dimensions(), (EXPECTED_W, EXPECTED_H));
        // 元画像の縁 1px 列は純白のみ → 平均も純白。
        // 拡縮後の縁から採ると黒が混ざり、白から大きく外れる。
        let pad = *rgba.get_pixel(0, 720);
        assert_eq!(
            pad, edge,
            "パディングが元画像の縁色（純白）でない。拡縮後の縁を採って内部色が混ざった疑い: {:?}",
            pad.0
        );
    }

    /// クロップされていないことを画素位置で証明する。
    /// 単色入力では「削られた」ことが色に現れないため、四隅の内側にマーカーを置き、
    /// contain 後の対応位置にそれが残っているかを見る。cover（センタークロップ）だと
    /// 短辺方向の外周が捨てられ、マーカーの少なくとも一部が消える。
    #[test]
    fn corner_markers_survive_so_nothing_is_cropped() {
        let dir = tempfile::tempdir().unwrap();
        let bg = image::Rgba([250, 250, 250, 255]);
        let marker = image::Rgba([255, 0, 0, 255]);
        let (sw, sh) = (1024u32, 1536u32); // 実測 2:3 スナップ（左右に帯が付く）
        let mut buf: image::RgbaImage = image::ImageBuffer::from_pixel(sw, sh, bg);
        // 四隅の内側に 40px 角のマーカーを置く（縁 1px はパディング色サンプル用に残す）。
        let m = 40u32;
        for dy in 0..m {
            for dx in 0..m {
                buf.put_pixel(2 + dx, 2 + dy, marker); // 左上
                buf.put_pixel(sw - 3 - dx, 2 + dy, marker); // 右上
                buf.put_pixel(2 + dx, sh - 3 - dy, marker); // 左下
                buf.put_pixel(sw - 3 - dx, sh - 3 - dy, marker); // 右下
            }
        }
        let path = dir.path().join("markers.png");
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();

        normalize_sheet_or_salvage(&path).unwrap();

        let rgba = image::open(&path).unwrap().to_rgba8();
        assert_eq!(rgba.dimensions(), (EXPECTED_W, EXPECTED_H));

        // contain の縮小率と配置オフセットをテスト側で独立に再計算する。
        let scale = (EXPECTED_W as f64 / sw as f64).min(EXPECTED_H as f64 / sh as f64);
        let out_w = (sw as f64 * scale).round() as u32;
        let out_h = (sh as f64 * scale).round() as u32;
        let ox = (EXPECTED_W - out_w) / 2;
        let oy = (EXPECTED_H - out_h) / 2;

        // 「赤成分が優勢な画素」でマーカーを判定する（Lanczos で厳密同値にはならない）。
        let is_marker = |x: u32, y: u32| {
            let p = rgba.get_pixel(x, y).0;
            p[0] > 200 && p[1] < 150 && p[2] < 150
        };
        // 各マーカーの中心付近（縮小後座標）を見る。
        let mid = (m as f64 * scale / 2.0).round() as u32;
        for (cx, cy, label) in [
            (ox + mid, oy + mid, "左上"),
            (ox + out_w - 1 - mid, oy + mid, "右上"),
            (ox + mid, oy + out_h - 1 - mid, "左下"),
            (ox + out_w - 1 - mid, oy + out_h - 1 - mid, "右下"),
        ] {
            assert!(
                is_marker(cx, cy),
                "{label}のマーカーが消えている（クロップされた疑い）: ({cx},{cy}) = {:?}",
                rgba.get_pixel(cx, cy).0
            );
        }
    }

    /// `{stem}_raw.png` が既にあっても、以前の救済素材を上書きしない。
    #[test]
    fn existing_raw_file_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "dup.png", 1254, 1254);
        let existing =
            write_png_color(dir.path(), "dup_raw.png", 8, 8, image::Rgba([1, 2, 3, 255]));
        let existing_bytes = std::fs::read(&existing).unwrap();

        let err = normalize_sheet_or_salvage(&path).unwrap_err();

        assert!(is_size_mismatch_error(&err), "非リトライ判定は維持: {err}");
        assert_eq!(
            existing_bytes,
            std::fs::read(&existing).unwrap(),
            "既存の _raw.png は書き換わらない"
        );
        assert!(
            dir.path().join("dup_raw-2.png").exists(),
            "連番の退避先へ救済されている"
        );
        assert!(
            err.contains("dup_raw-2.png"),
            "実際の退避先を報告する: {err}"
        );
    }

    /// 連番の退避先を撃ち尽くしたら、既存を上書きせず失敗として報告する。
    ///
    /// 上限に達したとき最後の候補（`_raw-999.png`）は既存ファイルのままなので、
    /// そこへ rename すると以前の救済素材が消える。素材の消失経路を残さない。
    #[test]
    fn exhausted_raw_serials_do_not_overwrite_existing_salvage() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "full.png", 1254, 1254);
        // `_raw.png` と `_raw-2..=999.png` をすべて埋める。
        write_png_color(
            dir.path(),
            "full_raw.png",
            8,
            8,
            image::Rgba([1, 2, 3, 255]),
        );
        for serial in 2..1000u32 {
            write_png_color(
                dir.path(),
                &format!("full_raw-{serial}.png"),
                8,
                8,
                image::Rgba([4, 5, 6, 255]),
            );
        }
        let last = dir.path().join("full_raw-999.png");
        let last_bytes = std::fs::read(&last).unwrap();

        let err = normalize_sheet_or_salvage(&path).unwrap_err();

        assert!(is_size_mismatch_error(&err), "非リトライ判定は維持: {err}");
        assert_eq!(
            last_bytes,
            std::fs::read(&last).unwrap(),
            "最後の連番 _raw-999.png を上書きしていない"
        );
        assert!(path.is_file(), "退避できないときは素材を元の名前のまま残す");
        assert!(
            err.contains("full.png"),
            "素材が元の名前で残っていることを報告する: {err}"
        );
    }

    /// 縦長すぎ（左右帯）と横長すぎ（上下帯）の両方で規格寸法ちょうどになる。
    #[test]
    fn both_bar_axes_reach_exact_canonical_size() {
        let dir = tempfile::tempdir().unwrap();
        for (i, (w, h)) in [(1024u32, 1536u32), (1242u32, 1440u32)].iter().enumerate() {
            let path = write_png(dir.path(), &format!("bars{i}.png"), *w, *h);
            normalize_sheet_or_salvage(&path).unwrap();
            assert_eq!(
                image::open(&path).unwrap().dimensions(),
                (EXPECTED_W, EXPECTED_H),
                "input={w}×{h}"
            );
        }
    }

    /// 一時ファイル（`.norm-tmp.png`）を出力ディレクトリに残さない。
    /// watcher 監視下なので、残骸がギャラリーに現れると事故になる。
    #[test]
    fn no_temp_file_is_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "cut.png", 1024, 1536);

        normalize_sheet_or_salvage(&path).unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("norm-tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "一時ファイルが残っている: {leftovers:?}"
        );
    }
}
