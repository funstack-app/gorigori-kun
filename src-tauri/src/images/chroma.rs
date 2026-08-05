//! クロマキー抜き（決定論）。
//!
//! LINE スタンプ経路は「`SheetBackground::Green` で生成 → ここで `#00FF00` を
//! 決定論で抜く」という順序を取る（設計書 §1.4 決定4 = B案）。
//!
//! **なぜ AI の背景除去でなくクロマキーか**: 既存の背景除去（Mac=Vision /
//! Windows通常版=BiRefNet）は「何が前景か」をモデルが推定するため、**白いキャラを
//! 白背景から分離できない**（`sticker-craft-research.md` §3-2 の実測）。
//! クロマキーは**背景色を先に決めてから抜く**ので前景が何色でも関係ない。
//! 純白のキャラでも `#00FF00` とは色距離が最大に離れる。「白は諦めず、背景側を
//! 動かす」がこの経路の本質。
//!
//! 副次効果として、AIモデルもORTも要らないため **Windows互換版（ort抜き）でも動く**。
//!
//! **プロンプト指定は保証ではない**: `normalize.rs` 冒頭が「3:4指定に対し 6/6 が
//! 1024×1536 へスナップ」と記録しているのと同型で、緑背景も指定どおり出る保証はない。
//! ここの合成画像テストで分かるのは「均一な緑なら抜ける」ことだけで、
//! **「AIが本当に均一な緑を返すか」は実機実測（設計書 §4.5 E1/E2）でしか分からない**。

use image::{Rgba, RgbaImage};

/// クロマキーの基準色 `#00FF00`（RGB 0,255,0）。
///
/// `character_sheet.rs` の `COMPOSITE_SHEET_BG_LINE_GREEN` がプロンプトへ焼く色と
/// 同じ値。**片方だけ変えると抜きが全滅する**ため、変更時は必ず両方を見ること。
pub const KEY_COLOR: [u8; 3] = [0, 255, 0];

/// 完全に透過にする色距離のしきい値（この距離以下＝背景と確定）。
///
/// 距離は `color_distance_sq` の定義（R/G/B 各差の二乗和、最大 195_075）に対する値。
/// 90 は RGB 空間で各チャンネル平均 52 程度のブレまでを背景とみなす幅で、
/// JPEG 経由の圧縮ノイズや軽い照明ムラを吸収しつつ、緑寄りの前景（草・緑の服）を
/// 巻き込まない中間点として置いた**暫定値**。
///
/// **公式根拠のある値ではない**。実測（設計書 §4.5 E1）で抜け残り率を見て調整する。
pub const SOLID_THRESHOLD: u32 = 90 * 90;

/// ここまでは半透明の遷移帯として扱う距離のしきい値（これを超えたら前景と確定）。
///
/// `SOLID_THRESHOLD` から本値までの画素は、距離に比例したアルファを与える。
/// 生成画像の輪郭は必ずアンチエイリアスされており、二値で抜くと**縁がギザつくか、
/// 逆に背景色が縁に残る（フリンジ）**。遷移帯を設けることで縁を滑らかに落とす。
///
/// **公式根拠のある値ではない**。`SOLID_THRESHOLD` と同様に実測で調整する。
pub const EDGE_THRESHOLD: u32 = 160 * 160;

/// スピル除去を適用する「緑被り」の判定係数（×100 の整数比）。
///
/// 緑背景の反射で前景の縁が緑に転ぶ現象（スピル）を抑える。G が R と B の平均を
/// この比率より上回る画素だけを対象にする。115 = 「平均より 15% 以上緑が強い」。
///
/// **公式根拠のある値ではない**。実測で調整する。
pub const SPILL_RATIO_PCT: u32 = 115;

/// クロマキー抜きの結果メトリクス。
///
/// 呼び出し側（`sticker_inspect` / 実測 E1・E3）がそのまま集計に使える生の数値だけを
/// 持つ。**判定（PASS/FAIL）はここでしない** — しきい値の解釈は層Aの検査側の責務。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChromaStats {
    /// 完全透過（アルファ 0）にした画素数。
    pub cleared: u64,
    /// 半透明（アルファ 1〜254）になった画素数。フリンジ検出の材料。
    pub semi_transparent: u64,
    /// 完全不透明（アルファ 255）のまま残った画素数＝前景。
    pub opaque: u64,
    /// スピル除去で色を書き換えた画素数。
    pub despilled: u64,
}

impl ChromaStats {
    /// 総画素数。
    pub fn total(&self) -> u64 {
        self.cleared + self.semi_transparent + self.opaque
    }

    /// 透過画素が1つでもあるか（層Aの `no-alpha` に対応する材料）。
    ///
    /// **これが false なら抜きが1画素も成立していない** ＝ 生成物が緑背景でなかった、
    /// という最も重要な失敗の signal。
    pub fn has_alpha(&self) -> bool {
        self.cleared > 0 || self.semi_transparent > 0
    }

