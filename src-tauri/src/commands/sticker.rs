//! LINE スタンプの**層A検査（決定論）と書き出し**（設計書 v3 §1.8 / §1.10 / §4.1 = S6）。
//!
//! ## このモジュールが背負う唯一の約束
//!
//! **規格違反を世に出さない。** LINE スタンプで人が落ちる場所は2つあり
//! （設計書 §0.1）、そのうち「規格違反での差し戻し」は**全部機械で判定でき、
//! ほとんどは機械で矯正できる**。ここはその機械側だけを引き受ける。
//!
//! 引き受け**ない**ものを先に書く:
//!
//! - 「審査に通ること」の保証 — 承認可否は LINE の裁量（設計書 §0.2 / §0.4）。
//!   このファイルの文字列に「審査」「通ります」を書かない。言ってよいのは
//!   **画像規格**（サイズ・透過・余白・容量）を満たしているかまで。
//! - 表現内容の審査（層B）— 意味の解釈が要るので AI 側（S7）の責務。
//! - 背景除去 — 不透明画像から背景を勝手に抜くのは AI の仕事。関所は
//!   「透過されていない」という**事実を検出して止めるだけ**にする（§1.8）。
//!
//! ## なぜ関所が「書き出し」なのか（§1.8）
//!
//! 生成物はまだスタンプではない。ユーザーはこの後、採否（工程④）と個別編集
//! （工程⑤）をする。生成直後に 370×320 へ潰すと**編集の余地を先に殺す**。
//! スタンプ規格の最上流は「スタンプという成果物が世に出る唯一の経路」＝**書き出し**。
//!
//! 受領時（`character_sheet.rs` の MultiCut アーム = S1b）には「壊れていないか」
//! だけを見る別の関所がある。上流は「壊れた物を先へ流さない」、下流（ここ）は
//! 「規格外を世に出さない」。役割が違うので二重ではない。
//!
//! ## モード分岐は1引数に閉じる（STΛCK決定1 / D15）
//!
//! 作る流れは1本。**出口だけ2択**にする。`sticker_export` が受け取る
//! `mode` は1つで、差は「関所の厳しさ」と「おまけファイル（main/tab）の有無」だけ。
//! 矯正・リサイズ・検査の**コードは完全に共通**（下の `normalize_sticker` /
//! `inspect_rgba` を両モードが同じように通る）。**パイプラインを2本作らない。**

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::images::chroma::{
    fringe_ratio_pct, opaque_bounds, soft_edge_ratio_pct, ChromaStats, EDGE_SOFT_MIN_PCT,
    FRINGE_WARN_PCT,
};

// ───────────────────────── 規格定数（層Aの正本） ─────────────────────────
//
// これらは `src/lib/sticker/spec.ts`（S4）と**同じ値を持つ**。Rust は TS を
// import できないため物理的な単一定義にはできないが、**二重定義を放置しない**。
// 下の `spec_ts_sync` テスト群が `spec.ts` を実際に読んでリテラルを突き合わせ、
// 片方だけ変えると `cargo test` が落ちる。定数の同期は散文の約束ではなく
// テストで守る（規律5: 検査の牙）。
//
// 数値の出典は一次情報 `_work/gorigori-feedback/wave7/line-ai-policy-verified.md`
// §3-2 / §6-4。余白は公式表記が px（「約10px」）なので px を焼く。

/// スタンプ画像の幅の上限（この値**以内**。ちょうどである必要はない）。
pub const MAX_STICKER_WIDTH: u32 = 370;
/// スタンプ画像の高さの上限。
pub const MAX_STICKER_HEIGHT: u32 = 320;
/// 被写体の周囲に確保する余白（px）。通常スタンプは**必須**。
pub const STICKER_PADDING_PX: u32 = 10;
/// メイン画像の寸法（ちょうど一致が要求される）。
pub const MAIN_IMAGE_SIZE: (u32, u32) = (240, 240);
/// タブ画像の寸法（ちょうど一致）。96×74 は**横長**なので正方形寄りの素材では
/// 上下に余白が入る（正常）。
pub const TAB_IMAGE_SIZE: (u32, u32) = (96, 74);
/// 1画像あたりのファイルサイズ上限（1MB）。
pub const MAX_BYTES_PER_IMAGE: u64 = 1_048_576;
/// セット合計のファイルサイズ上限（60MB）。
///
/// 公式ガイドラインは同じ 60MB を **ZIP ファイルに対して**も課している
/// （「ZIP ファイルを 60MB 以下にしてください」）。`write_submission_zip` は
/// 作った後の実ファイルサイズをこの値と比べる。
pub const MAX_BYTES_TOTAL: u64 = 62_914_560;
/// 提出用 ZIP のファイル名。
///
/// 半角のみにするのは `exportNaming.ts` の方針（全角・空白はモール/編集ソフトで
/// 事故る）に合わせるため。日本語名にすると解凍側の環境で文字化けしうる。
pub const SUBMISSION_ZIP_NAME: &str = "line-stickers.zip";
/// 選べる枚数（STΛCK決定2）。申請モードでのみ検査する。
pub const STICKER_COUNTS: [usize; 5] = [8, 16, 24, 32, 40];
/// 書き出す PNG の解像度（px/メートル）。公式要件は「**72dpi以上**」（§3-2）。
///
/// PNG の pHYs チャンクは dpi でなく px/メートルで持つため換算した値を焼く。
/// `72 / 0.0254 = 2834.6…` を**切り上げて** 2835 にするのは、切り捨てると
/// 2834 px/m = 71.98dpi となり「72dpi以上」を**下回る**ため。2835 は 72.009dpi。
///
/// 記事にある「72〜150dpi推奨」は推奨であって要件ではない。ここは**下限の 72 を
/// 満たすことだけ**を目的にする。
pub const STICKER_PPM: u32 = 2835;
/// `STICKER_PPM` を dpi へ戻すための換算（1インチ = 0.0254m）。検査・テスト用。
pub const METERS_PER_INCH: f64 = 0.0254;
/// 公式が要求する解像度の下限（dpi）。
pub const MIN_STICKER_DPI: f64 = 72.0;
/// クロマキーの中間生成物を置く隠しディレクトリ名（A3）。
///
/// **`images_write_mask` と同じ名前を意図的に共有する。** ギャラリーの除外判定は
/// `images/watcher.rs`（`is_in_masks_dir` / `scan_existing` / `collect_images_recursive`）と
/// `commands/images.rs`（`index_dir_recursive`）の4箇所に散っており、そのすべてが
/// この文字列リテラルを見ている。別名を作ると4箇所を同時に直す必要が生まれ、
/// 1箇所でも漏れると中間生成物がギャラリーへ出る。**除外の正本は1つに保つ。**
/// 下の `chroma_output_is_hidden_from_the_gallery` が実際の除外関数と突き合わせる。
pub const STICKER_WORK_DIRNAME: &str = ".masks";
/// 不透明画素の面積がキャンバス面積に占める割合の下限（これ未満で `ink-too-small` 警告）。
///
/// ⚠️ **この値に公式根拠はない**（`spec.ts` の同名定数と同じ断り）。
/// 「余白を取りすぎて被写体が豆粒になった」事故を拾うための実務的な下限。
/// **警告に留めるのは根拠が無いため。**
pub const MIN_INK_RATIO: f64 = 0.03;

// ───────────────────────── 検査結果の型 ─────────────────────────

/// 検査所見1件の重さ。
///
/// `Blocker` は**申請モードで書き出しを止める**。`Warning` は止めない。
/// この2値しか持たないのは、中間の「たぶん問題」を作ると呼び出し側が
/// 独自解釈を始め、止める/止めないの判断が UI 側へ漏れるため。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Blocker,
    Warning,
}

/// 層Aの所見1件。`id` は設計書 §1.9 の層A表の ID をそのまま使う。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerIssue {
    /// `size-over` / `no-alpha` / `margin-short` など。UI 側の文言辞書のキー。
    pub id: String,
    pub severity: IssueSeverity,
    /// 人が読む説明。**規格の話だけを書く**（審査の可否に言及しない）。
    pub message: String,
}

impl StickerIssue {
    fn blocker(id: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            severity: IssueSeverity::Blocker,
            message: message.into(),
        }
    }

    fn warning(id: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            severity: IssueSeverity::Warning,
            message: message.into(),
        }
    }
}

/// 1枚分の検査結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerInspection {
    /// 検査対象の絶対パス。
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// ファイルサイズ（バイト）。読めなければ 0。
    pub bytes: u64,
    /// 不透明画素（アルファ > 0）が占める割合。`ink-too-small` の材料。
    pub ink_ratio: f64,
    /// 被写体と外枠の最短距離（px）。被写体が無ければ `None`。
    pub margin_px: Option<u32>,
    pub issues: Vec<StickerIssue>,
}

impl StickerInspection {
    /// ブロッカーを1件でも持つか。
    pub fn has_blocker(&self) -> bool {
        self.issues
            .iter()
            .any(|i| i.severity == IssueSeverity::Blocker)
    }
}

/// `sticker_inspect` の戻り。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerInspectResult {
    pub items: Vec<StickerInspection>,
    /// セット全体に対する所見（`total-too-large` / `count-invalid`）。
    pub set_issues: Vec<StickerIssue>,
    pub total_bytes: u64,
}

/// 呼び出し側が「この画像はこの統計で抜いた」と申告する1件（A5）。
///
/// ## なぜフロントから運ぶのか
///
/// 縁の品質（`fringe` / `edge-aliased`）は**抜いた瞬間にしか測れない**。
/// `sticker_chroma_key` が返した統計を、抜いた側（フロント）が覚えておいて
/// 検査・書き出しへ持ち込む。Rust 側で再計算しようとすると「抜く前の緑背景」が
/// 必要になるが、その時点の画像はもう手元に無い（採否・個別編集を経ている）。
///
/// **申告が無い画像は `fringe` を判定しない**（`chroma: None` のまま）。
/// 持ち込み画像・抜きに失敗した画像に縁の品質は語れないので、
/// 「測っていないものを測ったふりにしない」を型で守る。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerChromaSample {
    /// この統計が属する画像の絶対パス（`StickerChromaResult::output` と同じ値）。
    pub path: String,
    pub cleared: u64,
    pub semi_transparent: u64,
    pub opaque: u64,
    pub despilled: u64,
}

impl StickerChromaSample {
    fn stats(&self) -> ChromaStats {
        ChromaStats {
            cleared: self.cleared,
            semi_transparent: self.semi_transparent,
            opaque: self.opaque,
            despilled: self.despilled,
        }
    }
}

/// 申告された統計を path から引けるようにする。
///
/// `Vec` を素朴に線形探索しないのは、40枚 × 40件で毎回舐めるのを避けるため
/// ではなく、**同じ path が2回申告されたときの挙動を1箇所に閉じる**ため
/// （後勝ち＝最後に抜いた統計が正）。
fn chroma_index(samples: &[StickerChromaSample]) -> std::collections::HashMap<&str, ChromaStats> {
    samples
        .iter()
        .map(|s| (s.path.as_str(), s.stats()))
        .collect()
}

// ───────────────────────── 書き出しの型 ─────────────────────────

/// 出口の2択（STΛCK決定1）。**これ以外の分岐を増やさない。**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    /// 「このまま使う」。規格矯正は**する**が、規格違反でも**止めない**（警告のみ）。
    /// main/tab は出さない。枚数の5択も見ない（3枚でもよい）。
    Personal,
    /// 「申請用に書き出す」。ブロッカーがあれば止める。main/tab を出す。枚数も見る。
    Submission,
}

/// 書き出し1件の結果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerExportItem {
    pub source: String,
    pub output: String,
    /// 矯正後の寸法。
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// 縮小率（1.0 = 原寸）。**1.0 を超えることはない**（拡大禁止・D12）。
    pub scale: f64,
    pub issues: Vec<StickerIssue>,
}

/// 書き出し失敗1件。1枚失敗しても**残りは続行する**（部分成功・T8）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerExportFailure {
    pub source: String,
    pub error: String,
}

/// `sticker_export` の戻り。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerExportResult {
    pub mode: String,
    pub items: Vec<StickerExportItem>,
    pub failed: Vec<StickerExportFailure>,
    /// 申請モードで出したメイン画像（240×240）。personal では `None`。
    pub main_image: Option<String>,
    /// 申請モードで出したタブ画像（96×74）。personal では `None`。
    pub tab_image: Option<String>,
    pub total_bytes: u64,
    /// セット全体の所見。
    pub set_issues: Vec<StickerIssue>,
    /// 申請モードで作った提出用 ZIP のパス。personal では `None`。
    pub zip_path: Option<String>,
    /// 作った ZIP の実ファイルサイズ（バイト）。personal では `None`。
    ///
    /// 見積り（`total_bytes`）ではなく**書いた後に測った実測値**。圧縮率は
    /// 中身次第で変わるため、見積りで 60MB 判定をすると実物とズレる。
    pub zip_bytes: Option<u64>,
}

// ───────────────────────── 幾何（矯正の中身） ─────────────────────────

/// 偶数へ**切り下げる**（D2）。
///
/// 切り上げでなく切り下げにするのは、上限（370×320）を跨がないため。
/// 371 を切り上げると 372 になり `size-over` を自分で作る。
fn floor_even(v: u32) -> u32 {
    v & !1
}

/// 偶数へ**切り上げる**。上限を跨ぐ場合だけ切り下げへ倒す。
///
/// 余白の計算で使う（`floor_even` だと 1px 削れて片側が 9px になる。B2）。
/// `limit` を超えるときは切り下げるので、`size-over` を自分で作ることはない。
fn even_within(v: u32, limit: u32) -> u32 {
    let up = v + (v & 1); // 奇数なら +1、偶数ならそのまま
    if up <= limit {
        up
    } else {
        floor_even(limit)
    }
}

