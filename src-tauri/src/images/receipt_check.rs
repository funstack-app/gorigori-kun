//! MultiCut 受領時の軽量バリデータ（S1b / D14）。
//!
//! composite 経路（`character_sheet.rs` の `Ok(image_path)` アーム）には
//! `sheet_normalize::normalize_sheet_or_salvage` という受領時ゲートがあるが、
//! **MultiCut 経路にはいかなる受領時検品も無い**（実コード確認済み）。
//! `gen_worker::generate_one_cut_for_run_with_slot_hook` は生成物を
//! `std::fs::copy` でコピーしてパスを返すだけで、**中身を一度もデコードしない**。
//! したがって 0 バイト・切り詰め・非画像バイト列でも `Ok(path)` になり、
//! `CutCompleted` として「成功」で UI へ出てしまう。
//!
//! ここで見るのは「**壊れているか**」だけ。
//!
//! **規格への正規化はここでやらない**（設計 §1.8）。MultiCut の出力は
//! スタンプ 370×320 のような規格へ潰すと編集余地を殺す。`sheet_normalize` が
//! composite に対して行う寸法正規化とは目的が違う。
//!
//! この検査は MultiCut 経路を共有する **expressionSet / multiAngle /
//! characterRegister も同時に治す**。

use std::path::Path;

/// 受領時検品に落ちた画像の失敗文言に付く接頭辞。
///
/// `normalize::SIZE_MISMATCH_PREFIX` とは**別の接頭辞にする**。あちらは
/// batch_gen の再試行抑止（`is_size_mismatch_error`）に結線されており、
/// 意味の違う失敗を同じ札で流すと再試行方針が混ざる。
pub const BROKEN_IMAGE_PREFIX: &str = "生成画像が壊れています: ";

/// 受領した生成画像がデコードできるかだけを確認する。
///
/// 正規化・リサイズ・救済リネームは**しない**。ファイルは一切変更しない。
///
/// - デコードできる: `Ok(())`
/// - 0 バイト / 切り詰め / 非画像 / 読めない: `BROKEN_IMAGE_PREFIX` 付きの `Err`
///
/// 幅か高さが 0 の画像も壊れている扱いにする。`image` クレートは 0 幅 PNG を
/// デコード自体は通してしまうことがあり、そのまま下流へ流すと「成功したのに
/// 何も描かれていない」カットになる。
pub fn ensure_decodable(path: &Path) -> Result<(), String> {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "(不明)".to_string());

    // メタデータを先に見る。0 バイトは「デコード失敗」より原因が明確なので、
    // 同じ札にまとめず固有の文言で報告する（切り分けの手数が変わる）。
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() == 0 => {
            return Err(format!(
                "{BROKEN_IMAGE_PREFIX}{file_name} は0バイトです。生成に失敗した可能性があります。"
            ));
        }
        Ok(_) => {}
        Err(e) => {
            return Err(format!(
                "{BROKEN_IMAGE_PREFIX}{file_name} を読み取れませんでした: {e}"
            ));
        }
    }

    // 全画素をデコードする。ヘッダだけ読む方式（`image::image_dimensions`）だと
    // **切り詰めファイルを見逃す**（ヘッダは無事で本体が欠けている状態が
    // まさに検出したいもの）。カット1枚ぶんのデコードコストは、生成にかかる
    // 数十秒に対して無視できる。
    let img = image::open(path)
        .map_err(|e| format!("{BROKEN_IMAGE_PREFIX}{file_name} をデコードできませんでした: {e}"))?;

    let (w, h) = {
        use image::GenericImageView as _;
        img.dimensions()
    };
    if w == 0 || h == 0 {
        return Err(format!(
            "{BROKEN_IMAGE_PREFIX}{file_name} の寸法が {w}×{h} です（幅または高さが0）。"
        ));
    }

    Ok(())
}