    /// 輪郭に中間アルファ（1〜254）が**存在するか**。
    ///
    /// `fringe_ratio_pct` が「半透明が**多すぎ**ないか」を見るのに対し、こちらは
    /// 「半透明が**少なすぎ**ないか（＝縁が 0/255 に二値化されてギザギザか）」を見る。
    /// 過多と過少は別方向の失敗なので、1つの指標では両方を拾えない。
    ///
    /// **前景があるのにこれが false なら、縁が階段状**になっている。
    pub fn has_soft_edge(&self) -> bool {
        self.semi_transparent > 0
    }
}

/// 縁のアンチエイリアスが痩せすぎていないか（層Aの `edge-aliased` 警告の判定）。
///
/// `fringe_ratio_pct` と**同じ分母**（前景面積からの輪郭長近似）を使い、
/// 「半透明が輪郭1周のうち何%を覆っているか」を見る。正常な抜きなら輪郭には
/// 必ずアンチエイリアスの半透明が1周分できるので 100 前後になる。
///
/// 分母を揃えるのは、過多側（`FRINGE_WARN_PCT`）と過少側（`EDGE_SOFT_MIN_PCT`）が
/// **同じ軸の両端**として読めるようにするため。別々の尺度にすると
/// 「300 超で警告・20 未満で警告」の 20 と 300 が比較できなくなる。
pub fn soft_edge_ratio_pct(stats: &ChromaStats) -> u32 {
    // 定義上 fringe_ratio_pct と同じ量。名前を分けるのは呼び出し側の意図
    // （過多を見るのか過少を見るのか）をコードに残すため。
    fringe_ratio_pct(stats)
}

/// 縁のアンチエイリアスが成立しているとみなす下限（`soft_edge_ratio_pct` がこれ未満で警告）。
///
/// 25 = 「輪郭の 1/4 も半透明が無い」。正常な抜きは 100 前後（輪郭1周分）に
/// なるので、それを大きく下回った場合だけ拾う。
///
/// **警告に留める**（ブロックしない）理由は2つ:
/// 1. しきい値に**公式根拠が無い**（`MIN_INK_RATIO` と同じ断り）
/// 2. ドット絵・ピクセルアートは**意図的に二値**であり、正当な作風を止めてはいけない
///
/// **公式根拠のある値ではない**。実測で調整する。
pub const EDGE_SOFT_MIN_PCT: u32 = 25;

/// 基準色との色距離の二乗（R/G/B のみ。アルファは見ない）。
///
/// 平方根を取らないのは、しきい値側も二乗で持てば比較結果が同じで、
/// かつ浮動小数の丸めが入らないため（`normalize.rs` の `within_tolerance` が
/// 整数演算に固定しているのと同じ理由）。最大値は 3 × 255² = 195_075 で u32 に収まる。
fn color_distance_sq(px: &Rgba<u8>) -> u32 {
    let dr = (px[0] as i32 - KEY_COLOR[0] as i32).unsigned_abs();
    let dg = (px[1] as i32 - KEY_COLOR[1] as i32).unsigned_abs();
    let db = (px[2] as i32 - KEY_COLOR[2] as i32).unsigned_abs();
    dr * dr + dg * dg + db * db
}

/// 色距離からアルファ値を決める。
///
/// - `SOLID_THRESHOLD` 以下 → 0（背景。完全透過）
/// - `EDGE_THRESHOLD` 以上 → 255（前景。完全不透明）
/// - 中間 → 距離に比例した 1〜254（アンチエイリアス縁の遷移帯）
///
/// 中間帯で 0 や 255 に丸めないのは、遷移帯の存在自体が `fringe` 検出の材料に
/// なるため（潰すと「抜け残りが無かった」ように見えてしまう）。
fn alpha_for_distance(distance_sq: u32) -> u8 {
    if distance_sq <= SOLID_THRESHOLD {
        return 0;
    }
    if distance_sq >= EDGE_THRESHOLD {
        return 255;
    }
    let span = EDGE_THRESHOLD - SOLID_THRESHOLD;
    let offset = distance_sq - SOLID_THRESHOLD;
    // u64 で計算してから u8 へ落とす。u32 のままだと offset × 255 が溢れうる。
    let scaled = (offset as u64 * 255) / span as u64;
    // 遷移帯にいる時点で「完全な背景でも完全な前景でもない」ので 1..=254 に押し込む。
    scaled.clamp(1, 254) as u8
}

/// 緑スピル（前景の縁が背景の緑を拾って転ぶ現象）を抑える。
///
/// G が R と B の平均より `SPILL_RATIO_PCT`% 以上高い画素の G を、その平均まで
/// 引き下げる。**色相を作り変えるのではなく、過剰な緑成分だけを削る**方式。
/// 書き換えたら true を返す。
fn suppress_spill(px: &mut Rgba<u8>) -> bool {
    let r = px[0] as u32;
    let g = px[1] as u32;
    let b = px[2] as u32;
    let neutral = (r + b) / 2;
    // neutral × 比率 で比較する（除算を避けて丸め方向のブレを消す）。
    if g * 100 <= neutral * SPILL_RATIO_PCT {
        return false;
    }
    px[1] = neutral as u8;
    true
}