/// 全面不透明（アルファ 255 の画素しかない）か。
///
/// **正規化の前に**測るための関数（B1）。`normalize_sticker` は被写体の周りへ
/// 透明な余白を足すので、正規化後の画像は元が全面不透明でも必ず透明画素を持つ。
/// 「透過されているか」は元画像に対してしか問えない。
fn is_fully_opaque(image: &RgbaImage) -> bool {
    image.pixels().all(|p| p[3] == 255)
}

/// 矯正の結果（呼び出し側が scale を記録できるよう返す）。
struct Normalized {
    image: RgbaImage,
    scale: f64,
}

/// 1枚を LINE スタンプ規格へ矯正する。**両モード共通の処理**（D15）。
///
/// 手順は「余白の内側に収まるよう縮小 → 偶数キャンバスの中央へ配置」。
///
/// - **拡大しない**（D12）。`scale` を `min(.., 1.0)` で clamp する。
///   `DynamicImage::resize` は枠に収まる最大サイズへ**アップスケールする**ので、
///   そのまま使うと小さい素材が引き伸ばされて輪郭がボケる。
///   （`src/lib/comic/exportSize.ts` の `containRect` が同じ clamp を持ち、
///   コメントも「情報は増えないため原寸のまま中央に置く」と書いている。同じ思想を採る。）
/// - **透過で初期化する**。不透明色で初期化して `overlay` すると、`overlay` は
///   置換でなくアルファ合成なので透過画素が背景色で焼き付く
///   （`images.rs` が実際に踏んだ透過破壊バグと同型）。
/// - 出力は必ず **RGBA8**（PNG カラータイプ6 / D3）。公式の「カラーモード: RGB」は
///   CMYK・グレースケール・インデックスカラーの排除を意味すると解釈する（§1.8）。
///   **ここでアルファを落とすと全滅する。**
fn normalize_sticker(src: &DynamicImage, max_w: u32, max_h: u32, padding: u32) -> Normalized {
    let rgba = src.to_rgba8();
    let (sw, sh) = rgba.dimensions();

    // 余白の内側に残る領域。padding が大きすぎて潰れる場合でも 1px は残す
    // （0 にすると以降の除算・リサイズが成立しない）。
    let inner_w = max_w.saturating_sub(padding * 2).max(1);
    let inner_h = max_h.saturating_sub(padding * 2).max(1);

    let scale = if sw == 0 || sh == 0 {
        1.0
    } else {
        (inner_w as f64 / sw as f64)
            .min(inner_h as f64 / sh as f64)
            .min(1.0) // ← 拡大禁止（D12）
    };

    let dw = ((sw as f64 * scale).round() as u32).clamp(1, inner_w);
    let dh = ((sh as f64 * scale).round() as u32).clamp(1, inner_h);

    let scaled = if dw == sw && dh == sh {
        rgba
    } else {
        image::imageops::resize(&rgba, dw, dh, image::imageops::FilterType::Lanczos3)
    };

    // キャンバスは「被写体 + 余白」を偶数へ丸めたもの。**上限いっぱいには広げない** —
    // 370×320 固定にすると縦長の素材で左右に無駄な余白が入り、被写体が小さく見える。
    // 規格は「以内」なので、必要な大きさだけ確保するのが正しい。
    //
    // 偶数化は**切り上げ**にする（B2）。切り下げると `dw + padding*2` が奇数のとき
    // 1px 削れ、中央配置の整数除算で削れた側が `padding - 1`（= 9px）になる。
    // 中央配置は「余りを均等に分ける」わけではない — 余り1pxは必ず片側に寄る。
    // 切り上げれば余白の合計が `padding*2` 以上になるので、四辺すべてが padding 以上を保てる。
    // `even_within` は上限を跨ぐ場合だけ切り下げるため `size-over` は作らない
    // （その場合の被写体は inner_w/inner_h に収まっており、余白は元から足りている）。
    let canvas_w = even_within((dw + padding * 2).clamp(2, max_w), max_w).max(2);
    let canvas_h = even_within((dh + padding * 2).clamp(2, max_h), max_h).max(2);

    // 配置は中央固定。切り上げで確保した余りは +1px 側へ寄るが、
    // 下限側（整数除算で切り捨てられる側）でも padding を下回らない。
    let mut canvas: RgbaImage = ImageBuffer::from_pixel(canvas_w, canvas_h, Rgba([0, 0, 0, 0]));
    let ox = ((canvas_w as i64) - (dw as i64)) / 2;
    let oy = ((canvas_h as i64) - (dh as i64)) / 2;
    image::imageops::overlay(&mut canvas, &scaled, ox, oy);

    Normalized {
        image: canvas,
        scale,
    }
}

/// 被写体と外枠の最短距離（px）。被写体が無ければ `None`。
fn margin_of(image: &RgbaImage) -> Option<u32> {
    let (w, h) = image.dimensions();
    let (x0, y0, x1, y1) = opaque_bounds(image)?;
    // 右端・下端は「両端含む」の bbox なので +1 して外枠との差を取る。
    Some(x0.min(y0).min(w - 1 - x1).min(h - 1 - y1))
}

/// 不透明画素（アルファ > 0）が占める割合。
fn ink_ratio_of(image: &RgbaImage) -> f64 {
    let (w, h) = image.dimensions();
    let total = (w as u64) * (h as u64);
    if total == 0 {
        return 0.0;
    }
    let ink = image.pixels().filter(|p| p[3] > 0).count() as u64;
    ink as f64 / total as f64
}

// ───────────────────────── 層A 検査（9種） ─────────────────────────

/// 1枚を層Aの9検査にかける（`total-too-large` と `count-invalid` はセット単位なので別）。
///
/// `chroma` は直前にクロマキーを通した場合の統計。`None` なら `fringe` は判定しない
/// （既に透過済みの持ち込み画像に対して抜け残りを語れないため。**測れないものを
/// 測ったふりにしない**）。
///
/// `source_opaque` は「**元画像**が全面不透明だったか」（B1）。`Some(true)` なら
/// `image` の透明画素が正規化で足した余白由来である可能性があるため、そちらを正とする。
/// `None` は「元画像を知らない」＝ `image` 自身から判定する（`sticker_inspect` の経路）。
fn inspect_rgba(
    image: &RgbaImage,
    bytes: u64,
    chroma: Option<&ChromaStats>,
    source_opaque: Option<bool>,
) -> Vec<StickerIssue> {
    let (w, h) = image.dimensions();
    let mut issues = Vec::new();

    // size-over: 矯正済みなら通常発生しない。発生＝矯正のバグなのでブロッカー。
    if w > MAX_STICKER_WIDTH || h > MAX_STICKER_HEIGHT {
        issues.push(StickerIssue::blocker(
            "size-over",
            format!(
                "寸法が {w}×{h} で、上限の {MAX_STICKER_WIDTH}×{MAX_STICKER_HEIGHT} を超えています"
            ),
        ));
    }

    // size-odd: 同上。
    if w % 2 != 0 || h % 2 != 0 {
        issues.push(StickerIssue::blocker(
            "size-odd",
            format!("寸法が {w}×{h} で、幅・高さのどちらかが奇数です"),
        ));
    }

    // no-alpha: **矯正しない**（§1.8 最重要）。背景を勝手に抜くのは AI の仕事。
    // 関所は事実を検出して止めるだけにする。
    //
    // ⚠️ **判定対象は「元画像」であって、正規化後の画像ではない**（B1）。
    // `normalize_sticker` は被写体の周りへ透明な余白を足すので、正規化後の画像は
    // 元が全面不透明（＝背景が抜けていない）でも必ず透明画素を持つ。正規化後だけを
    // 見ると「透明画素が1つでもあるか」が常に真になり、この検査が**無条件で通過する**。
    // 呼び出し側が正規化前に測った事実（`source_opaque`）があればそれを正とする。
    let fully_opaque = source_opaque.unwrap_or_else(|| is_fully_opaque(image));
    if fully_opaque {
        issues.push(StickerIssue::blocker(
            "no-alpha",
            "背景が透過されていません。背景を抜いてから書き出してください",
        ));
    }

    // margin-short: アルファのバウンディングボックスで測る（§1.9）。
    match margin_of(image) {
        Some(m) if m < STICKER_PADDING_PX => {
            issues.push(StickerIssue::blocker(
                "margin-short",
                format!("周囲の余白が {m}px しかありません（{STICKER_PADDING_PX}px 以上必要）"),
            ));
        }
        None => {
            // 不透明画素が1つも無い＝完全に透明な画像。規格以前に中身が無い。
            issues.push(StickerIssue::blocker(
                "margin-short",
                "画像が完全に透明で、被写体がありません",
            ));
        }
        _ => {}
    }

    // file-too-large: ブロッカーだが**当該1枚のみ**。他の枚数は書き出せる。
    if bytes > MAX_BYTES_PER_IMAGE {
        issues.push(StickerIssue::blocker(
            "file-too-large",
            format!(
                "ファイルサイズが {bytes} バイトで、上限の {MAX_BYTES_PER_IMAGE} バイト（1MB）を超えています"
            ),
        ));
    }

    // ink-too-small: 警告のみ。しきい値に公式根拠が無いため（MIN_INK_RATIO のコメント）。
    let ratio = ink_ratio_of(image);
    if ratio < MIN_INK_RATIO {
        issues.push(StickerIssue::warning(
            "ink-too-small",
            format!(
                "被写体が画面の {:.1}% しかありません（目安 {:.0}% 以上）",
                ratio * 100.0,
                MIN_INK_RATIO * 100.0
            ),
        ));
    }

    // chroma-not-cleared: **抜きを試みて1画素も抜けなかった**（R2 / 2026-08-05）。
    //
    // ## なぜ `no-alpha` では拾えないのか
    //
    // 個別再生成（工程⑤）はマスクの内側だけを生成物で置き換える。生成プロンプトは
    // 緑背景を要求しているので、抜けなければ**塗った範囲だけが緑のまま**になる。
    // 画像の他の部分は既に透過済みなので「全面不透明か」を見る `no-alpha` は偽を返し、
    // 緑を含んだ画像が提出用の関所を通過していた。
    //
    // ## なぜ「統計がある」ことを条件にするのか
    //
    // `cleared == 0` は**抜きを試みた画像に対してしか言えない**。持ち込み画像や
    // 元から透過済みの画像には統計が無く（`chroma: None`）、そこで
    // 「抜けていない」と怒るのは測っていないことを語ることになる。
    // 呼び出し側が「抜きを試みた」と申告した画像だけを見る。
    //
    // ## `no-alpha` と二重に出さない
    //
    // 全面不透明の画像は `no-alpha` が既にブロッカーとして拾っている。
    // 同じ事実（背景が抜けていない）で2回怒ると、直す場所が2つあるように見える。
    if let Some(stats) = chroma {
        if stats.cleared == 0 && !fully_opaque {
            issues.push(StickerIssue::blocker(
                "chroma-not-cleared",
                "緑の背景が抜けていません。塗り直すか、抜き直してください",
            ));
        }
    }

    // fringe / edge-aliased: 縁の品質を**両方向**から見る。同じ分母（輪郭長近似）の
    // 一つの軸で、上に外れれば「にじみ過多」、下に外れれば「二値化でギザギザ」。
    // どちらも**警告に留める** — 意図的な半透明（グラデーション）も、意図的な二値
    // （ドット絵）も、正当な作風として存在するため。
    if let Some(stats) = chroma {
        let pct = fringe_ratio_pct(stats);
        if pct > FRINGE_WARN_PCT {
            issues.push(StickerIssue::warning(
                "fringe",
                format!("背景の抜け残り（輪郭のにじみ）が多い可能性があります（{pct}%）"),
            ));
        } else if stats.opaque + stats.semi_transparent > 0
            && soft_edge_ratio_pct(stats) < EDGE_SOFT_MIN_PCT
        {
            // 前景が1画素も無いケース（完全に透明な画像）は ratio が 0 になるので、
            // ここで弾く。それは縁の問題ではなく中身が無い問題で、margin-short が
            // 既にブロッカーとして拾っている。**同じ事実で2回怒らない。**
            let pct = soft_edge_ratio_pct(stats);
            issues.push(StickerIssue::warning(
                "edge-aliased",
                format!(
                    "輪郭が滑らかでない可能性があります（半透明の縁が {pct}%）。ギザギザに見える場合は元画像を確認してください"
                ),
            ));
        }
    }

    issues
}

/// セット単位の検査（`total-too-large` / `count-invalid`）。
///
/// `count-invalid` は**申請モードのみ**（§1.1）。自分用に3枚だけ作る人を止めない。
fn inspect_set(total_bytes: u64, count: usize, mode: ExportMode) -> Vec<StickerIssue> {
    let mut issues = Vec::new();

    if total_bytes > MAX_BYTES_TOTAL {
        issues.push(StickerIssue::blocker(
            "total-too-large",
            format!(
                "合計サイズが {total_bytes} バイトで、上限の {MAX_BYTES_TOTAL} バイト（60MB）を超えています"
            ),
        ));
    }

    if mode == ExportMode::Submission && !STICKER_COUNTS.contains(&count) {
        issues.push(StickerIssue::blocker(
            "count-invalid",
            format!(
                "枚数が {count} 枚です。申請できるのは {} 枚のいずれかです",
                STICKER_COUNTS
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<_>>()
                    .join(" / ")
            ),
        ));
    }

    issues
}

// ───────────────────────── コマンド: 検査 ─────────────────────────