/// 失敗文言が受領時検品由来か。
pub fn is_broken_image_error(error: &str) -> bool {
    error.starts_with(BROKEN_IMAGE_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 接頭辞をテスト側に**独立リテラル**で固定する。定数を参照すると、
    /// 接頭辞を書き換えたときテストが一緒に追従して通ってしまい牙が抜ける
    /// （`sheet_normalize` の EXPECTED_W/H と同じ理由）。
    const EXPECTED_PREFIX: &str = "生成画像が壊れています: ";

    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
        let path = dir.join(name);
        let buf: image::RgbaImage =
            image::ImageBuffer::from_pixel(w, h, image::Rgba([10, 200, 90, 255]));
        image::DynamicImage::ImageRgba8(buf)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        path
    }

    /// 正常な PNG は通る。既存3スキル（expressionSet / multiAngle /
    /// characterRegister）の従来どおりの成功経路が塞がれないことの固定。
    #[test]
    fn healthy_png_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "cut_front_ab12.png", 1024, 1536);

        assert!(ensure_decodable(&path).is_ok());
    }

    /// ファイルを一切変更しない（正規化・リネームをしないことの証明）。
    #[test]
    fn healthy_png_is_left_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "cut.png", 800, 600);
        let before = std::fs::read(&path).unwrap();

        ensure_decodable(&path).unwrap();

        assert_eq!(before, std::fs::read(&path).unwrap(), "バイト不変");
    }

    /// 0 バイトファイルは落ちる。`fs::copy` が空ファイルを作った状態。
    #[test]
    fn zero_byte_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.png");
        std::fs::write(&path, b"").unwrap();

        let err = ensure_decodable(&path).unwrap_err();

        assert!(err.starts_with(EXPECTED_PREFIX), "接頭辞が付く: {err}");
        assert!(err.contains("0バイト"), "原因が分かる文言: {err}");
        assert!(path.exists(), "ファイルは触らない");
    }

    /// 非画像バイト列は落ちる。
    #[test]
    fn non_image_bytes_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.png");
        std::fs::write(&path, b"not a png at all").unwrap();

        let err = ensure_decodable(&path).unwrap_err();

        assert!(err.starts_with(EXPECTED_PREFIX), "接頭辞が付く: {err}");
        assert!(path.exists(), "ファイルは触らない（救済リネームをしない）");
    }

    /// **牙の核心**: ヘッダは正しいが本体が切り詰められた PNG を落とす。
    ///
    /// `image::image_dimensions`（ヘッダだけ読む）で実装すると、この入力は
    /// 寸法を返して**通ってしまう**。全画素デコードでのみ検出できる。
    #[test]
    fn truncated_png_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_png(dir.path(), "full.png", 512, 512);
        let bytes = std::fs::read(&path).unwrap();
        let cut_path = dir.path().join("truncated.png");

        // 「ヘッダは読めるが画素が欠けている」最小の切り詰め点を、固定バイト数でなく
        // **実ファイルから探索して**決める。エンコーダが IHDR の後に何のチャンクを
        // 何バイト置くかは image クレートの版で変わるため、マジックナンバー
        // （33 等）を焼くと版が上がった瞬間に前提ごと崩れる（規律3: 境界値・
        // その時の値を検証コードにハードコードしない）。
        let split = (1..bytes.len())
            .find(|&n| {
                std::fs::write(&cut_path, &bytes[..n]).unwrap();
                image::image_dimensions(&cut_path).is_ok()
            })
            .expect("ヘッダだけ読める切り詰め点が存在するはず");
        std::fs::write(&cut_path, &bytes[..split]).unwrap();

        // 前提の固定: ヘッダ読みでは寸法が取れてしまう（＝ヘッダ読み実装は無力）。
        assert!(
            image::image_dimensions(&cut_path).is_ok(),
            "この入力はヘッダ読みでは通る。全画素デコードでのみ落とせる"
        );
        assert!(split < bytes.len(), "画素データが欠けた状態であること");

        let err = ensure_decodable(&cut_path).unwrap_err();
        assert!(err.starts_with(EXPECTED_PREFIX), "接頭辞が付く: {err}");
    }

    /// 存在しないパスは落ちる。
    #[test]
    fn missing_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vanished.png");

        let err = ensure_decodable(&path).unwrap_err();

        assert!(err.starts_with(EXPECTED_PREFIX), "接頭辞が付く: {err}");
    }

    /// 判定ヘルパが接頭辞で識別できる。
    #[test]
    fn broken_image_error_is_identifiable() {
        assert!(is_broken_image_error(&format!(
            "{EXPECTED_PREFIX}x.png は0バイトです。"
        )));
        assert!(!is_broken_image_error("生成サイズ不一致: ..."));
        assert!(!is_broken_image_error("キャンセルされました"));
    }

    /// サイズ不一致（`normalize` 側）とは別の札であること。
    /// 同じ接頭辞にすると batch_gen の再試行抑止に巻き込まれる。
    #[test]
    fn prefix_is_distinct_from_size_mismatch() {
        use crate::images::normalize::{is_size_mismatch_error, SIZE_MISMATCH_PREFIX};

        assert_ne!(BROKEN_IMAGE_PREFIX, SIZE_MISMATCH_PREFIX);
        let broken = format!("{EXPECTED_PREFIX}x.png は0バイトです。");
        assert!(
            !is_size_mismatch_error(&broken),
            "受領時検品の失敗をサイズ不一致として扱わない"
        );
    }
}