/// クロマキー抜きを実行し、画像を破壊的に書き換える。
///
/// 完全透過にした画素は RGB も基準色へ寄せず **そのまま残す**。理由は、透過画素の
/// RGB は見た目に影響しない一方、書き換えると「元が何色だったか」の情報が消え、
/// 抜き結果の検証（どこを背景と判定したかの追跡）ができなくなるため。
///
/// スピル除去は**残った前景と遷移帯にのみ**適用する（完全透過の画素は見えないので
/// 処理する意味がなく、無駄な走査になる）。
pub fn apply_chroma_key(image: &mut RgbaImage) -> ChromaStats {
    let mut stats = ChromaStats {
        cleared: 0,
        semi_transparent: 0,
        opaque: 0,
        despilled: 0,
    };

    for px in image.pixels_mut() {
        let alpha = alpha_for_distance(color_distance_sq(px));

        match alpha {
            0 => {
                stats.cleared += 1;
                px[3] = 0;
                continue;
            }
            255 => stats.opaque += 1,
            _ => stats.semi_transparent += 1,
        }

        if suppress_spill(px) {
            stats.despilled += 1;
        }
        // 元画像が既に半透明だった場合に不透明化しないよう、小さい方を採る。
        px[3] = px[3].min(alpha);
    }

    stats
}

/// 不透明画素（アルファ > 0）のバウンディングボックス `(x0, y0, x1, y1)`（両端含む）。
///
/// 1画素も不透明が無ければ `None`。層Aの `margin-short`（D5: 外枠との距離 ≥ 10px）と
/// `ink-too-small` がこれを材料にする。
///
/// **完全透過だけを背景とみなす**（アルファ 1 でも被写体の一部として数える）のは、
/// 抜け残りを余白判定で拾えるようにするため。ここで半透明を無視すると、
/// クロマキーが失敗して縁に背景が残っていても「余白は足りている」と誤判定する。
pub fn opaque_bounds(image: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let mut bounds: Option<(u32, u32, u32, u32)> = None;

    for (x, y, px) in image.enumerate_pixels() {
        if px[3] == 0 {
            continue;
        }
        bounds = Some(match bounds {
            None => (x, y, x, y),
            Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
        });
    }

    bounds
}

/// 半透明画素が前景の輪郭長に対して過多か（層Aの `fringe` 警告の判定）。
///
/// 分母を前景の面積でなく**輪郭長の近似**にするのは、正常な抜きでも輪郭には必ず
/// アンチエイリアスの半透明が1周分できるため。面積比で見ると小さい被写体ほど
/// 不利になり、正しい抜きを警告してしまう。
///
/// 輪郭長は `4 × sqrt(前景面積)`（正方形近似）で見積もる。**厳密な輪郭追跡はしない** —
/// 目的は「過多かどうか」の粗い判定であって、輪郭長そのものではないため。
///
/// `ratio_pct` は「半透明画素数 / 推定輪郭長 × 100」。100 なら輪郭1周分ちょうど。
pub fn fringe_ratio_pct(stats: &ChromaStats) -> u32 {
    let foreground = stats.opaque + stats.semi_transparent;
    if foreground == 0 {
        return 0;
    }
    let perimeter = 4 * (foreground as f64).sqrt().max(1.0) as u64;
    ((stats.semi_transparent * 100) / perimeter.max(1)) as u32
}

/// `fringe` 警告のしきい値（`fringe_ratio_pct` がこれを超えたら警告）。
///
/// 300 = 「輪郭3周分の半透明」。正常なアンチエイリアスは1〜2周分に収まるので、
/// それを明確に超えた場合だけ拾う。**警告に留める**（ブロックしない）理由は、
/// 意図的な半透明（グラデーション表現）が正当に存在するため。
///
/// **公式根拠のある値ではない**。実測（設計書 §4.5 E3）で調整する。
pub const FRINGE_WARN_PCT: u32 = 300;

#[cfg(test)]
mod tests {
    use super::*;

    /// 基準色をテスト側に**独立リテラル**で固定する。
    /// `KEY_COLOR` を参照すると、定数を別の色へ書き換えたときにテストが一緒に
    /// 追従して通ってしまい、回帰検知の牙が抜ける（`sheet_normalize.rs` の
    /// `EXPECTED_W/H` と同じ自己言及の罠対策）。
    const EXPECTED_KEY: [u8; 3] = [0, 255, 0];

    fn green() -> Rgba<u8> {
        Rgba([EXPECTED_KEY[0], EXPECTED_KEY[1], EXPECTED_KEY[2], 255])
    }

    /// 緑背景の中央に指定色の矩形を置いた画像を作る。
    fn image_with_subject(
        w: u32,
        h: u32,
        rect: (u32, u32, u32, u32),
        color: Rgba<u8>,
    ) -> RgbaImage {
        let mut img: RgbaImage = RgbaImage::from_pixel(w, h, green());
        let (x0, y0, x1, y1) = rect;
        for y in y0..=y1 {
            for x in x0..=x1 {
                img.put_pixel(x, y, color);
            }
        }
        img
    }