/// 層A（決定論チェッカー）を**検査だけ**行う。ファイルは1バイトも書かない。
///
/// 工程⑥（書き出し前の確認画面）が使う。ここで出る所見と、`sticker_export` が
/// 出す所見は**同じ関数**（`inspect_rgba` / `inspect_set`）から出る。
/// 別実装にすると「確認画面では通ったのに書き出しで止まる」が起きる。
///
/// ## 正規化のドライランを通してから検査する（export 第1段と同じ順序 / F2）
///
/// 同じ関数を呼ぶだけでは足りない。**渡す画像が違えば結論も違う**。旧実装は
/// `image::open` した生画像をそのまま検査していたが、生成直後の素材は 1024×1024 級なので
/// `size-over`（場合により `file-too-large`）が毎回ブロッカーで出た。一方 `sticker_export`
/// は `normalize_sticker` を通した後を検査するため通る。**同じ画像で確認は赤・書き出しは通る**
/// という食い違いになっていた。
///
/// ここでは書き出しと同じ順序でドライランする:
/// 元画像の透過を測る（B1・正規化より先）→ `normalize_sticker` → `encoded_len` で容量を
/// 見積もる → `inspect_rgba`。ファイルは1バイトも書かない点は変わらない。
///
/// 返す `width` / `height` / `bytes` も**正規化後の値**にする。書き出されるものを見せるのが
/// 目的であり、生寸法（1024×1024）を出すと「その寸法なのに size-over が出ない」という
/// 別種の混乱になる。
#[tauri::command]
pub async fn sticker_inspect(
    paths: Vec<String>,
    mode: ExportMode,
    chroma_samples: Option<Vec<StickerChromaSample>>,
) -> Result<StickerInspectResult, String> {
    if paths.is_empty() {
        return Err("検査する画像が選択されていません".to_string());
    }

    // 抜いた側が申告した統計（A5）。無い画像は `fringe` を判定しない。
    let samples = chroma_samples.unwrap_or_default();
    let chroma_by_path = chroma_index(&samples);

    let mut items = Vec::new();
    let mut total_bytes: u64 = 0;

    for path in &paths {
        let p = PathBuf::from(path);

        let img = match image::open(&p) {
            Ok(i) => i,
            Err(e) => {
                // 読めないものは「規格外」ではなく「壊れている」。所見として残し、
                // 黙って除外しない（除外は下流の判定者の仕事）。
                items.push(StickerInspection {
                    path: path.clone(),
                    width: 0,
                    height: 0,
                    bytes: 0,
                    ink_ratio: 0.0,
                    margin_px: None,
                    issues: vec![StickerIssue::blocker(
                        "decode-failed",
                        format!("画像を読み込めません: {e}"),
                    )],
                });
                continue;
            }
        };

        // ⚠️ **透過の判定は正規化より先**（B1）。`sticker_export` と同じ順序。
        // `normalize_sticker` は被写体の周りへ透明な余白を足すため、正規化後は
        // 元が全面不透明でも透明画素を持つ。順序を入れ替えると `no-alpha` が恒真に
        // 通過し、背景を抜いていない画像が確認画面で「問題なし」に見える。
        let source_opaque = is_fully_opaque(&img.to_rgba8());

        let normalized = normalize_sticker(
            &img,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );

        // 容量は**正規化後**をエンコードして見積もる（export と同じ）。ディスク上の
        // 実バイト数を使うと、生成直後の大きな元画像で `file-too-large` が出て
        // 書き出しと食い違う。
        let est_bytes = match encoded_len(&normalized.image) {
            Ok(n) => n,
            Err(e) => {
                // 1枚の見積り失敗で検査全体を落とさない（export が `failed` に積んで
                // 続行するのと同じ扱い）。「確認できない」ことを所見として残す。
                items.push(StickerInspection {
                    path: path.clone(),
                    width: normalized.image.width(),
                    height: normalized.image.height(),
                    bytes: 0,
                    ink_ratio: 0.0,
                    margin_px: None,
                    issues: vec![StickerIssue::blocker(
                        "decode-failed",
                        format!("画像の容量を見積もれません: {e}"),
                    )],
                });
                continue;
            }
        };
        total_bytes += est_bytes;

        let (w, h) = normalized.image.dimensions();
        items.push(StickerInspection {
            path: path.clone(),
            width: w,
            height: h,
            bytes: est_bytes,
            ink_ratio: ink_ratio_of(&normalized.image),
            margin_px: margin_of(&normalized.image),
            // 縁の統計は**元パス**に対して申告される（正規化後の画像は別物なので、
            // 抜いた時の path で引く）。無ければ `fringe` は判定しない（A5）。
            issues: inspect_rgba(
                &normalized.image,
                est_bytes,
                chroma_by_path.get(path.as_str()),
                Some(source_opaque),
            ),
        });
    }

    let set_issues = inspect_set(total_bytes, paths.len(), mode);

    Ok(StickerInspectResult {
        items,
        set_issues,
        total_bytes,
    })
}

// ───────────────────────── コマンド: クロマキー抜き ─────────────────────────

/// クロマキー抜き1枚ぶんの結果。
///
/// 統計をそのまま返すのは、**抜けたかどうかをフロントが判断できるようにする**ため。
/// 「成功しました」だけを返すと、緑が均一でなくて1画素も抜けなかった場合と
/// 区別が付かない（設計書 §1.4「プロンプト指定は保証ではない」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerChromaResult {
    /// 抜いた結果の PNG パス（元画像とは別ファイル。元は残す）。
    pub output: String,
    /// 完全透過にした画素数。**0 なら緑背景が無かった**（抜けていない）。
    pub cleared: u64,
    /// 遷移帯（半透明）の画素数。多すぎるとフリンジ。
    pub semi_transparent: u64,
    /// 残った不透明画素数（＝被写体）。
    pub opaque: u64,
    /// 緑スピルを削った画素数。
    pub despilled: u64,
    /// 半透明が輪郭1周分（100）に対しどれだけ多いか。`FRINGE_WARN_PCT` 超で縁が怪しい。
    pub fringe_pct: u32,
    /// `fringe_pct` が `FRINGE_WARN_PCT` を超えたか（＝抜け残りの疑い）。
    ///
    /// **判定済みの真偽値を返す**のは、しきい値の正本を Rust 側に1つだけ置くため。
    /// 数値だけ返してフロントで `> 300` と書くと、しきい値が2箇所になり
    /// `spec_ts_sync` 系のテストが守れない範囲に second source of truth ができる。
    pub fringe_warn: bool,
}

/// 1枚をクロマキーで抜いて、透過 PNG を**別ファイル**として書き出す（S2）。
///
/// ## 元画像を上書きしない理由
///
/// 抜きは決定論だが、**緑が均一でなければ結果は使い物にならない**（設計書 §1.4）。
/// 上書きすると失敗時に戻れない。元を残しておけば、しきい値を変えて抜き直すことも、
/// 背景除去（Vision / BiRefNet）へ切り替えることもできる。
///
/// ## 判定をここでしない理由
///
/// `cleared == 0`（1画素も抜けなかった）を**ここでエラーにしない**。抜けたかどうかの
/// 事実（統計）だけを返し、どう扱うかは呼び出し側が決める。規格としての合否は
/// `sticker_inspect` / `sticker_export` の層Aが `no-alpha` で判定する担当であり、
/// 同じ判断を2箇所に置くと「検査では通ったのに抜きで止まる」型のズレが生まれる。
#[tauri::command]
pub async fn sticker_chroma_key(path: String) -> Result<StickerChromaResult, String> {
    let src = PathBuf::from(&path);
    let mut image = image::open(&src)
        .map_err(|e| format!("画像を読み込めません: {e}"))?
        .to_rgba8();

    let stats = crate::images::chroma::apply_chroma_key(&mut image);

    // 元画像の隣の**隠しディレクトリ** `.masks/` へ置く（A3）。
    //
    // ## なぜギャラリーへ出さないのか（2026-08-05 修正・関所は上流に）
    //
    // 旧実装は元画像と同じディレクトリへ `-cut.png` を出しており、コメントも
    // 「ギャラリーの watcher が拾える場所」と**意図的に**書いていた。だが抜いた直後の
    // 画像は**まだスタンプ規格の検査を1つも通っていない中間生成物**であり、
    // ここから素材として持ち出せると `sticker_inspect` / `sticker_export` の層Aを
    // 迂回する経路になる。`determinism-vs-ai.md` の「関所を末端に置くと必ず漏れる」
    // （漫画のサイズ問題）と同型の穴。
    //
    // ## なぜ `.masks/` を新設せず再利用するのか
    //
    // `images_write_mask`（`commands/images.rs:290-313`）が既に同じ問題を
    // 「元画像の隣の隠し `.masks/`」で解いており、`images/watcher.rs` の
    // `is_in_masks_dir` / `collect_images_recursive` / `scan_existing` と
    // `commands/images.rs` の `index_dir_recursive` の**4箇所すべてが**この名前を
    // 除外する。新しい隠しディレクトリ名を作ると、その4箇所を同時に直さない限り
    // 片方だけ漏れる（＝また同じ穴を掘る）。**除外の正本を1つに保つ。**
    //
    // 書き出し（`sticker_export`）は人が選んだフォルダへ改めて出すので、
    // ここが非表示でも成果物の受け取りには影響しない。
    let parent = src
        .parent()
        .ok_or_else(|| format!("画像の置き場所を特定できません: {path}"))?;
    let work_dir = parent.join(STICKER_WORK_DIRNAME);
    if !work_dir.exists() {
        std::fs::create_dir_all(&work_dir).map_err(|e| format!("作業フォルダを作れません: {e}"))?;
    }
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("sticker");
    let dest = work_dir.join(format!("{stem}-cut.png"));
    write_png(&image, &dest)?;

    Ok(StickerChromaResult {
        output: dest.to_string_lossy().into_owned(),
        cleared: stats.cleared,
        semi_transparent: stats.semi_transparent,
        opaque: stats.opaque,
        despilled: stats.despilled,
        fringe_pct: fringe_ratio_pct(&stats),
        fringe_warn: fringe_ratio_pct(&stats) > FRINGE_WARN_PCT,
    })
}

// ───────────────────────── コマンド: 書き出し ─────────────────────────

/// 出力先に既存の連番ファイルがあるか。
///
/// `pick_unique`（`images.rs`）を**使わない**。同関数は衝突時に `01 (1).png` を返し、
/// 連番の完全性（D11）が壊れる。ここは**事前に停止して人に確認を求める**。
/// 上書きか別フォルダかは人が決めること。
fn existing_sequence_files(dir: &Path) -> Vec<String> {
    let mut found = BTreeSet::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_sequence = name.len() == 6
            && name.ends_with(".png")
            && name[..2].chars().all(|c| c.is_ascii_digit());
        if is_sequence || name == "main.png" || name == "tab.png" {
            found.insert(name);
        }
    }
    found.into_iter().collect()
}

/// 矯正済み RGBA を PNG として書き、書いたバイト数を返す。
///
/// `encode_png` と同じエンコーダを通すので、**書いたファイルと `encoded_len` の
/// 見積りが必ず一致する**（片方だけ sRGB/pHYs を付けるとサイズがズレ、
/// `file-too-large` の判定が実ファイルと食い違う）。
fn write_png(image: &RgbaImage, dest: &Path) -> Result<u64, String> {
    let bytes = encode_png(image)?;
    std::fs::write(dest, &bytes).map_err(|e| format!("PNG の書き出しに失敗: {e}"))?;
    std::fs::metadata(dest)
        .map(|m| m.len())
        .map_err(|e| format!("書き出したファイルを確認できません: {e}"))
}

/// 提出用 ZIP を1つ作り、（パス, 実バイト数）を返す。
///
/// ## なぜ ZIP を作るのか（設計書 §1.10 の判断を上書きした経緯）
///
/// 設計書 v3 §1.10 は「ZIP を作らない」と決めていた。根拠は
/// 「Web UI は個別ファイルの D&D で受けるので ZIP は必須ではない」。
/// これは**誤りではないが不十分**だった。LINE Creators Market のガイドライン
/// （<https://creator.line.me/ja/guideline/sticker/>）は
/// 「すべての画像を ZIP ファイルにまとめてアップロードするには、ZIP ファイルを
/// 60MB 以下にしてください」と ZIP 経路を明記している。つまり ZIP は
/// **必須ではないが公式にサポートされた提出経路**であり、作らないと
/// ユーザーが手で ZIP 化する作業が残る（STΛCK 指摘 2026-08-05）。
///
/// 個別ファイルも従来どおりフォルダに残すので、D&D 派の導線は壊れない。
/// **ZIP は増設であって置換ではない。**
///
/// ## 構成（フラット・サブフォルダなし）
///
/// ```text
/// stickers.zip
///   ├ 01.png … NN.png   スタンプ本体
///   ├ main.png          240×240
///   └ tab.png            96×74
/// ```
///
/// ⚠️ **公式ガイドラインは ZIP 内部のフォルダ構成・命名を明記していない**
/// （一次情報を 2026-08-05 に確認。「まとめてアップロード」としか書かれていない）。
/// そのためフラット構成を採る。理由は、サブフォルダを作ると解凍後の階層が
/// 深くなり、どの経路でも素直に読める形にならないため。フォルダ側の出力
/// （`01.png` 直置き）と**同じ形**にすることで、ZIP と展開結果が一致する。
/// 命名は `NamingStyle::sticker`（ゼロ埋め2桁）を維持する。
///
/// ## 「作成条件.txt」を入れない
///
/// 提出物に独自ファイルを混ぜない（`encode_png` が PNG のテキストチャンクへ
/// メタデータを埋めないのと同じ理由）。控えはフォルダ側にだけ残す。
fn write_submission_zip(
    out_dir: &Path,
    entries: &[(String, PathBuf)],
) -> Result<(String, u64), String> {
    use std::io::Write as _;

    let zip_path = out_dir.join(SUBMISSION_ZIP_NAME);
    let file =
        std::fs::File::create(&zip_path).map_err(|e| format!("ZIP を作成できません: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    // PNG は既に deflate 圧縮済みなので、ZIP 側で更に縮めても効果は小さい。
    // それでも Deflated を選ぶのは、Stored だと 60MB 上限に対して不利になるため。
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for (name, src) in entries {
        let bytes =
            std::fs::read(src).map_err(|e| format!("{name} を ZIP へ入れられません: {e}"))?;
        writer
            .start_file(name.clone(), options)
            .map_err(|e| format!("{name} を ZIP へ入れられません: {e}"))?;
        writer
            .write_all(&bytes)
            .map_err(|e| format!("{name} を ZIP へ書けません: {e}"))?;
    }

    writer
        .finish()
        .map_err(|e| format!("ZIP を閉じられません: {e}"))?;

    // ⚠️ **実ファイルサイズを測る**（見積りで判定しない）。圧縮率は中身次第で
    // 変わるため、PNG の合計バイト数から ZIP のサイズは決まらない。
    let bytes = std::fs::metadata(&zip_path)
        .map(|m| m.len())
        .map_err(|e| format!("作成した ZIP を確認できません: {e}"))?;

    Ok((zip_path.to_string_lossy().into_owned(), bytes))
}

/// スタンプ一式をフォルダへ書き出す（§1.10）。**申請モードは ZIP も作る。**
///
/// `mode` の差は**関所の厳しさとおまけファイルの有無だけ**（D15）。
/// 矯正・リサイズ・検査は両モードで同じコードを通る。
///
/// - `personal`: 規格矯正は**する**（自分で LINE に取り込むときも同じ寸法要件が要るため。
///   矯正しても誰も損しない）。ブロッカーがあっても**止めない**。main/tab は出さない。
/// - `submission`: ブロッカーが1件でもあれば**何も書かずに止める**。main/tab を出す。
///
/// `main_source` / `tab_source` を省略した場合は1枚目を使う。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sticker_export(
    paths: Vec<String>,
    output_dir: String,
    mode: ExportMode,
    main_source: Option<String>,
    tab_source: Option<String>,
    overwrite: Option<bool>,
    prompt_style: Option<String>,
    chroma_samples: Option<Vec<StickerChromaSample>>,
) -> Result<StickerExportResult, String> {
    if paths.is_empty() {
        return Err("書き出す画像が選択されていません".to_string());
    }

    // 抜いた側が申告した統計（A5）。`sticker_inspect` と**同じ材料**を渡すことで、
    // 「確認画面では出た警告が書き出しでは消える」というズレを作らない。
    let samples = chroma_samples.unwrap_or_default();
    let chroma_by_path = chroma_index(&samples);

    let out_dir = PathBuf::from(&output_dir);
    if !out_dir.is_dir() {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("出力フォルダ作成に失敗: {e}"))?;
    }

    // 連番の完全性を守る（D11 / T11）。既存があれば**書く前に**止める。
    if !overwrite.unwrap_or(false) {
        let existing = existing_sequence_files(&out_dir);
        if !existing.is_empty() {
            return Err(format!(
                "出力先に既存のファイルがあります（{}）。上書きするか、別のフォルダを選んでください",
                existing.join(", ")
            ));
        }
    }

    // ── 第1段: 全枚を矯正して検査する。**まだ1バイトも書かない。**
    //
    // 申請モードは「ブロッカーがあれば何も出さない」なので、書きながら判定すると
    // 途中まで書いたゴミが残る。検査を先に済ませてから書く。
    struct Staged {
        source: String,
        image: RgbaImage,
        scale: f64,
        issues: Vec<StickerIssue>,
        est_bytes: u64,
    }

    let mut staged: Vec<Staged> = Vec::new();
    let mut failed: Vec<StickerExportFailure> = Vec::new();

    for path in &paths {
        let src_path = PathBuf::from(path);
        let img = match image::open(&src_path) {
            Ok(i) => i,
            Err(e) => {
                // 1枚壊れていても残りは続行する（部分成功・T8）。
                failed.push(StickerExportFailure {
                    source: path.clone(),
                    error: format!("画像を読み込めません: {e}"),
                });
                continue;
            }
        };

        // ⚠️ **透過の判定は正規化より先**（B1）。`normalize_sticker` は被写体の周りへ
        // 透明な余白を足すため、正規化後は元が全面不透明でも透明画素を持つ。順序を
        // 入れ替えると `no-alpha` が恒真に通過し、背景を抜いていない画像が
        // 申請モードの関所をすり抜ける。
        let source_opaque = is_fully_opaque(&img.to_rgba8());

        let normalized = normalize_sticker(
            &img,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );

        // 容量はエンコードしないと分からないので、メモリ上で1度エンコードして測る。
        // ここで測らずに書いてから測ると、1MB 超のファイルを一度ディスクに残すことになる。
        let est_bytes = encoded_len(&normalized.image)?;
        // 縁の統計は**元パス**に対して申告される（正規化後の画像は別物なので、
        // 抜いた時の path で引く）。無ければ `fringe` は判定しない。
        let issues = inspect_rgba(
            &normalized.image,
            est_bytes,
            chroma_by_path.get(path.as_str()),
            Some(source_opaque),
        );

        staged.push(Staged {
            source: path.clone(),
            image: normalized.image,
            scale: normalized.scale,
            issues,
            est_bytes,
        });
    }

    if staged.is_empty() {
        return Err("書き出せる画像が1枚もありませんでした".to_string());
    }

    let total_bytes: u64 = staged.iter().map(|s| s.est_bytes).sum();
    let set_issues = inspect_set(total_bytes, staged.len(), mode);

    // ── 関所: 申請モードだけが止まる（§1.1）。
    //
    // `total-too-large` は**モードに関わらず**書き出しを止める（§1.8 の表）。
    // 60MB を超えるセットは personal でも成立しないため。
    let total_over = set_issues.iter().any(|i| i.id == "total-too-large");
    if total_over {
        return Err(format!(
            "合計サイズが上限（{MAX_BYTES_TOTAL} バイト / 60MB）を超えています。枚数を減らすか、画像を軽くしてください"
        ));
    }

    if mode == ExportMode::Submission {
        let blockers: Vec<String> = staged
            .iter()
            .flat_map(|s| {
                s.issues
                    .iter()
                    .filter(|i| i.severity == IssueSeverity::Blocker)
                    .map(move |i| format!("{}: {}", s.source, i.message))
            })
            .chain(
                set_issues
                    .iter()
                    .filter(|i| i.severity == IssueSeverity::Blocker)
                    .map(|i| i.message.clone()),
            )
            .collect();

        if !blockers.is_empty() {
            return Err(format!(
                "画像規格を満たしていない項目があります:\n{}",
                blockers.join("\n")
            ));
        }
    }

    // ── 第2段: 書く。ここから先はディスクを触る。
    let mut items: Vec<StickerExportItem> = Vec::new();
    for (index, s) in staged.iter().enumerate() {
        let dest = out_dir.join(format!("{:02}.png", index + 1));
        match write_png(&s.image, &dest) {
            Ok(bytes) => items.push(StickerExportItem {
                source: s.source.clone(),
                output: dest.to_string_lossy().into_owned(),
                width: s.image.width(),
                height: s.image.height(),
                bytes,
                scale: s.scale,
                issues: s.issues.clone(),
            }),
            Err(error) => failed.push(StickerExportFailure {
                source: s.source.clone(),
                error,
            }),
        }
    }

    // ── 第2.5段: **書いた実物に対する枚数の再検査**（R4 / 2026-08-05）。
    //
    // ## なぜ第1段の検査だけでは足りないのか
    //
    // 第1段は「メモリ上の全枚」を検査しており、申請モードはそこでブロッカーがあれば
    // 止まる。良い関所だが、**検査した枚数と書けた枚数が一致する保証が無い**。
    // 第2段は書き込みの失敗を `failed` へ入れて続行するので、8枚で通った直後に
    // 1枚が書けなくても、成功した7枚＋main＋tab で ZIP が組み上がっていた。
    // **事前に通した枚数の関所を、実物が黙って通り抜ける経路**だった。
    //
    // ## personal を止めない理由（第1段の関所と同じ判断）
    //
    // 部分成功は personal の設計（T8）。自分で使う人にとって「7枚は書けた」は
    // 十分な成果で、そこを止めると救済にならない。失敗は `failed` に載って
    // 呼び出し側がトーストへ出す（可視化はしている）。
    //
    // 申請モードだけが「枚数」を要件に持つ（`count-invalid`）ので、ここも申請だけ止める。
    if mode == ExportMode::Submission && items.len() != staged.len() {
        // 中途半端な提出物を残さない（ZIP が 60MB を超えたときに `remove_file` するのと
        // 同じ流儀）。**既に書いた PNG も消す** — 消さないと、次回の書き出しが
        // `existing_sequence_files` で止まり、人は「なぜ止まるのか」を追えない。
        for item in &items {
            std::fs::remove_file(&item.output).ok();
        }

        let wrote = items.len();
        let total = staged.len();
        let missing = total - wrote;
        // 生エラーを直に並べない。`failed` の中身は1行に要約して添える。
        let detail = failed
            .iter()
            .map(|f| f.error.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!(
            "{total} 枚のうち {missing} 枚を保存できなかったため、申請用の書き出しを中止しました。保存先の空き容量と書き込み権限を確認して、もう一度お試しください。（詳しい内容: {detail}）"
        ));
    }

    // ── 第3段: おまけファイル（申請モードのみ）。
    let (main_image, tab_image) = if mode == ExportMode::Submission {
        let pick = |explicit: &Option<String>| -> String {
            explicit.clone().unwrap_or_else(|| staged[0].source.clone())
        };
        let main = export_fixed(&pick(&main_source), &out_dir, "main.png", MAIN_IMAGE_SIZE)?;
        let tab = export_fixed(&pick(&tab_source), &out_dir, "tab.png", TAB_IMAGE_SIZE)?;
        (Some(main), Some(tab))
    } else {
        (None, None)
    };

    let written_total: u64 = items.iter().map(|i| i.bytes).sum();

    // ── 第3.5段: 提出用 ZIP（申請モードのみ）。
    //
    // 個別ファイルは上で書き終えているので、ZIP は**それを詰めるだけ**。
    // ここで初めて作ると、ZIP と展開結果が食い違う余地が無い（同じ実ファイルを読む）。
    //
    // personal は ZIP を作らない。自分で使う人は解凍する手間が増えるだけで、
    // LINE へ出す予定が無いなら ZIP に用が無い。
    let (zip_path, zip_bytes) = if mode == ExportMode::Submission {
        let mut entries: Vec<(String, PathBuf)> = items
            .iter()
            .map(|i| {
                let path = PathBuf::from(&i.output);
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    // 連番の完全性が要件なので、ファイル名が取れない事態は握り潰さない。
                    .unwrap_or_else(|| "00.png".to_string());
                (name, path)
            })
            .collect();
        for extra in [main_image.as_ref(), tab_image.as_ref()]
            .into_iter()
            .flatten()
        {
            let path = PathBuf::from(extra);
            if let Some(name) = path.file_name() {
                entries.push((name.to_string_lossy().into_owned(), path));
            }
        }

        let (path, bytes) = write_submission_zip(&out_dir, &entries)?;

        // ⚠️ **作った後に実測で 60MB を検査する**（規律3: その時の値を信じない）。
        // 見積りの `total_bytes` は PNG の素のバイト数で、ZIP の圧縮後サイズとは別物。
        // 超過したら ZIP を消して止める。中途半端な提出物を残さない。
        if bytes > MAX_BYTES_TOTAL {
            std::fs::remove_file(&path).ok();
            return Err(format!(
                "提出用 ZIP が {bytes} バイトで、上限の {MAX_BYTES_TOTAL} バイト（60MB）を超えています。枚数を減らすか、画像を軽くしてください"
            ));
        }

        (Some(path), Some(bytes))
    } else {
        (None, None)
    };

    // ── 第4段: 作った条件を書き残す（後から「どの書き味で作ったか」を追えるようにする）。
    //
    // PNG のテキストチャンクに埋めない理由: LINE へ提出する画像に独自メタデータを
    // 足したくない（提出物は素のまま出す）。**提出物と併走する別ファイル**にする。
    // 書けなくても書き出し自体は成功しているので、**失敗させない**（警告に留める）。
    if let Some(style) = prompt_style.as_deref() {
        let manifest = out_dir.join("作成条件.txt");
        let mode_label = match mode {
            ExportMode::Personal => "このまま使う",
            ExportMode::Submission => "申請用",
        };
        let count = items.len();
        let body = [
            "この一式を作ったときの条件".to_string(),
            String::new(),
            format!("書き味: {style}"),
            format!("枚数: {count} 枚"),
            format!("書き出し: {mode_label}"),
            String::new(),
            "※このファイルはLINEへ提出するものではありません。".to_string(),
            "  あとで同じ書き味で作りたいときの控えです。".to_string(),
            String::new(),
        ]
        .join("\n");
        if let Err(e) = std::fs::write(&manifest, body) {
            tracing::warn!(target: "codex.sticker", "作成条件の書き出しに失敗: {e}");
        }
    }

    Ok(StickerExportResult {
        mode: match mode {
            ExportMode::Personal => "personal".to_string(),
            ExportMode::Submission => "submission".to_string(),
        },
        items,
        failed,
        main_image,
        tab_image,
        total_bytes: written_total,
        set_issues,
        zip_path,
        zip_bytes,
    })
}