    #[test]
    fn key_color_is_pure_green() {
        assert_eq!(KEY_COLOR, EXPECTED_KEY);
    }

    /// T5: `#00FF00` 背景をクロマキー抜き → アルファが立ち D4/D5 を満たす。
    #[test]
    fn t5_removes_uniform_green_background() {
        let subject = Rgba([200, 40, 40, 255]);
        let mut img = image_with_subject(100, 100, (20, 20, 79, 79), subject);

        let stats = apply_chroma_key(&mut img);

        // D4: 透過画素が存在する。
        assert!(stats.has_alpha(), "透過が1画素も立っていない: {stats:?}");
        assert_eq!(stats.total(), 100 * 100);
        // 背景 = 全体 - 被写体(60×60)。
        assert_eq!(stats.cleared, 100 * 100 - 60 * 60);
        assert_eq!(stats.opaque, 60 * 60);
        // 均一な緑なので遷移帯は生じない。
        assert_eq!(stats.semi_transparent, 0);

        // 実画素でも確認する（統計だけ正しくて画像が変わっていない事故を防ぐ）。
        assert_eq!(img.get_pixel(0, 0)[3], 0, "背景が透過していない");
        assert_eq!(img.get_pixel(50, 50)[3], 255, "被写体が消えている");

        // D5: 余白 20px（≥ 10px）。
        let (x0, y0, x1, y1) = opaque_bounds(&img).expect("前景が無い");
        assert_eq!((x0, y0, x1, y1), (20, 20, 79, 79));
        assert!(x0 >= 10 && y0 >= 10, "余白不足");
        assert!(100 - 1 - x1 >= 10 && 100 - 1 - y1 >= 10, "余白不足");
    }

    /// K4: **純白のキャラが抜けない**（B案の存在理由そのもの）。
    ///
    /// 既存の背景除去は白キャラを白背景から分離できないが、クロマキーは
    /// 背景色を先に決めるので前景が純白でも成立する。
    #[test]
    fn white_subject_survives_chroma_key() {
        let white = Rgba([255, 255, 255, 255]);
        let mut img = image_with_subject(60, 60, (15, 15, 44, 44), white);

        let stats = apply_chroma_key(&mut img);

        assert_eq!(stats.opaque, 30 * 30, "白い前景が背景と一緒に抜けた");
        assert_eq!(stats.cleared, 60 * 60 - 30 * 30);
        // 白は #00FF00 から最大級に遠いので、遷移帯にも落ちない。
        assert_eq!(stats.semi_transparent, 0);

        assert_eq!(img.get_pixel(30, 30), &white, "白画素が書き換えられた");
        assert_eq!(img.get_pixel(0, 0)[3], 0, "背景が残った");

        let (x0, y0, x1, y1) = opaque_bounds(&img).expect("白い前景が消えた");
        assert_eq!((x0, y0, x1, y1), (15, 15, 44, 44));
    }

    /// T6（検査の牙の実証）: **緑が不均一な画像**は抜け残りが検出される。
    ///
    /// 背景の右半分を「緑だがしきい値から外れた色」にする。この帯は前景として
    /// 残るため、余白（D5）が潰れることで検出できる。
    #[test]
    fn t6_uneven_green_leaves_detectable_residue() {
        let subject = Rgba([200, 40, 40, 255]);
        let mut img = image_with_subject(100, 100, (40, 40, 59, 59), subject);
        // 右端 10px を「ズレた緑」で塗る（照明ムラ・グラデーションの模擬）。
        let off_green = Rgba([40, 190, 60, 255]);
        for y in 0..100 {
            for x in 90..100 {
                img.put_pixel(x, y, off_green);
            }
        }

        let stats = apply_chroma_key(&mut img);

        // ズレた緑（距離 9_425 = 遷移帯）は完全には抜けず、半透明で残る。
        // 完全不透明（opaque）で残るとは限らないので、**残存＝アルファが 0 でない**
        // で測る。ここを opaque だけで見ると、抜け残りの一部を見逃す。
        let residue = stats.semi_transparent;
        assert!(
            residue >= 100 * 10,
            "ズレた緑が完全に抜けてしまった（抜け残りを作れていない）: {stats:?}"
        );
        assert_eq!(stats.opaque, 20 * 20, "被写体が想定外に増減した: {stats:?}");

        // 抜け残りが右端まで伸びるため、D5（余白 ≥ 10px）が破れる。
        let (_, _, x1, _) = opaque_bounds(&img).expect("前景が無い");
        let right_margin = 100 - 1 - x1;
        assert!(
            right_margin < 10,
            "抜け残りがあるのに余白検査を通過した（牙が抜けている）: right_margin={right_margin}"
        );
    }

    /// アンチエイリアス縁は半透明の遷移帯になり、`fringe` の材料として数えられる。
    #[test]
    fn antialiased_edge_becomes_semi_transparent() {
        let mut img: RgbaImage = RgbaImage::from_pixel(20, 20, green());
        // 距離 11_025（SOLID=8_100 < d < EDGE=25_600）で遷移帯に落ちる色。
        // 「緑と前景の中間色」を目分量で選ぶと SOLID 側に沈むので、距離で選ぶ。
        img.put_pixel(10, 10, Rgba([0, 150, 0, 255]));

        let stats = apply_chroma_key(&mut img);

        assert_eq!(stats.semi_transparent, 1, "遷移帯が検出されない: {stats:?}");
        let alpha = img.get_pixel(10, 10)[3];
        assert!(
            alpha > 0 && alpha < 255,
            "遷移帯が 0/255 に丸められた: alpha={alpha}"
        );
    }

    /// 緑スピル（前景の縁が緑に転ぶ）が抑制される。
    #[test]
    fn spill_is_suppressed_on_foreground() {
        // 肌色に緑が乗った状態。G が (R+B)/2 を大きく超える。
        let spilled = Rgba([200, 220, 150, 255]);
        let mut img = image_with_subject(40, 40, (10, 10, 29, 29), spilled);

        let stats = apply_chroma_key(&mut img);

        assert_eq!(stats.despilled, 20 * 20, "スピル除去が働いていない");
        let px = img.get_pixel(20, 20);
        assert_eq!(px[1], 175, "G が中間値へ落ちていない: {px:?}");
        assert_eq!(px[0], 200, "R が書き換えられた");
        assert_eq!(px[2], 150, "B が書き換えられた");
    }

    /// スピル判定の対象外（緑が強くない前景）は色が変わらない。
    #[test]
    fn non_spilled_foreground_keeps_color() {
        let neutral = Rgba([180, 180, 180, 255]);
        let mut img = image_with_subject(40, 40, (10, 10, 29, 29), neutral);

        let stats = apply_chroma_key(&mut img);

        assert_eq!(stats.despilled, 0, "無関係な前景の色を書き換えた");
        assert_eq!(img.get_pixel(20, 20), &neutral);
    }

    /// 既に半透明だった画素を不透明化しない（アルファは小さい方を採る）。
    #[test]
    fn existing_alpha_is_not_increased() {
        let mut img: RgbaImage = RgbaImage::from_pixel(10, 10, green());
        img.put_pixel(5, 5, Rgba([200, 40, 40, 100]));

        apply_chroma_key(&mut img);

        assert_eq!(img.get_pixel(5, 5)[3], 100, "元の半透明が不透明化された");
    }

    /// 背景が1画素も緑でない場合、`has_alpha` が false になる。
    /// 層Aの `no-alpha` ブロッカーが拾うべき状態（＝生成物が緑背景でなかった）。
    #[test]
    fn fully_opaque_input_reports_no_alpha() {
        let mut img: RgbaImage = RgbaImage::from_pixel(30, 30, Rgba([30, 30, 30, 255]));

        let stats = apply_chroma_key(&mut img);

        assert!(!stats.has_alpha(), "緑が無いのに透過が立った: {stats:?}");
        assert_eq!(stats.opaque, 30 * 30);
        assert!(opaque_bounds(&img).is_some());
    }

    /// 全面が緑なら前景が消え、バウンディングボックスは None。
    #[test]
    fn all_green_leaves_no_bounds() {
        let mut img: RgbaImage = RgbaImage::from_pixel(16, 16, green());

        let stats = apply_chroma_key(&mut img);

        assert_eq!(stats.cleared, 16 * 16);
        assert_eq!(stats.opaque, 0);
        assert!(opaque_bounds(&img).is_none(), "前景ゼロなのに BBox が出た");
    }

    /// しきい値の境界が意図どおり（`SOLID` 以下は 0、`EDGE` 以上は 255）。
    #[test]
    fn alpha_thresholds_are_monotonic_at_boundaries() {
        assert_eq!(alpha_for_distance(0), 0);
        assert_eq!(alpha_for_distance(SOLID_THRESHOLD), 0);
        assert_eq!(alpha_for_distance(SOLID_THRESHOLD + 1), 1);
        assert_eq!(alpha_for_distance(EDGE_THRESHOLD - 1), 254);
        assert_eq!(alpha_for_distance(EDGE_THRESHOLD), 255);
        assert_eq!(alpha_for_distance(u32::MAX), 255);
    }

    /// 遷移帯のアルファが距離に対して単調増加する。
    #[test]
    fn alpha_increases_with_distance() {
        let mid = (SOLID_THRESHOLD + EDGE_THRESHOLD) / 2;
        let low = alpha_for_distance(SOLID_THRESHOLD + 1);
        let mid_alpha = alpha_for_distance(mid);
        let high = alpha_for_distance(EDGE_THRESHOLD - 1);
        assert!(
            low < mid_alpha && mid_alpha < high,
            "{low} {mid_alpha} {high}"
        );
    }

    /// 純白は基準色から最大距離で、必ず完全不透明になる。
    #[test]
    fn white_is_far_from_key_color() {
        let white = Rgba([255, 255, 255, 255]);
        let d = color_distance_sq(&white);
        assert!(d > EDGE_THRESHOLD, "白が遷移帯に落ちる: d={d}");
        assert_eq!(alpha_for_distance(d), 255);
    }