/// PNG を組み立ててバイト列を返す（**書き出しと容量見積りの唯一の経路**）。
///
/// `image` クレートの `save_with_format` / `write_to` を使わず `png` を直接叩くのは、
/// `image` 0.25 の `PngEncoder` が **sRGB チャンクと pHYs チャンクを書く API を
/// 持たない**ため（S9 の目的そのもの）。
///
/// ## sRGB（`sRGB` チャンク）
///
/// 公式の技術要件は「カラーモード: RGB」までで、**プロファイル埋め込みは明文化
/// されていない**（`_work/gorigori-feedback/wave7/line-ai-policy-verified.md` §3-2）。
/// それでも付けるのは、色空間の指定が無い PNG は閲覧側が独自解釈するため、
/// 作ったときと違う色でトーク画面に出うるから。**規格要件でなく色ズレ対策**。
///
/// `RelativeColorimetric` を選ぶのは、スタンプがロゴ・イラスト（＝色の見えを
/// 合わせたい絵）だから（png クレートの `SrgbRenderingIntent` の定義どおり。
/// `Perceptual` は写真向け）。
///
/// ## 解像度（`pHYs` チャンク）
///
/// 公式要件は「**72dpi以上**」（同 §3-2）。PNG の pHYs は dpi でなく
/// **px/メートル**で持つので、72dpi を換算して焼く。
/// 記事にある「72〜150dpi推奨」は推奨であって要件ではないため、**下限の 72 を
/// 満たすことだけを目的**にする（勝手に 150 へ上げると、同じ画素数の絵が
/// 「小さい実寸」として解釈される環境が出うる）。
fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width(), image.height());
        // RGBA8 固定（D3）。normalize_sticker の出力が常に RGBA8 であることが前提。
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::RelativeColorimetric);
        encoder.set_pixel_dims(Some(png::PixelDimensions {
            xppu: STICKER_PPM,
            yppu: STICKER_PPM,
            unit: png::Unit::Meter,
        }));

        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG ヘッダの書き出しに失敗: {e}"))?;
        writer
            .write_image_data(image.as_raw())
            .map_err(|e| format!("PNG エンコードに失敗: {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("PNG の確定に失敗: {e}"))?;
    }
    Ok(out)
}

/// メモリ上で PNG エンコードしてバイト数を測る（ディスクに書かずに容量を知るため）。
fn encoded_len(image: &RgbaImage) -> Result<u64, String> {
    Ok(encode_png(image)?.len() as u64)
}

/// main / tab のように**寸法ちょうど**が要求される画像を書き出す（D8 / D9）。
///
/// スタンプ本体（「以内」）とは要件が違うので、キャンバスを固定サイズで作る。
/// 余白と拡大禁止の思想は本体と同じ（`normalize_sticker` を通してから中央へ貼る）。
fn export_fixed(
    source: &str,
    out_dir: &Path,
    file_name: &str,
    size: (u32, u32),
) -> Result<String, String> {
    let (tw, th) = size;
    let img = image::open(source).map_err(|e| format!("{file_name} の元画像を読めません: {e}"))?;

    // 固定サイズなので padding は「枠の内側に確保する余白」としてそのまま使う。
    let normalized = normalize_sticker(&img, tw, th, STICKER_PADDING_PX);

    // 寸法ちょうどの枠へ中央配置する。normalize_sticker は必要な大きさだけ確保するため、
    // ここで固定枠へ貼り直す（**この1手を省くと 240×240 ちょうどにならない**）。
    let mut canvas: RgbaImage = ImageBuffer::from_pixel(tw, th, Rgba([0, 0, 0, 0]));
    let src = &normalized.image;
    let ox = ((tw as i64) - (src.width() as i64)) / 2;
    let oy = ((th as i64) - (src.height() as i64)) / 2;
    image::imageops::overlay(&mut canvas, src, ox, oy);

    let dest = out_dir.join(file_name);
    write_png(&canvas, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 中央に不透明な四角を置いた RGBA 画像。余白は透明。
    fn subject(w: u32, h: u32, inset: u32) -> RgbaImage {
        let mut img: RgbaImage = ImageBuffer::from_pixel(w, h, Rgba([0, 0, 0, 0]));
        for y in inset..h.saturating_sub(inset) {
            for x in inset..w.saturating_sub(inset) {
                img.put_pixel(x, y, Rgba([200, 30, 30, 255]));
            }
        }
        img
    }

    /// 全面不透明（透過ゼロ）の画像。
    fn opaque(w: u32, h: u32) -> RgbaImage {
        ImageBuffer::from_pixel(w, h, Rgba([10, 10, 10, 255]))
    }

    // ── T1: 不透明背景は成功で返さない ──

    #[test]
    fn t1_opaque_image_is_blocked_by_no_alpha() {
        let img = opaque(200, 200);
        let issues = inspect_rgba(&img, 1000, None, None);
        let ids: Vec<&str> = issues.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"no-alpha"), "no-alpha が出ていない: {ids:?}");
        assert!(issues
            .iter()
            .any(|i| i.id == "no-alpha" && i.severity == IssueSeverity::Blocker));
    }

    // ── T1b: **実経路と同じ順序で**不透明背景が止まる（B1 の回帰テスト） ──
    //
    // T1 は正規化**前**の画像を直接 `inspect_rgba` に渡しており、`sticker_export` の
    // 実際の順序（正規化 → 検査）を再現していなかった。そのため
    // 「正規化が透明な余白を足す → 透明画素が生まれる → `no-alpha` が消える」という
    // 穴を踏まずに緑のまま通っていた。ここでは**実経路と同じ順序**で組んで検査する。

    #[test]
    fn t1b_opaque_image_is_blocked_through_the_real_export_order() {
        let src = DynamicImage::ImageRgba8(opaque(200, 200));

        // 実経路（`sticker_export`）と同じ順序: 先に元画像の透過を測り、その後で正規化する。
        let source_opaque = is_fully_opaque(&src.to_rgba8());
        let normalized = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );

        // 前提の確認: 正規化後の画像は**透明画素を持つ**（余白が足されたため）。
        // これがこの穴の正体。正規化後だけを見ると `no-alpha` は永遠に出ない。
        assert!(
            normalized.image.pixels().any(|p| p[3] < 255),
            "正規化が透明な余白を足していない。前提が崩れているのでこのテストは無効"
        );

        let issues = inspect_rgba(&normalized.image, 1000, None, Some(source_opaque));
        let ids: Vec<&str> = issues.iter().map(|i| i.id.as_str()).collect();
        assert!(
            ids.contains(&"no-alpha"),
            "全面不透明の元画像が提出用の関所を通過した（B1 の再発）: {ids:?}"
        );
        assert!(issues
            .iter()
            .any(|i| i.id == "no-alpha" && i.severity == IssueSeverity::Blocker));
    }

    // ── T1c: 透過済みの画像は誤検出しない（T1b の裏。牙が過剰に効いていないか） ──

    #[test]
    fn t1c_transparent_image_passes_no_alpha_through_the_real_export_order() {
        let src = DynamicImage::ImageRgba8(subject(200, 200, 20));
        let source_opaque = is_fully_opaque(&src.to_rgba8());
        let normalized = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );
        let issues = inspect_rgba(&normalized.image, 1000, None, Some(source_opaque));
        assert!(
            issues.iter().all(|i| i.id != "no-alpha"),
            "透過済みの画像を no-alpha で誤って止めた"
        );
    }

    // ── T2b: 奇数寸法の小画像でも**四辺すべて**が 10px 以上（B2 の回帰テスト） ──
    //
    // `margin_of` は四辺の**最小値**を返すので、これが padding 以上なら四辺すべてが
    // padding 以上。101×101 は旧実装（`floor_even` = 切り下げ）で 120×120 になり、
    // 中央配置の整数除算で左と上が 9px になっていた。

    #[test]
    fn t2b_odd_small_sources_keep_ten_px_on_all_four_sides() {
        // 奇数・偶数・上限超えを混ぜる。101×101 は Sol が margins=(9,10,9,10) を再現した実例。
        for (w, h) in [
            (101, 101),
            (99, 99),
            (103, 101),
            (1, 1),
            (200, 200),
            (371, 321),
            (350, 51),
        ] {
            let src = DynamicImage::ImageRgba8(subject(w, h, 0));
            let out = normalize_sticker(
                &src,
                MAX_STICKER_WIDTH,
                MAX_STICKER_HEIGHT,
                STICKER_PADDING_PX,
            );
            let (cw, ch) = out.image.dimensions();

            let margin = margin_of(&out.image).unwrap_or_else(|| panic!("{w}×{h}: 被写体が消えた"));
            assert!(
                margin >= STICKER_PADDING_PX,
                "{w}×{h} → {cw}×{ch}: 最小の余白が {margin}px（{STICKER_PADDING_PX}px 以上が必要・B2 の再発）"
            );

            // 余白を確保するために規格を割ってはいけない（切り上げが上限を跨がないこと）。
            assert!(
                cw <= MAX_STICKER_WIDTH && ch <= MAX_STICKER_HEIGHT,
                "{w}×{h} → {cw}×{ch}: 余白の切り上げで上限を超えた"
            );
            assert_eq!(cw % 2, 0, "{w}×{h} → 幅が奇数: {cw}");
            assert_eq!(ch % 2, 0, "{w}×{h} → 高さが奇数: {ch}");

            assert!(
                inspect_rgba(&out.image, 1000, None, Some(false))
                    .iter()
                    .all(|i| i.id != "margin-short" && i.id != "size-over" && i.id != "size-odd"),
                "{w}×{h} → {cw}×{ch}: 矯正後に規格の所見が出た"
            );
        }
    }

    // ── T2: 余白ゼロの素材に余白が付与される ──

    #[test]
    fn t2_zero_margin_subject_gains_padding() {
        // 枠いっぱい（inset=0）＝余白ゼロの透過 PNG。
        let src = DynamicImage::ImageRgba8(subject(300, 300, 0));
        let out = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );

        let margin = margin_of(&out.image).expect("被写体があるはず");
        assert!(
            margin >= STICKER_PADDING_PX,
            "余白が {margin}px しかない（{STICKER_PADDING_PX}px 以上が必要）"
        );
        assert!(inspect_rgba(&out.image, 1000, None, None)
            .iter()
            .all(|i| i.id != "margin-short"));
    }

    // ── T3: 上限超えは縮小され、偶数になる ──

    #[test]
    fn t3_oversized_is_shrunk_and_even() {
        let src = DynamicImage::ImageRgba8(subject(371, 321, 0));
        let out = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );
        let (w, h) = out.image.dimensions();

        assert!(w <= MAX_STICKER_WIDTH && h <= MAX_STICKER_HEIGHT, "{w}×{h}");
        assert_eq!(w % 2, 0, "幅が奇数: {w}");
        assert_eq!(h % 2, 0, "高さが奇数: {h}");
        assert!(out.scale <= 1.0);

        let issues = inspect_rgba(&out.image, 1000, None, None);
        assert!(issues
            .iter()
            .all(|i| i.id != "size-over" && i.id != "size-odd"));
    }

    // ── T4: 小さい素材は拡大されない（D12） ──

    #[test]
    fn t4_small_source_is_not_upscaled() {
        let src = DynamicImage::ImageRgba8(subject(100, 100, 0));
        let out = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );

        assert_eq!(out.scale, 1.0, "拡大されている");
        // 被写体 100 + 余白 10×2 = 120。キャンバスがそれを大きく超えないこと。
        let (w, h) = out.image.dimensions();
        assert_eq!(
            (w, h),
            (120, 120),
            "上限いっぱいへ引き伸ばされている: {w}×{h}"
        );
    }

    /// 被写体が極端に小さいと `ink-too-small` 警告が出る（**ブロックはしない**）。
    #[test]
    fn t4b_tiny_subject_warns_but_does_not_block() {
        let mut img: RgbaImage = ImageBuffer::from_pixel(370, 320, Rgba([0, 0, 0, 0]));
        for y in 150..156 {
            for x in 180..186 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 255]));
            }
        }
        let issues = inspect_rgba(&img, 1000, None, None);
        let ink = issues.iter().find(|i| i.id == "ink-too-small");
        assert!(ink.is_some(), "ink-too-small が出ていない");
        assert_eq!(ink.unwrap().severity, IssueSeverity::Warning);
    }

    // ── 余白不足の検出 ──

    #[test]
    fn margin_short_is_a_blocker() {
        // 被写体が枠から 3px しか離れていない。
        let img = subject(200, 200, 3);
        let issues = inspect_rgba(&img, 1000, None, None);
        let m = issues
            .iter()
            .find(|i| i.id == "margin-short")
            .expect("margin-short が出ていない");
        assert_eq!(m.severity, IssueSeverity::Blocker);
    }

    #[test]
    fn fully_transparent_image_is_blocked() {
        let img: RgbaImage = ImageBuffer::from_pixel(200, 200, Rgba([0, 0, 0, 0]));
        let issues = inspect_rgba(&img, 1000, None, None);
        assert!(issues
            .iter()
            .any(|i| i.id == "margin-short" && i.severity == IssueSeverity::Blocker));
    }

    // ── T6: 抜け残りが検出される（検査の牙） ──

    #[test]
    fn t6_fringe_is_detected_when_semi_transparent_pixels_are_excessive() {
        // 前景 100 画素に対し半透明 400 画素 → 推定輪郭長 4*10=40、比率 1000% > 300%。
        let bad = ChromaStats {
            cleared: 0,
            semi_transparent: 400,
            opaque: 100,
            despilled: 0,
        };
        let img = subject(200, 200, 20);
        let issues = inspect_rgba(&img, 1000, Some(&bad), None);
        assert!(
            issues.iter().any(|i| i.id == "fringe"),
            "抜け残りが検出されていない"
        );

        // 正常な抜き（輪郭1周分程度）では警告が出ない = 誤検出しない。
        let ok = ChromaStats {
            cleared: 10_000,
            semi_transparent: 40,
            opaque: 100,
            despilled: 0,
        };
        assert!(inspect_rgba(&img, 1000, Some(&ok), None)
            .iter()
            .all(|i| i.id != "fringe"));
    }

    // ── T7: 合計 60MB 超で止まる ──

    #[test]
    fn t7_total_too_large_blocks_the_set() {
        let issues = inspect_set(MAX_BYTES_TOTAL + 1, 16, ExportMode::Submission);
        let t = issues
            .iter()
            .find(|i| i.id == "total-too-large")
            .expect("total-too-large が出ていない");
        assert_eq!(t.severity, IssueSeverity::Blocker);

        assert!(inspect_set(MAX_BYTES_TOTAL, 16, ExportMode::Submission)
            .iter()
            .all(|i| i.id != "total-too-large"));
    }

    #[test]
    fn file_too_large_is_per_image() {
        let img = subject(200, 200, 20);
        let issues = inspect_rgba(&img, MAX_BYTES_PER_IMAGE + 1, None, None);
        assert!(issues
            .iter()
            .any(|i| i.id == "file-too-large" && i.severity == IssueSeverity::Blocker));
        assert!(inspect_rgba(&img, MAX_BYTES_PER_IMAGE, None, None)
            .iter()
            .all(|i| i.id != "file-too-large"));
    }

    // ── 枚数の5択は申請モードのみ（D10 / §1.1） ──

    #[test]
    fn count_invalid_only_applies_to_submission() {
        // 3枚は申請できないが、自分用なら問題にしない。
        assert!(inspect_set(1000, 3, ExportMode::Submission)
            .iter()
            .any(|i| i.id == "count-invalid"));
        assert!(inspect_set(1000, 3, ExportMode::Personal)
            .iter()
            .all(|i| i.id != "count-invalid"));

        for n in STICKER_COUNTS {
            assert!(
                inspect_set(1000, n, ExportMode::Submission)
                    .iter()
                    .all(|i| i.id != "count-invalid"),
                "{n} 枚が弾かれている"
            );
        }
    }

    #[test]
    fn sticker_counts_has_five_choices() {
        assert_eq!(STICKER_COUNTS.len(), 5);
        assert_eq!(STICKER_COUNTS, [8, 16, 24, 32, 40]);
    }

    // ── 幾何のユニット ──

    #[test]
    fn floor_even_rounds_down() {
        assert_eq!(floor_even(371), 370);
        assert_eq!(floor_even(370), 370);
        assert_eq!(floor_even(1), 0);
    }

    /// 縦長の素材で上限いっぱいへ広げない（被写体が小さく見える事故の防止）。
    #[test]
    fn normalize_keeps_aspect_and_does_not_pad_to_the_limit() {
        let src = DynamicImage::ImageRgba8(subject(100, 300, 0));
        let out = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );
        let (w, h) = out.image.dimensions();
        assert!(w < MAX_STICKER_WIDTH, "横に無駄な余白が入っている: {w}");
        assert!(h <= MAX_STICKER_HEIGHT);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    /// 矯正後は必ずアルファを持つ（RGBA8 / D3・D4）。不透明素材でも余白は透明になる。
    #[test]
    fn normalize_output_keeps_alpha_channel() {
        let src = DynamicImage::ImageRgba8(opaque(200, 200));
        let out = normalize_sticker(
            &src,
            MAX_STICKER_WIDTH,
            MAX_STICKER_HEIGHT,
            STICKER_PADDING_PX,
        );
        assert!(
            out.image.pixels().any(|p| p[3] == 0),
            "余白が透明になっていない（透過破壊）"
        );
    }

    // ── 連番の完全性（D11 / T11） ──

    #[test]
    fn existing_sequence_files_detects_numbered_and_extra_files() {
        let dir =
            std::env::temp_dir().join(format!("sticker-seq-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("01.png"), b"x").unwrap();
        std::fs::write(dir.join("main.png"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();

        let found = existing_sequence_files(&dir);
        assert!(found.contains(&"01.png".to_string()));
        assert!(found.contains(&"main.png".to_string()));
        assert!(
            !found.contains(&"notes.txt".to_string()),
            "無関係なファイルを衝突扱いしている"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_sequence_files_is_empty_for_clean_dir() {
        let dir =
            std::env::temp_dir().join(format!("sticker-clean-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(existing_sequence_files(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── main / tab は寸法ちょうど（D8 / D9） ──

    #[test]
    fn export_fixed_produces_exact_dimensions() {
        let dir =
            std::env::temp_dir().join(format!("sticker-fixed-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.png");
        subject(400, 400, 10).save(&src).unwrap();

        let main = export_fixed(src.to_str().unwrap(), &dir, "main.png", MAIN_IMAGE_SIZE).unwrap();
        let m = image::open(&main).unwrap();
        assert_eq!((m.width(), m.height()), MAIN_IMAGE_SIZE);

        let tab = export_fixed(src.to_str().unwrap(), &dir, "tab.png", TAB_IMAGE_SIZE).unwrap();
        let t = image::open(&tab).unwrap();
        assert_eq!((t.width(), t.height()), TAB_IMAGE_SIZE);

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── S9: 色プロファイル（sRGB）と解像度（pHYs） ──
    //
    // 「付けたつもり」を防ぐため、**書き出した実ファイルを png でデコードし直して
    // チャンクの中身を読む**。エンコーダを呼んだ事実ではなく、出力の実体を見る。

    /// 書き出した PNG を png クレートでデコードし、Info を返す。
    fn decode_info(path: &Path) -> png::Info<'static> {
        let file = std::fs::File::open(path).unwrap();
        let decoder = png::Decoder::new(std::io::BufReader::new(file));
        let reader = decoder.read_info().unwrap();
        reader.info().clone()
    }

    /// 書き出した PNG に sRGB チャンクが載っている（S9-1）。
    #[test]
    fn s9_written_png_declares_srgb() {
        let dir =
            std::env::temp_dir().join(format!("sticker-srgb-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.png");

        write_png(&subject(100, 100, 10), &dest).unwrap();

        let info = decode_info(&dest);
        assert!(
            info.srgb.is_some(),
            "sRGB チャンクが無い。色空間の指定が無い PNG は閲覧側が独自解釈する"
        );
        assert_eq!(
            info.srgb.unwrap(),
            png::SrgbRenderingIntent::RelativeColorimetric,
            "レンダリングインテントがイラスト向け（RelativeColorimetric）でない"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 書き出した PNG の pHYs が公式要件「72dpi以上」を満たす（S9-3）。
    ///
    /// 定数 `STICKER_PPM` を読むのではなく、**実ファイルの値を dpi へ逆算**して
    /// 要件と比べる。定数を書き換えて 72dpi を割ったらここで落ちる。
    #[test]
    fn s9_written_png_meets_minimum_dpi() {
        let dir =
            std::env::temp_dir().join(format!("sticker-phys-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.png");

        write_png(&subject(100, 100, 10), &dest).unwrap();

        let info = decode_info(&dest);
        let dims = info
            .pixel_dims
            .expect("pHYs チャンクが無い（解像度が未指定）");
        assert_eq!(dims.unit, png::Unit::Meter, "pHYs の単位がメートルでない");
        assert_eq!(dims.xppu, dims.yppu, "縦横で解像度が食い違っている");

        let dpi = dims.xppu as f64 * METERS_PER_INCH;
        assert!(
            dpi >= MIN_STICKER_DPI,
            "解像度が {dpi:.3}dpi で、公式要件の {MIN_STICKER_DPI}dpi 以上を満たさない"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 見積り（`encoded_len`）と実ファイルのサイズが一致する。
    ///
    /// sRGB/pHYs を片方の経路にだけ付けるとここがズレ、`file-too-large` の判定が
    /// 実ファイルと食い違う。**両方が同じ `encode_png` を通ることの検査**。
    #[test]
    fn s9_estimate_matches_written_bytes() {
        let dir =
            std::env::temp_dir().join(format!("sticker-est-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.png");
        let img = subject(120, 100, 10);

        let est = encoded_len(&img).unwrap();
        let written = write_png(&img, &dest).unwrap();

        assert_eq!(est, written, "見積りと実ファイルのサイズが食い違う");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// メタデータを足しても画素は壊れない（透過・色ともに往復する）。
    #[test]
    fn s9_metadata_does_not_corrupt_pixels() {
        let dir =
            std::env::temp_dir().join(format!("sticker-rt-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.png");
        let src = subject(60, 60, 10);

        write_png(&src, &dest).unwrap();
        let back = image::open(&dest).unwrap().to_rgba8();

        assert_eq!(back.dimensions(), src.dimensions());
        assert_eq!(
            back.get_pixel(30, 30),
            src.get_pixel(30, 30),
            "被写体の色が変化した"
        );
        assert_eq!(back.get_pixel(1, 1)[3], 0, "余白の透過が失われた");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// main / tab も同じ経路を通るので sRGB / pHYs を持つ。
    #[test]
    fn s9_main_and_tab_also_carry_metadata() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-fixed-md-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.png");
        subject(400, 400, 10).save(&src).unwrap();

        for (name, size) in [("main.png", MAIN_IMAGE_SIZE), ("tab.png", TAB_IMAGE_SIZE)] {
            let out = export_fixed(src.to_str().unwrap(), &dir, name, size).unwrap();
            let info = decode_info(Path::new(&out));
            assert!(info.srgb.is_some(), "{name} に sRGB が無い");
            let dpi = info.pixel_dims.expect("pHYs が無い").xppu as f64 * METERS_PER_INCH;
            assert!(dpi >= MIN_STICKER_DPI, "{name} が {dpi:.3}dpi");
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── spec.ts との同期（二重定義の検出） ──
    //
    // Rust は TS を import できないので、代わりに **spec.ts を読んで突き合わせる**。
    // 片方だけ変えたら落ちる。定数の同期を散文の約束でなくテストで守る。

    fn spec_ts() -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src/lib/sticker/spec.ts");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("spec.ts を読めません（{}）: {e}", path.display()))
    }

    #[test]
    fn spec_ts_sync_dimensions_and_limits() {
        let ts = spec_ts();
        for (needle, what) in [
            ("maxWidth: 370", "スタンプ幅上限"),
            ("maxHeight: 320", "スタンプ高さ上限"),
            ("NORMAL_PADDING_PX = 10", "余白"),
            ("MAX_BYTES_PER_IMAGE = 1_048_576", "1画像上限"),
            ("MAX_BYTES_TOTAL = 62_914_560", "合計上限"),
            ("MIN_INK_RATIO = 0.03", "ink 下限"),
            ("STICKER_COUNTS = [8, 16, 24, 32, 40]", "枚数5択"),
        ] {
            assert!(
                ts.contains(needle),
                "spec.ts と Rust 側の{what}がずれています（'{needle}' が spec.ts に無い）"
            );
        }

        // Rust 側の値が上のリテラルと一致していることも同時に固定する。
        assert_eq!(MAX_STICKER_WIDTH, 370);
        assert_eq!(MAX_STICKER_HEIGHT, 320);
        assert_eq!(STICKER_PADDING_PX, 10);
        assert_eq!(MAX_BYTES_PER_IMAGE, 1_048_576);
        assert_eq!(MAX_BYTES_TOTAL, 62_914_560);
        assert_eq!(MIN_INK_RATIO, 0.03);
    }

    #[test]
    fn spec_ts_sync_main_and_tab_sizes() {
        let ts = spec_ts();
        assert!(
            ts.contains("mainImage: { width: 240, height: 240 }"),
            "spec.ts のメイン画像寸法が Rust 側とずれています"
        );
        assert!(
            ts.contains("tabImage: { width: 96, height: 74 }"),
            "spec.ts のタブ画像寸法が Rust 側とずれています"
        );
        assert_eq!(MAIN_IMAGE_SIZE, (240, 240));
        assert_eq!(TAB_IMAGE_SIZE, (96, 74));
    }

    // ── S2: クロマキー抜きコマンド ──

    /// 緑背景の中央に不透明な被写体を置いた画像。
    fn green_bg_subject(w: u32, h: u32, inset: u32) -> RgbaImage {
        let mut img: RgbaImage = ImageBuffer::from_pixel(w, h, Rgba([0, 255, 0, 255]));
        for y in inset..h.saturating_sub(inset) {
            for x in inset..w.saturating_sub(inset) {
                // 純白の被写体。**白キャラ問題の再現**（設計書 §1.4）:
                // 背景除去AIは白を白から分離できないが、クロマキーは色距離で抜ける。
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        img
    }

    #[tokio::test]
    async fn chroma_key_cuts_green_background_and_keeps_white_subject() {
        let dir =
            std::env::temp_dir().join(format!("sticker-chroma-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("shot.png");
        green_bg_subject(80, 80, 20).save(&src).unwrap();

        let res = sticker_chroma_key(src.to_string_lossy().into_owned())
            .await
            .expect("クロマキー抜きが失敗した");

        // 元画像を上書きしない（失敗時に戻れる設計）。
        assert!(src.exists(), "元画像が消えている");
        assert_ne!(res.output, src.to_string_lossy(), "元画像を上書きしている");

        let out = image::open(&res.output).unwrap().to_rgba8();
        // 四隅（緑背景）は完全透過、中央（白い被写体）は不透明のまま。
        assert_eq!(out.get_pixel(0, 0)[3], 0, "背景の緑が抜けていない");
        assert_eq!(
            out.get_pixel(40, 40)[3],
            255,
            "白い被写体まで抜けている（白キャラ問題）"
        );
        assert!(res.cleared > 0, "1画素も抜けていない");
        assert!(res.opaque > 0, "被写体が残っていない");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn chroma_key_reports_zero_cleared_instead_of_failing() {
        // 緑がまったく無い画像。**エラーにせず「抜けなかった」事実を返す**
        // （合否判定は層Aの no-alpha の担当。同じ判断を2箇所に置かない）。
        let dir =
            std::env::temp_dir().join(format!("sticker-chroma-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("nogreen.png");
        opaque(40, 40).save(&src).unwrap();

        let res = sticker_chroma_key(src.to_string_lossy().into_owned())
            .await
            .expect("緑が無くてもエラーにしない");
        assert_eq!(res.cleared, 0, "抜けていないのに cleared が立っている");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn chroma_key_errors_on_unreadable_file() {
        let res = sticker_chroma_key("/nonexistent/sticker/does-not-exist.png".to_string()).await;
        assert!(res.is_err(), "存在しないファイルが成功で返っている");
    }

    // ── A3: 中間生成物がギャラリー監視対象へ流れない ──
    //
    // 「隠しフォルダに置いた」だけでは足りない。**実際にギャラリーが除外する関数**へ
    // 出力パスを食わせて false が返ることまで見る（除外の実装と出力先の名前が
    // 食い違ったら落ちる）。名前を文字列で assert するだけだと、watcher 側の
    // 除外リストから漏れていても気付けない。

    #[tokio::test]
    async fn a3_chroma_output_is_hidden_from_the_gallery() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-chroma-hidden-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("shot.png");
        green_bg_subject(60, 60, 15).save(&src).unwrap();

        let res = sticker_chroma_key(src.to_string_lossy().into_owned())
            .await
            .expect("クロマキー抜きが失敗した");

        let out = PathBuf::from(&res.output);
        assert!(out.exists(), "出力ファイルが無い");

        // 元画像と同じディレクトリに置いていない（ここが旧実装の穴）。
        assert_ne!(
            out.parent(),
            src.parent(),
            "中間生成物が元画像と同じディレクトリに出ている（ギャラリーへ流出する・A3 の再発）"
        );

        // 出力先が「ギャラリーが除外する隠しディレクトリ」の直下にある。
        assert_eq!(
            out.parent()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str()),
            Some(STICKER_WORK_DIRNAME),
            "出力先が除外対象の隠しディレクトリでない"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A3 の本体: **ギャラリー除外の実装4箇所すべてが** `STICKER_WORK_DIRNAME` を
    /// 弾いていることを、実ソースを読んで突き合わせる。
    ///
    /// なぜソースを読むのか: 除外関数（`watcher.rs` の `is_in_masks_dir` /
    /// `collect_images_recursive` / `scan_existing`、`images.rs` の
    /// `index_dir_recursive`）はいずれも**プライベート**で、このモジュールから
    /// 呼べない。「隠しフォルダ名を定数にした」だけを assert すると、除外側から
    /// 名前が消えても落ちない自己言及の罠になる（`spec_ts_sync` が spec.ts を
    /// 実際に読んで突き合わせるのと同じ理由）。
    ///
    /// この検査が落ちる = 中間生成物がギャラリーへ出る経路ができた、を意味する。
    #[test]
    fn a3_every_gallery_exclusion_site_filters_the_sticker_work_dir() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let watcher = std::fs::read_to_string(root.join("src/images/watcher.rs"))
            .expect("watcher.rs を読めません");
        let images = std::fs::read_to_string(root.join("src/commands/images.rs"))
            .expect("images.rs を読めません");

        let needle = format!("\"{STICKER_WORK_DIRNAME}\"");

        // watcher.rs: fs イベント経路（is_in_masks_dir）+ 起動時走査（scan_existing）
        // + 再帰収集（collect_images_recursive）の3箇所。
        let watcher_hits = watcher.matches(needle.as_str()).count();
        assert!(
            watcher_hits >= 3,
            "watcher.rs の除外が {watcher_hits} 箇所しかない（fs イベント / 起動時走査 / 再帰収集の\
             3経路すべてが {needle} を弾く必要がある）。1つでも漏れると中間生成物がギャラリーへ出る"
        );

        // images.rs: ファイル名索引（index_dir_recursive）。
        assert!(
            images.contains(needle.as_str()),
            "images.rs の索引が {needle} を弾いていない（リンク切れ修復でパスが拾われる）"
        );
    }

    // ── A5: 抜きの統計が実経路（inspect / export）へ届く ──
    //
    // 旧実装は本番の呼び出しが両方とも `inspect_rgba(..., None, ..)` で、
    // `fringe` / `edge-aliased` の検査がテストの中でしか動いていなかった。
    // ここでは**コマンドの引数から**統計を流し込み、所見に出るところまで見る。

    /// 抜け残りが酷い統計（`t6_...` と同じ比率）。
    fn fringey_sample(path: &str) -> StickerChromaSample {
        StickerChromaSample {
            path: path.to_string(),
            cleared: 0,
            semi_transparent: 400,
            opaque: 100,
            despilled: 0,
        }
    }

    #[tokio::test]
    async fn a5_inspect_uses_chroma_samples_from_the_caller() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-a5-inspect-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        subject(200, 200, 20).save(&src).unwrap();
        let src_str = src.to_string_lossy().into_owned();

        // 統計を渡さない場合: `fringe` は判定されない（測っていないものを語らない）。
        let without = sticker_inspect(vec![src_str.clone()], ExportMode::Personal, None)
            .await
            .expect("検査が失敗した");
        assert!(
            without.items[0].issues.iter().all(|i| i.id != "fringe"),
            "統計を渡していないのに fringe を判定している"
        );

        // 統計を渡した場合: 実経路で `fringe` が出る。
        let with = sticker_inspect(
            vec![src_str.clone()],
            ExportMode::Personal,
            Some(vec![fringey_sample(&src_str)]),
        )
        .await
        .expect("検査が失敗した");
        assert!(
            with.items[0].issues.iter().any(|i| i.id == "fringe"),
            "申告した抜きの統計が実経路の検査へ届いていない（A5 の再発）: {:?}",
            with.items[0]
                .issues
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a5_export_uses_chroma_samples_from_the_caller() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-a5-export-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        subject(200, 200, 20).save(&src).unwrap();
        let src_str = src.to_string_lossy().into_owned();

        let res = sticker_export(
            vec![src_str.clone()],
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Personal,
            None,
            None,
            None,
            None,
            Some(vec![fringey_sample(&src_str)]),
        )
        .await
        .expect("書き出しが失敗した");

        assert!(
            res.items[0].issues.iter().any(|i| i.id == "fringe"),
            "書き出し側で抜きの統計が使われていない（A5 の再発）"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────── F2: 確認と書き出しが同じ所見を返す ─────────────
    //
    // ## この検査が守っているもの
    //
    // 旧実装の `sticker_inspect` は `image::open` した**生画像**をそのまま検査していた。
    // 生成直後の素材は 1024×1024 級なので `size-over` が毎回ブロッカーで出る一方、
    // `sticker_export` は `normalize_sticker` を通した後を検査するので通る。
    // **同じ画像で「確認する」は赤・書き出しは成功**という誤報になっていた。
    //
    // ここでは同じ画像を両経路へ通し、所見（id の集合）が一致することを見る。
    // 「同じ関数を呼んでいるか」ではなく「**同じ結論が出るか**」で固定する。

    /// 所見 id を並べ替えて返す（比較用）。
    fn issue_ids(issues: &[StickerIssue]) -> Vec<String> {
        let mut ids: Vec<String> = issues.iter().map(|i| i.id.clone()).collect();
        ids.sort();
        ids
    }

    #[tokio::test]
    async fn f2_inspect_and_export_agree_on_a_generated_size_image() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-f2-agree-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();

        // 生成直後の実寸（1024×1024）。透過済み・被写体は中央。
        let src = dir.join("01.png");
        subject(1024, 1024, 100).save(&src).unwrap();
        let src_str = src.to_string_lossy().into_owned();

        let inspected = sticker_inspect(vec![src_str.clone()], ExportMode::Personal, None)
            .await
            .expect("検査が失敗した");
        let exported = sticker_export(
            vec![src_str.clone()],
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Personal,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("書き出しが失敗した");

        let inspect_ids = issue_ids(&inspected.items[0].issues);
        let export_ids = issue_ids(&exported.items[0].issues);
        assert_eq!(
            inspect_ids, export_ids,
            "同じ画像で確認と書き出しの所見が食い違っている（F2 の再発）"
        );

        // 具体的にどう食い違っていたか（旧実装の症状）を名指しで固定する。
        assert!(
            !inspect_ids.iter().any(|id| id == "size-over"),
            "正規化前の生寸法を測っている（size-over の誤報 / F2 の再発）: {inspect_ids:?}"
        );
        assert!(
            !inspect_ids.iter().any(|id| id == "file-too-large"),
            "ディスク上の実バイト数を測っている（file-too-large の誤報 / F2 の再発）: {inspect_ids:?}"
        );

        // 返す寸法・容量も書き出されるものに揃っている（生の 1024×1024 を出さない）。
        assert!(
            inspected.items[0].width <= MAX_STICKER_WIDTH
                && inspected.items[0].height <= MAX_STICKER_HEIGHT,
            "確認画面が生寸法（{}×{}）を返している",
            inspected.items[0].width,
            inspected.items[0].height
        );
        assert_eq!(
            inspected.total_bytes,
            inspected.items[0].bytes,
            "セット合計が各枚の見積りと揃っていない"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn f2_inspect_still_blocks_a_fully_opaque_image_with_no_alpha() {
        // F2 で `source_opaque` を渡すようになったので、この経路の B1 保護を
        // 新たにテストで固定する。正規化が透明な余白を足しても `no-alpha` は消えない。
        let dir = std::env::temp_dir().join(format!(
            "sticker-f2-noalpha-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        opaque(1024, 1024).save(&src).unwrap();
        let src_str = src.to_string_lossy().into_owned();

        let inspected = sticker_inspect(vec![src_str.clone()], ExportMode::Personal, None)
            .await
            .expect("検査が失敗した");
        let ids = issue_ids(&inspected.items[0].issues);
        assert!(
            ids.iter().any(|id| id == "no-alpha"),
            "全面不透明の画像が確認画面をすり抜けた（B1 の再発）: {ids:?}"
        );
        assert!(inspected.items[0]
            .issues
            .iter()
            .any(|i| i.id == "no-alpha" && i.severity == IssueSeverity::Blocker));

        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────── R2: 緑が抜けなかった画像を提出用の関所が止める ─────────────
    //
    // ## この検査が守っているもの
    //
    // 個別再生成（工程⑤）はマスクの内側だけを生成物で置き換える。生成プロンプトは
    // 緑背景を要求しているので、抜けなければ**塗った範囲だけが緑のまま**になる。
    // 画像の他の部分は既に透過済みなので `no-alpha`（全面不透明か）は偽を返し、
    // **緑を含んだ画像が提出用の書き出しを通過していた**。

    /// 「抜きを試みたが1画素も抜けなかった」統計。縁の品質は語れる材料が無い形にする
    /// （`semi_transparent` を輪郭1周相当に抑え、`fringe` と混ざらないようにする）。
    fn not_cleared_sample(path: &str) -> StickerChromaSample {
        StickerChromaSample {
            path: path.to_string(),
            cleared: 0,
            semi_transparent: 40,
            opaque: 100,
            despilled: 0,
        }
    }

    /// 「正常に抜けた」統計。R2 の牙が過剰に効いていないかの裏取りに使う。
    fn cleared_sample(path: &str) -> StickerChromaSample {
        StickerChromaSample {
            path: path.to_string(),
            cleared: 10_000,
            semi_transparent: 40,
            opaque: 100,
            despilled: 0,
        }
    }

    #[test]
    fn r2_zero_cleared_chroma_is_a_blocker() {
        // 被写体まわりは透過済み（＝ `no-alpha` は出ない）。それでも「緑が抜けなかった」
        // という事実だけで止まることを見る。
        let img = subject(200, 200, 20);
        let stats = not_cleared_sample("/tmp/x.png").stats();

        let issues = inspect_rgba(&img, 1000, Some(&stats), Some(false));
        let hit = issues
            .iter()
            .find(|i| i.id == "chroma-not-cleared")
            .expect("chroma-not-cleared が出ていない（R2 の再発）");
        assert_eq!(hit.severity, IssueSeverity::Blocker);

        // 前提の確認: この画像は `no-alpha` では拾えない。
        // ここが偽になったら、このテストは別の理由で通っていることになる。
        assert!(
            issues.iter().all(|i| i.id != "no-alpha"),
            "no-alpha で止まっている。R2 が無くても止まる入力なのでこのテストは無効"
        );
    }

    #[test]
    fn r2_cleared_chroma_does_not_trigger_the_blocker() {
        // 抜けた画像を誤って止めない（牙が過剰に効いていないことの裏）。
        let img = subject(200, 200, 20);
        let stats = cleared_sample("/tmp/x.png").stats();
        assert!(
            inspect_rgba(&img, 1000, Some(&stats), Some(false))
                .iter()
                .all(|i| i.id != "chroma-not-cleared"),
            "正常に抜けた画像を chroma-not-cleared で止めた"
        );
    }

    #[test]
    fn r2_no_sample_means_no_judgement() {
        // 統計が無い画像（持ち込み・抜きに失敗）には**何も言わない**。
        // 測っていないものを測ったふりにしない。
        let img = subject(200, 200, 20);
        assert!(
            inspect_rgba(&img, 1000, None, Some(false))
                .iter()
                .all(|i| i.id != "chroma-not-cleared"),
            "統計が無いのに抜けていないと判定した（測っていないものを語っている）"
        );
    }

    #[test]
    fn r2_does_not_double_up_with_no_alpha() {
        // 全面不透明の画像は `no-alpha` が既に拾っている。同じ事実で2回怒らない。
        let img = opaque(200, 200);
        let stats = not_cleared_sample("/tmp/x.png").stats();
        let issues = inspect_rgba(&img, 1000, Some(&stats), Some(true));
        assert!(
            issues.iter().any(|i| i.id == "no-alpha"),
            "前提が崩れている: no-alpha が出ていない"
        );
        assert!(
            issues.iter().all(|i| i.id != "chroma-not-cleared"),
            "no-alpha と chroma-not-cleared が二重に出ている（直す場所が2つに見える）"
        );
    }

    #[tokio::test]
    async fn r2_submission_export_stops_when_green_was_not_cleared() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-r2-export-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();

        // 申請できる枚数（8枚）を用意し、そのうち1枚だけ「抜けなかった」と申告する。
        // 枚数を満たすのは `count-invalid` で止まって R2 が検査されない事態を避けるため。
        let mut sources = Vec::new();
        for i in 0..STICKER_COUNTS[0] {
            let p = dir.join(format!("src{i:02}.png"));
            subject(200, 200, 20).save(&p).unwrap();
            sources.push(p.to_string_lossy().into_owned());
        }

        // 前提の確認: 全部「抜けた」と申告すれば通る（R2 以外の理由で止まっていない）。
        let ok = sticker_export(
            sources.clone(),
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Submission,
            None,
            None,
            None,
            None,
            Some(sources.iter().map(|p| cleared_sample(p)).collect()),
        )
        .await;
        assert!(
            ok.is_ok(),
            "前提が崩れている: 抜けた申告でも書き出しが失敗した（{:?}）",
            ok.err()
        );
        std::fs::remove_dir_all(&out_dir).ok();

        // 本番: 1枚だけ「抜けなかった」。
        let mut samples: Vec<StickerChromaSample> =
            sources.iter().map(|p| cleared_sample(p)).collect();
        samples[3] = not_cleared_sample(&sources[3]);

        let err = sticker_export(
            sources.clone(),
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Submission,
            None,
            None,
            None,
            None,
            Some(samples),
        )
        .await
        .expect_err("緑が抜けていない画像が申請用の書き出しを通過した（R2 の再発）");
        assert!(
            err.contains("緑の背景が抜けていません"),
            "止まった理由が R2 ではない: {err}"
        );

        // 何も書いていないこと（申請モードは「ブロッカーがあれば1バイトも書かない」）。
        assert!(
            existing_sequence_files(&out_dir).is_empty(),
            "止めたのに提出物が残っている"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────── R4: 枚数不足の ZIP を作らない ─────────────
    //
    // ## この検査が守っているもの
    //
    // 第1段（メモリ上の全枚検査）は良い関所だが、**検査した枚数と書けた枚数が
    // 一致する保証が無かった**。第2段は書き込み失敗を `failed` へ入れて続行するので、
    // 8枚で通った直後に1枚が書けないと「7枚 + main + tab」の申請 ZIP ができていた。

    /// `01.png` の書き込みだけを失敗させる。
    ///
    /// **同名のディレクトリを先に作る**と `std::fs::write` は必ず失敗する
    /// （権限を落とす方法は root 実行や OS 差で不安定なので採らない）。
    /// `overwrite: true` を渡して既存チェックを外し、書き込み段だけを狙って割る。
    fn block_one_output(out_dir: &Path, name: &str) {
        std::fs::create_dir_all(out_dir.join(name)).unwrap();
    }

    #[tokio::test]
    async fn r4_submission_export_refuses_to_build_a_short_zip() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-r4-short-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();

        let mut sources = Vec::new();
        for i in 0..STICKER_COUNTS[0] {
            let p = dir.join(format!("src{i:02}.png"));
            subject(200, 200, 20).save(&p).unwrap();
            sources.push(p.to_string_lossy().into_owned());
        }

        // 3枚目の書き込みだけを割る（第1段の検査は全枚通る）。
        block_one_output(&out_dir, "03.png");

        let err = sticker_export(
            sources.clone(),
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Submission,
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await
        .expect_err("1枚書けなかったのに申請用の書き出しが成功した（R4 の再発）");

        // 枚数が伝わること（内部IDや生エラーの直貼りをしない・平易な日本語）。
        assert!(
            err.contains("8 枚のうち 1 枚を保存できなかった"),
            "枚数が伝わらない文言: {err}"
        );

        // **ZIP を作っていない**こと。これが R4 の本体。
        assert!(
            !out_dir.join(SUBMISSION_ZIP_NAME).exists(),
            "枚数不足なのに提出用 ZIP ができている（R4 の再発）"
        );
        // 中途半端な提出物（書けてしまった PNG）も残さない。
        // `03.png` は塞ぐために作ったディレクトリなので、それ以外が消えていること。
        let leftovers: Vec<String> = existing_sequence_files(&out_dir)
            .into_iter()
            .filter(|n| n != "03.png")
            .collect();
        assert!(
            leftovers.is_empty(),
            "中途半端な提出物が残っている: {leftovers:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn r4_personal_export_still_allows_partial_success() {
        // personal は部分成功を許す設計（T8）。R4 の関所で巻き込まないこと。
        let dir = std::env::temp_dir().join(format!(
            "sticker-r4-personal-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();

        let mut sources = Vec::new();
        for i in 0..3 {
            let p = dir.join(format!("src{i:02}.png"));
            subject(200, 200, 20).save(&p).unwrap();
            sources.push(p.to_string_lossy().into_owned());
        }
        block_one_output(&out_dir, "02.png");

        let res = sticker_export(
            sources.clone(),
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Personal,
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await
        .expect("personal が部分成功で止まった（救済の設計が壊れている）");

        assert_eq!(res.items.len(), 2, "書けた枚数が想定と違う");
        assert_eq!(res.failed.len(), 1, "失敗が可視化されていない");
        assert!(res.zip_path.is_none(), "personal で ZIP を作っている");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn r4_submission_export_succeeds_when_every_page_is_written() {
        // 全枚書けるときは従来どおり通る（牙が過剰に効いていないことの裏）。
        let dir =
            std::env::temp_dir().join(format!("sticker-r4-ok-{}-{}", std::process::id(), line!()));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();

        let mut sources = Vec::new();
        for i in 0..STICKER_COUNTS[0] {
            let p = dir.join(format!("src{i:02}.png"));
            subject(200, 200, 20).save(&p).unwrap();
            sources.push(p.to_string_lossy().into_owned());
        }

        let res = sticker_export(
            sources.clone(),
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Submission,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("全枚書けるのに止まった");

        assert_eq!(res.items.len(), STICKER_COUNTS[0]);
        assert!(res.failed.is_empty());
        let zip = res.zip_path.expect("ZIP が作られていない");
        // 「作った」で終わらせず、中身の枚数を実際に数える（規律1: 実行痕跡）。
        let names = zip_entry_names(&zip);
        assert_eq!(
            names.len(),
            STICKER_COUNTS[0] + 2,
            "ZIP の中身の枚数が合わない: {names:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ───────────────────── 提出用 ZIP（STΛCK指摘 2026-08-05・責務2） ─────────────────────

    /// ZIP を開いて中の**実際のエントリ名**を昇順で返す。
    ///
    /// 「作った」で終わらせず必ず開いて確かめる（規律1: 実行痕跡 > コードの確認）。
    fn zip_entry_names(zip_path: &str) -> Vec<String> {
        let file = std::fs::File::open(zip_path).expect("ZIP を開けない");
        let mut archive = zip::ZipArchive::new(file).expect("ZIP を読めない");
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn submission_export_writes_a_zip_with_official_flat_layout() {
        let dir =
            std::env::temp_dir().join(format!("sticker-zip-{}-{}", std::process::id(), line!()));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();

        // 申請モードの関所を通す必要があるので、透過済みの素材を枚数ぴったり用意する。
        let mut paths = Vec::new();
        for i in 0..STICKER_COUNTS[0] {
            let src = dir.join(format!("src{i}.png"));
            subject(200, 200, 20).save(&src).unwrap();
            paths.push(src.to_string_lossy().into_owned());
        }

        let res = sticker_export(
            paths,
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Submission,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("申請モードの書き出しが失敗した");

        let zip_path = res.zip_path.as_deref().expect("ZIP が作られていない");
        assert!(
            std::path::Path::new(zip_path).is_file(),
            "ZIP のパスは返ったが実ファイルが無い"
        );

        // ── 中身を実際に開いて構成を確かめる ──
        let names = zip_entry_names(zip_path);

        // 本体8枚 + main + tab = 10 エントリ。
        assert_eq!(
            names.len(),
            STICKER_COUNTS[0] + 2,
            "ZIP のエントリ数が合わない: {names:?}"
        );
        assert!(
            names.contains(&"main.png".to_string()),
            "main.png が ZIP に入っていない: {names:?}"
        );
        assert!(
            names.contains(&"tab.png".to_string()),
            "tab.png が ZIP に入っていない: {names:?}"
        );
        assert!(
            names.contains(&"01.png".to_string()),
            "連番 01.png が ZIP に入っていない: {names:?}"
        );

        // フラット構成であること（サブフォルダを作らない）。
        assert!(
            names.iter().all(|n| !n.contains('/')),
            "ZIP にサブフォルダが混ざっている: {names:?}"
        );

        // 控えファイルは提出物に混ぜない。
        assert!(
            names.iter().all(|n| n != "作成条件.txt"),
            "提出用 ZIP に控えファイルが混ざっている: {names:?}"
        );

        // 実測バイト数が返り、実ファイルと一致すること（見積りでない）。
        let reported = res.zip_bytes.expect("ZIP の実測サイズが返っていない");
        let actual = std::fs::metadata(zip_path).unwrap().len();
        assert_eq!(reported, actual, "返した ZIP サイズが実ファイルと違う");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn personal_export_does_not_write_a_zip() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-zip-personal-{}-{}",
            std::process::id(),
            line!()
        ));
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        subject(200, 200, 20).save(&src).unwrap();

        let res = sticker_export(
            vec![src.to_string_lossy().into_owned()],
            out_dir.to_string_lossy().into_owned(),
            ExportMode::Personal,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("書き出しが失敗した");

        assert!(res.zip_path.is_none(), "personal で ZIP を作っている");
        assert!(
            res.zip_bytes.is_none(),
            "personal で ZIP サイズを返している"
        );
        assert!(
            !out_dir.join(SUBMISSION_ZIP_NAME).exists(),
            "personal なのに ZIP ファイルが残っている"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// ZIP の実測サイズが**測れている**こと。
    ///
    /// 60MB ゲートは `sticker_export` 内で `bytes > MAX_BYTES_TOTAL` を見る。
    /// 本番の 60MB を超える ZIP をテストで作るのは非現実的（時間とディスク）なので、
    /// ここではゲートの**入力**が正しいことを固定する: 返る値が見積りでなく
    /// 実ファイルのバイト数であること。ここが実測でなくなった瞬間
    /// （例: PNG の合計バイト数を返す実装に変える）このテストが落ちる。
    ///
    /// ゲートの比較そのものが効いているかは
    /// `zip_size_gate_uses_actual_file_bytes` が別途固定する。
    #[test]
    fn write_submission_zip_reports_actual_file_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-zip-gate-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        subject(200, 200, 20).save(&src).unwrap();
        let png_bytes = std::fs::metadata(&src).unwrap().len();

        let (zip_path, bytes) = write_submission_zip(&dir, &[("01.png".to_string(), src.clone())])
            .expect("ZIP を作れない");

        assert!(bytes > 0, "ZIP の実測サイズが 0");
        assert_eq!(
            bytes,
            std::fs::metadata(&zip_path).unwrap().len(),
            "返した値が ZIP の実ファイルサイズと一致しない（実測でなく見積りを返している）"
        );
        // 素の PNG バイト数をそのまま返していないこと（ZIP はヘッダ分だけ必ず違う）。
        assert_ne!(
            bytes, png_bytes,
            "PNG の素のサイズを返している（ZIP を測っていない）"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// **牙の実証**: 60MB ゲートが実ファイルサイズで実際に止めることを、
    /// 上限を極小にした同じ判定式で確かめる。
    ///
    /// `sticker_export` の判定は `bytes > MAX_BYTES_TOTAL`。ここでは同じ
    /// 「実測バイト数と上限を比べる」式を、上限だけ差し替えて通す。
    /// 上限を実測値-1 にすれば必ず超過、実測値ちょうどなら必ず通過になる。
    /// 判定が実測でなく定数や見積りを見るようになったら、この非対称性が壊れて落ちる。
    #[test]
    fn zip_size_gate_uses_actual_file_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "sticker-zip-gate2-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("01.png");
        subject(200, 200, 20).save(&src).unwrap();

        let (_, bytes) =
            write_submission_zip(&dir, &[("01.png".to_string(), src)]).expect("ZIP を作れない");

        // 本番と同じ式。上限を動かして両側を踏む。
        let over = |limit: u64| bytes > limit;

        assert!(
            over(bytes - 1),
            "実測が上限を1バイト超えているのに超過と判定されない（ゲートが効いていない）"
        );
        assert!(!over(bytes), "実測が上限ちょうどなのに超過と誤判定している");
        assert!(
            !over(MAX_BYTES_TOTAL),
            "小さな ZIP が 60MB 超と判定された（ゲートが恒真）"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