    /// `fringe_ratio_pct`: 正常な抜き（輪郭1周分程度）は警告しきい値を超えない。
    #[test]
    fn fringe_ratio_stays_low_for_clean_cutout() {
        // 100×100 の前景に対し、輪郭1周分（≈400px）の半透明。
        let stats = ChromaStats {
            cleared: 5_000,
            semi_transparent: 400,
            opaque: 10_000,
            despilled: 0,
        };
        let pct = fringe_ratio_pct(&stats);
        assert!(pct <= FRINGE_WARN_PCT, "正常な抜きを警告した: {pct}");
    }

    /// `fringe_ratio_pct`: 抜け残りが多いと警告しきい値を超える。
    #[test]
    fn fringe_ratio_flags_heavy_residue() {
        let stats = ChromaStats {
            cleared: 1_000,
            semi_transparent: 8_000,
            opaque: 10_000,
            despilled: 0,
        };
        let pct = fringe_ratio_pct(&stats);
        assert!(pct > FRINGE_WARN_PCT, "抜け残りを見逃した: {pct}");
    }

    /// 前景ゼロで `fringe_ratio_pct` がゼロ除算しない。
    #[test]
    fn fringe_ratio_handles_empty_foreground() {
        let stats = ChromaStats {
            cleared: 100,
            semi_transparent: 0,
            opaque: 0,
            despilled: 0,
        };
        assert_eq!(fringe_ratio_pct(&stats), 0);
    }

    // ── S9-2: 縁のアンチエイリアス品質（過少側） ──

    /// 実際にクロマキーを通したアンチエイリアス縁は、中間アルファ（0/255 でない）を持つ。
    ///
    /// **これが本項目の核心**: 縁が二値化されているとギザギザに見える。
    /// 合成画像に滑らかな縁を作り、抜いた後も中間値が残ることを画素で確認する。
    #[test]
    fn s9_antialiased_edge_keeps_intermediate_alpha() {
        let subject = Rgba([255, 255, 255, 255]);
        let mut img = image_with_subject(60, 60, (20, 20, 39, 39), subject);

        // 被写体の外周1周を「緑と白の中間色」で塗り、アンチエイリアス縁を再現する。
        // 目分量の中間色は SOLID 側に沈むので、遷移帯に落ちる距離の色を明示的に使う
        // （既存の antialiased_edge_becomes_semi_transparent と同じ選び方）。
        let edge = Rgba([0, 150, 0, 255]);
        for x in 19..=40 {
            img.put_pixel(x, 19, edge);
            img.put_pixel(x, 40, edge);
        }
        for y in 19..=40 {
            img.put_pixel(19, y, edge);
            img.put_pixel(40, y, edge);
        }

        let stats = apply_chroma_key(&mut img);

        assert!(
            stats.has_soft_edge(),
            "中間アルファが1画素も無い: {stats:?}"
        );

        // 画素の実体でも確認する（統計だけだと「数えたが 0/255 だった」を見逃す）。
        let mut intermediate = 0;
        for px in img.pixels() {
            if px[3] > 0 && px[3] < 255 {
                intermediate += 1;
            }
        }
        assert!(
            intermediate > 0,
            "アルファが 0/255 に二値化され、縁が階段状になっている"
        );
    }

    /// 縁が完全に二値（アンチエイリアスなし）なら `has_soft_edge` が false になる。
    ///
    /// ドット絵のような**意図的な二値**もここに落ちる。だから警告に留める。
    #[test]
    fn s9_hard_edge_reports_no_soft_edge() {
        let subject = Rgba([255, 255, 255, 255]);
        // 遷移帯を作らない＝緑と白が隣接するだけの硬い縁。
        let mut img = image_with_subject(60, 60, (20, 20, 39, 39), subject);

        let stats = apply_chroma_key(&mut img);

        assert!(stats.has_alpha(), "抜き自体が成立していない: {stats:?}");
        assert!(
            !stats.has_soft_edge(),
            "二値の縁なのに中間アルファが立った: {stats:?}"
        );
        assert_eq!(soft_edge_ratio_pct(&stats), 0);
    }

    /// `soft_edge_ratio_pct`: 正常な抜き（輪郭1周分）は下限を下回らない。
    #[test]
    fn s9_soft_edge_ratio_passes_for_clean_antialiasing() {
        // 100×100 の前景に対し輪郭1周分（≈400px）の半透明 ＝ ちょうど 100%。
        let stats = ChromaStats {
            cleared: 5_000,
            semi_transparent: 400,
            opaque: 10_000,
            despilled: 0,
        };
        let pct = soft_edge_ratio_pct(&stats);
        assert!(
            pct >= EDGE_SOFT_MIN_PCT,
            "正常なアンチエイリアスを「ギザギザ」と判定した: {pct}"
        );
    }

    /// `soft_edge_ratio_pct`: 半透明が痩せすぎていれば下限を割る。
    #[test]
    fn s9_soft_edge_ratio_flags_thin_edge() {
        // 前景 10_000（輪郭近似 400）に対し半透明が 20 しかない ＝ 5%。
        let stats = ChromaStats {
            cleared: 5_000,
            semi_transparent: 20,
            opaque: 10_000,
            despilled: 0,
        };
        let pct = soft_edge_ratio_pct(&stats);
        assert!(pct < EDGE_SOFT_MIN_PCT, "二値化された縁を見逃した: {pct}");
    }

    /// 過多側と過少側は**同じ軸の両端**として矛盾しない（同時に両方は成立しない）。
    #[test]
    fn s9_fringe_and_soft_edge_are_two_ends_of_one_axis() {
        assert!(
            EDGE_SOFT_MIN_PCT < FRINGE_WARN_PCT,
            "下限が上限を追い越しており、必ずどちらかが常に発火する"
        );
    }
}

/// S2 実測ハーネス（設計書 §4.5 E1/E2/E3 に対応する**合成画像での**測定）。
///
/// **これは実機実測ではない。** 設計書 §4.5 の E1 は「`SheetBackground::Green` で
/// **実際に16枚生成**し、抜けた枚数を記録する」であり、それは STΛCK の生成枠を
/// 消費するため実行していない。
///
/// ここで測るのは「AIが返しうる背景の劣化パターン（均一 / 微ノイズ / 照明ムラ /
/// グラデーション / アンチエイリアス縁 / 白キャラ）に対し、実装がどう振る舞うか」だけ。
///
/// **本ハーネスが答えられない問い**（実機でしか埋まらない）:
/// - AIが本当に `#00FF00` の均一な緑を返すか（プロンプト指定は保証ではない）
/// - 実16枚中の D4/D5 通過枚数（= E1 の本体）→ よって **E2（§9 J4 の撤回判断）も未取得**
/// - 予防句あり／なしの `fringe` 差（= E3 の本体）
///
/// 常時実行しない（`#[ignore]`）のは、これが回帰テストでなく**測定**だから。
/// 実行: `cargo test --lib images::chroma::measure -- --ignored --nocapture`
#[cfg(test)]
mod measure {
    use super::*;

    const W: u32 = 370;
    const H: u32 = 320;
    /// D5 が要求する余白（設計書 §4.1 D5）。独立リテラルで持つ。
    const REQUIRED_MARGIN: u32 = 10;
    /// 被写体の矩形（余白 40px を確保した位置）。
    const SUBJECT: (u32, u32, u32, u32) = (40, 40, W - 41, H - 41);

    /// 決定論の擬似乱数（実行ごとに結果が変わらないよう固定シードの LCG）。
    fn lcg(seed: &mut u32) -> u32 {
        *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *seed >> 16
    }

    fn build(subject: Rgba<u8>, bg: impl Fn(u32, u32) -> Rgba<u8>) -> RgbaImage {
        let (x0, y0, x1, y1) = SUBJECT;
        let mut img = RgbaImage::new(W, H);
        for y in 0..H {
            for x in 0..W {
                let inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
                img.put_pixel(x, y, if inside { subject } else { bg(x, y) });
            }
        }
        img
    }

    /// 被写体の外周に厚み `thickness` のアンチエイリアス縁を足す。
    fn add_soft_edge(img: &mut RgbaImage, subject: Rgba<u8>, thickness: u32) {
        let (x0, y0, x1, y1) = SUBJECT;
        for ring in 1..=thickness {
            let t = ring as f32 / (thickness as f32 + 1.0);
            let mix = |a: u8, b: u8| (a as f32 * t + b as f32 * (1.0 - t)) as u8;
            let c = Rgba([
                mix(0, subject[0]),
                mix(255, subject[1]),
                mix(0, subject[2]),
                255,
            ]);
            for x in (x0 - ring)..=(x1 + ring) {
                img.put_pixel(x, y0 - ring, c);
                img.put_pixel(x, y1 + ring, c);
            }
            for y in (y0 - ring)..=(y1 + ring) {
                img.put_pixel(x0 - ring, y, c);
                img.put_pixel(x1 + ring, y, c);
            }
        }
    }

    /// D4 / D5 / 余白 / fringe を測る。
    fn evaluate(img: &mut RgbaImage) -> (ChromaStats, bool, bool, u32, u32) {
        let stats = apply_chroma_key(img);
        let (d5, margin) = match opaque_bounds(img) {
            None => (false, 0),
            Some((x0, y0, x1, y1)) => {
                let m = x0.min(y0).min(W - 1 - x1).min(H - 1 - y1);
                (m >= REQUIRED_MARGIN, m)
            }
        };
        (
            stats,
            stats.has_alpha(),
            d5,
            margin,
            fringe_ratio_pct(&stats),
        )
    }

    #[test]
    #[ignore = "測定であって回帰テストではない。--ignored で明示実行する"]
    fn e1_synthetic_background_degradation() {
        let skin = Rgba([232, 190, 172, 255]);
        let white = Rgba([255, 255, 255, 255]);
        let pure = |_x: u32, _y: u32| Rgba([0, 255, 0, 255]);

        // 微ノイズ（JPEG 圧縮相当の ±6）。
        let mut seed = 42u32;
        let mut noise = build(skin, pure);
        let (sx, sy, ex, ey) = SUBJECT;
        for y in 0..H {
            for x in 0..W {
                if x >= sx && x <= ex && y >= sy && y <= ey {
                    continue;
                }
                let n = (lcg(&mut seed) % 13) as i32 - 6;
                let g = (255 + n).clamp(0, 255) as u8;
                let rb = n.clamp(0, 255) as u8;
                noise.put_pixel(x, y, Rgba([rb, g, rb, 255]));
            }
        }

        let mut aa = build(skin, pure);
        add_soft_edge(&mut aa, skin, 3);

        let cases: Vec<(&str, &str, RgbaImage)> = vec![
            (
                "均一グリーン（理想）",
                "#00FF00 完全均一",
                build(skin, pure),
            ),
            ("白キャラ", "#00FF00 均一 / 前景 純白", build(white, pure)),
            ("微ノイズ", "±6 の圧縮ノイズ", noise),
            (
                "照明ムラ（弱）",
                "G 255→200 の勾配",
                build(skin, |x, _| Rgba([0, 255 - (x * 55 / W) as u8, 0, 255])),
            ),
            (
                "グラデーション（強）",
                "G 255→150 の勾配",
                build(skin, |x, _| Rgba([0, 255 - (x * 105 / W) as u8, 0, 255])),
            ),
            ("アンチエイリアス縁3px", "#00FF00 均一 / 縁3px", aa),
        ];

        println!("\n=== E1 代用: 合成背景に対するクロマキー挙動（実生成なし） ===");
        println!("キャンバス {W}×{H} / 被写体余白 40px / D5 要求 {REQUIRED_MARGIN}px\n");
        println!(
            "{:<22} {:<24} {:>4} {:>4} {:>6} {:>8} {:>6}",
            "ケース", "背景", "D4", "D5", "余白", "fringe%", "警告"
        );
        println!("{}", "-".repeat(84));

        let (mut d4_ok, mut d5_ok, mut warned) = (0, 0, 0);
        let total = cases.len();
        for (name, bg, mut img) in cases {
            let (stats, d4, d5, margin, fringe) = evaluate(&mut img);
            let warn = fringe > FRINGE_WARN_PCT;
            d4_ok += d4 as usize;
            d5_ok += d5 as usize;
            warned += warn as usize;
            println!(
                "{:<22} {:<24} {:>4} {:>4} {:>6} {:>8} {:>6}",
                name,
                bg,
                if d4 { "OK" } else { "NG" },
                if d5 { "OK" } else { "NG" },
                margin,
                fringe,
                if warn { "警告" } else { "-" }
            );
            println!(
                "{:>22}   cleared={} semi={} opaque={} despilled={}",
                "", stats.cleared, stats.semi_transparent, stats.opaque, stats.despilled
            );
        }

        println!("{}", "-".repeat(84));
        println!("D4 {d4_ok}/{total} / D5 {d5_ok}/{total} / fringe警告 {warned}/{total}");
        println!(
            "\n【未検証】これは合成画像の測定。設計書 §4.5 E1（実16枚生成して\n\
             抜けた枚数を記録）は**実機未検証**。AIが均一な緑を返すかは\n\
             ここでは判定できない。したがって E2（§9 J4 の撤回判断）の\n\
             材料も未取得であり、クロマキー既定の可否は結論を出せない。\n"
        );

        assert!(
            d4_ok >= 2,
            "理想条件でも透過が立っていない＝実装が壊れている"
        );
    }

    #[test]
    #[ignore = "測定であって回帰テストではない。--ignored で明示実行する"]
    fn e3_fringe_sensitivity_to_edge_thickness() {
        let skin = Rgba([232, 190, 172, 255]);
        println!("\n=== E3 代用: 縁の厚みと fringe 指標の感度（実生成なし） ===");
        println!(
            "{:<12} {:>8} {:>10} {:>6}",
            "縁の厚み", "semi", "fringe%", "警告"
        );
        println!("{}", "-".repeat(40));

        for thickness in [0u32, 1, 2, 3, 5, 8] {
            let mut img = build(skin, |_, _| Rgba([0, 255, 0, 255]));
            add_soft_edge(&mut img, skin, thickness);
            let stats = apply_chroma_key(&mut img);
            let fringe = fringe_ratio_pct(&stats);
            println!(
                "{:<12} {:>8} {:>10} {:>6}",
                format!("{thickness}px"),
                stats.semi_transparent,
                fringe,
                if fringe > FRINGE_WARN_PCT {
                    "警告"
                } else {
                    "-"
                }
            );
        }

        println!(
            "\n【未検証】予防句（hard-edge cutout, no anti-aliased halo）の効果は\n\
             予防句あり／なしで**実生成物を比較**しないと測れない。E3 は実機未検証。\n\
             ここで示したのは指標側の感度のみ。\n"
        );
    }
}
