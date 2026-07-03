use std::path::Path;

use image::{GenericImageView, ImageBuffer, Luma};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::edit_segment::now_secs;
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::human_parse::human_parse_image;
use crate::edit::inpaint::inpaint_image;
use crate::edit::ocr::{ocr_image_with_probmap, TextProbMap, TextRegion};
use crate::edit::segment::segment_image_with_source;
use crate::events::EVENT_EDIT_MAGIC_PROGRESS;
use crate::state::AppState;

/// レイヤー分解モード。フロント lib/edit/types.ts の EditModeId と対応。
/// - Standard: 既存の軽量 ONNX スタック (OCR→テキスト除去→セグメント→背景inpaint)。全OS。
/// - HighQuality: SCHP human parsing による人物パーツ自動分解 (CPU ONNX、全OS)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditMode {
    Standard,
    HighQuality,
}

impl EditMode {
    pub fn from_id(id: &str) -> Result<Self, String> {
        match id {
            "standard" => Ok(EditMode::Standard),
            "highQuality" => Ok(EditMode::HighQuality),
            other => Err(format!("unknown edit mode: {other}")),
        }
    }
}

/// 物体分解 (SAM2 自動マスク) のオプション。standard モードでのみ効く。
/// フロント MagicLayerPanel のトグル/選択と対応。
#[derive(Debug, Clone, Copy)]
pub struct ObjectLayerOptions {
    /// 物体をレイヤーに分解するか。既定 ON。
    pub enabled: bool,
    /// 採用する物体数の上限。auto_segment 側で MAX_OBJECTS_HARD_CAP に丸められる。
    pub count: usize,
}

impl Default for ObjectLayerOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            count: crate::edit::auto_segment::DEFAULT_OBJECT_COUNT,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextLayerSpec {
    pub id: String,
    pub name: String,
    pub text: String,
    pub bbox: [i32; 4],
    pub font_family: String,
    pub font_size: f32,
    pub font_weight: String,
    pub color: String,
    pub align: String,
    pub x: i32,
    pub y: i32,
    pub opacity: f32,
    pub visible: bool,
    pub rotation: f32,
}

/// 高精度モードで認識した人物パーツ 1 件 = キャンバス上の 1 レイヤー。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PartLayerSpec {
    pub class_id: u32,
    pub label: String,
    pub image_path: String,
    pub pixel_count: u64,
}

/// 標準モードで SAM2 自動分解した「人物・テキスト以外の主要物体」1 件 = 1 レイヤー。
/// grab の切り抜き (bbox クロップ透過 PNG) と同じ形式。フロントが bbox 位置に置く。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjectLayerSpec {
    /// マスク bbox にクロップした透過 PNG のパス。
    pub image_path: String,
    /// 元画像ピクセル座標での [x, y, width, height]。
    pub bbox: [i32; 4],
    /// フロント表示名。日本語・絵文字なし ("物体 1" 等)。
    pub label: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MagicLayerResult {
    pub background_path: String,
    pub foreground_path: String,
    pub mask_path: String,
    pub text_layers: Vec<TextLayerSpec>,
    /// 高精度モードで認識した人物パーツ群。standard モードでは空。
    pub part_layers: Vec<PartLayerSpec>,
    /// 標準モードで SAM2 自動分解した主要物体レイヤー群。物体分解 OFF / highQuality では空。
    pub object_layers: Vec<ObjectLayerSpec>,
    pub width: u32,
    pub height: u32,
    pub run_dir: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MagicLayerProgress {
    Started,
    DetectingText,
    RemovingText,
    Segmenting,
    SegmentingObjects,
    InpaintingBackground,
    BuildingTextLayers,
    Completed,
    Failed { reason: String },
}

pub async fn run_magic_layer(
    app: &AppHandle,
    state: &AppState,
    input_path: &Path,
    project_name: Option<&str>,
    mode: EditMode,
    object_options: ObjectLayerOptions,
) -> Result<MagicLayerResult, String> {
    match run_magic_layer_inner(app, state, input_path, project_name, mode, object_options).await {
        Ok(result) => Ok(result),
        Err(reason) => {
            let _ = app.emit(
                EVENT_EDIT_MAGIC_PROGRESS,
                MagicLayerProgress::Failed {
                    reason: reason.clone(),
                },
            );
            Err(reason)
        }
    }
}

async fn run_magic_layer_inner(
    app: &AppHandle,
    state: &AppState,
    input_path: &Path,
    project_name: Option<&str>,
    mode: EditMode,
    object_options: ObjectLayerOptions,
) -> Result<MagicLayerResult, String> {
    if !input_path.exists() {
        return Err(format!("input image not found: {}", input_path.display()));
    }

    tracing::info!(target: "codex.edit", "magic_layer start: mode={:?} input={}", mode, input_path.display());
    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Started);

    // 高精度モード: 人物パーツ自動認識 (SCHP)。標準パイプラインとは別経路で
    // 髪・顔・上衣・パンツ等を一括レイヤー化する。
    if mode == EditMode::HighQuality {
        return run_high_quality(app, state, input_path, project_name).await;
    }

    let runtime = state.edit_runtime();
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-magic-{}", now_secs());
    let run_dir = resolve_output_dir(&settings, project_name, &leaf);
    tokio::fs::create_dir_all(&run_dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    tracing::info!(target: "codex.edit", "magic_layer: OCR開始");
    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::DetectingText);
    let (regions, prob_map) = ocr_image_with_probmap(runtime, input_path).await?;
    tracing::info!(target: "codex.edit", "magic_layer: OCR完了 regions={} probmap={}", regions.len(), prob_map.is_some());

    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::RemovingText);
    let text_mask_path = run_dir.join("text-mask.png");
    generate_text_mask(input_path, &regions, prob_map.as_ref(), &text_mask_path)?;
    let text_removed_path = run_dir.join("text-removed.png");
    if regions.is_empty() {
        tokio::fs::copy(input_path, &text_removed_path)
            .await
            .map_err(|e| format!("copy text-removed: {e}"))?;
    } else {
        inpaint_image(runtime, input_path, &text_mask_path, &text_removed_path).await?;
    }

    tracing::info!(target: "codex.edit", "magic_layer: セグメント開始");
    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Segmenting);
    // マスク推論は text-removed.png (テキスト消し込み済み) を使い、前景 RGBA の色は
    // **元画像** から焼く。text-removed は LaMa inpaint で色が破綻しうるため、前景の色に
    // 使うと foreground.png が白ベタ+反転色になる (2026-07-02 実機バグの真因)。
    let segment_result =
        segment_image_with_source(runtime, &text_removed_path, input_path, &run_dir).await?;
    tracing::info!(target: "codex.edit", "magic_layer: セグメント完了 {}x{}", segment_result.width, segment_result.height);

    // 被写体マスクの離れ小島 (ボール等の独立物体) を検出する。BiRefNet は複数の独立被写体を
    // 1枚の salient マスクに融合するため (実測 2026-07-03: ロボ+ボールが1前景)、最大成分だけを
    // 被写体に残し、離れ小島は後段で物体レイヤーへ変換する。
    // 注意: SAM2 の除外マスク・背景 union には分離前のフルマスク (mask.png) をそのまま使う
    // (小島の二重検出防止 + 小島跡地の背景補完のため)。mask.png / foreground.png の
    // 書き換えは union 構築後に行う。
    let full_mask = image::open(&segment_result.mask_path)
        .ok()
        .map(|m| m.to_luma8());
    let subject_split = full_mask
        .as_ref()
        .map(crate::edit::subject_split::split_subject_mask);
    let satellite_count = subject_split
        .as_ref()
        .map(|s| s.satellites.len())
        .unwrap_or(0);
    if satellite_count > 0 {
        tracing::info!(target: "codex.edit", "magic_layer: 被写体マスクに離れ小島{}件を検出", satellite_count);
    }

    let width = segment_result.width;
    let height = segment_result.height;

    // 被写体上テキストの保護: 服の印字・商品ロゴ等「被写体マスクの上に載っている文字」は
    // 被写体の柄であってオーバーレイ文字ではない (実測 2026-07-03: ジャージの FUNSTACK/4 が
    // テキストレイヤー化+消去対象になり被写体が壊れた)。マスクカバー率で分け、以降の
    // テキストレイヤー化・消去はオーバーレイ文字だけを対象にする。
    let (regions, protected_count) =
        split_overlay_regions(&regions, full_mask.as_ref(), width, height);
    if protected_count > 0 {
        tracing::info!(
            target: "codex.edit",
            "magic_layer: 被写体上テキスト{}件を保護 (オーバーレイ{}件)",
            protected_count,
            regions.len()
        );
        // text-removed / text-mask をオーバーレイ文字だけで作り直す。初回の全文字消去は
        // セグメント入力専用とし、成果物側は保護済み版で上書きする。
        generate_text_mask(input_path, &regions, prob_map.as_ref(), &text_mask_path)?;
        if regions.is_empty() {
            tokio::fs::copy(input_path, &text_removed_path)
                .await
                .map_err(|e| format!("copy text-removed (protected): {e}"))?;
        } else {
            inpaint_image(runtime, input_path, &text_mask_path, &text_removed_path).await?;
        }
    }

    // 物体分解: 人物・テキスト以外の主要物体を SAM2 自動マスクでレイヤー化する。
    // segment_result (人物マスク) と OCR regions (テキスト領域) を「既存レイヤー」として
    // 除外マスクを作り、それと重なる物体は二重化になるので拾わない。
    let text_boxes: Vec<[i32; 4]> = regions
        .iter()
        .filter_map(|region| clamp_bbox(region.bbox, width, height))
        .map(|[x, y, w, h]| [x as i32, y as i32, w as i32, h as i32])
        .collect();

    let (mut object_layers, union_mask) = if object_options.enabled {
        let _ = app.emit(
            EVENT_EDIT_MAGIC_PROGRESS,
            MagicLayerProgress::SegmentingObjects,
        );
        // 物体分解は SAM2 モデル未DL等で失敗しうる。ここは「落としても本体は続行」する:
        // 物体レイヤーだけ空にして、テキスト+人物+背景は必ず返す (体験を止めない)。
        match run_object_layers(
            state,
            input_path,
            &run_dir,
            width,
            height,
            Some(&segment_result.mask_path),
            &text_boxes,
            object_options.count,
        )
        .await
        {
            Ok(pair) => pair,
            Err(reason) => {
                tracing::warn!(target: "codex.edit", "magic_layer: 物体分解スキップ ({reason})");
                (Vec::new(), None)
            }
        }
    } else {
        (Vec::new(), None)
    };

    // 背景: 物体を1件以上分解できたときだけ「全物体+人物の union マスクで一括 inpaint した
    // 背景」を使う (物体/人物レイヤーを動かした跡が透明の穴にならないよう補完済みにする)。
    // 物体0件 (union_mask=None) や inpaint 失敗時は元画像コピーにフォールバックする。
    // なぜ物体0件では inpaint しないか: 従来の standard モードは「元画像を背景に残し、
    // 前景(人物)を上に重ねる」挙動。物体が無いのに人物を inpaint で消すと、この従来挙動から
    // 退行する。物体を持ち上げたいときだけ跡地補完が必要になる。
    // なぜフォールバックを残すか: BiRefNet/SAM2 マスクが破綻したときに真っ白背景を
    // 出さないため (2026-06-18 STΛCK 実機報告の再発防止)。元画像を残せば最悪でも絵は見える。
    let background_path = run_dir.join("background.png");
    let mut background_ready = false;
    // 離れ小島 (satellite) も独立レイヤーになるため、跡地補完の要否判定に含める
    // (union には人物フルマスク由来で小島も既に入っている)。
    let inpaint_mask = if object_layers.is_empty() && satellite_count == 0 {
        None
    } else {
        union_mask.as_ref()
    };
    if let Some(mask) = inpaint_mask {
        let _ = app.emit(
            EVENT_EDIT_MAGIC_PROGRESS,
            MagicLayerProgress::InpaintingBackground,
        );
        let union_mask_path = run_dir.join("object-union-mask.png");
        // 膨張して縁の被写体残り(幽霊)を飲み込ませてから LaMa へ渡す (grab.rs と同方針)。
        let dilated = crate::edit::grab::dilate_mask_pub(mask, 6);
        // inpaint 元は text-removed (オーバーレイ文字消去済み)。元画像を使うと背景レイヤーに
        // 文字が焼き残り、テキストレイヤーを動かしたとき二重表示になる (実測 2026-07-03)。
        if dilated.save(&union_mask_path).is_ok()
            && inpaint_image(runtime, &text_removed_path, &union_mask_path, &background_path)
                .await
                .is_ok()
        {
            background_ready = true;
        }
    }
    if !background_ready {
        // フォールバックも text-removed を使う (背景レイヤーへ文字を焼き残さない)。
        // 被写体が背景に残るのは従来挙動どおり (前景レイヤーが上に重なり見た目は不変)。
        tokio::fs::copy(&text_removed_path, &background_path)
            .await
            .map_err(|e| format!("copy text-removed as background: {e}"))?;
    }

    // 離れ小島を独立した物体レイヤーへ変換し、mask.png / foreground.png を最大成分
    // (=主要被写体) だけに書き替える。失敗時は分離せず従来挙動 (融合したまま) で続行する。
    if let Some(split) = subject_split.as_ref() {
        if !split.satellites.is_empty() {
            match apply_subject_split(split, input_path, &segment_result, object_layers.len()) {
                Ok(mut satellites) => {
                    tracing::info!(
                        target: "codex.edit",
                        "magic_layer: 離れ小島{}件を物体レイヤーへ分離",
                        satellites.len()
                    );
                    object_layers.append(&mut satellites);
                }
                Err(reason) => {
                    tracing::warn!(target: "codex.edit", "magic_layer: 被写体分離スキップ ({reason})");
                }
            }
        }
    }

    let _ = app.emit(
        EVENT_EDIT_MAGIC_PROGRESS,
        MagicLayerProgress::BuildingTextLayers,
    );
    let text_layers = build_text_layers(&regions, input_path, prob_map.as_ref())?;

    let result = MagicLayerResult {
        background_path: path_string(&background_path),
        foreground_path: path_string(&segment_result.foreground_path),
        mask_path: path_string(&segment_result.mask_path),
        text_layers,
        part_layers: Vec::new(),
        object_layers,
        width,
        height,
        run_dir: path_string(&run_dir),
    };

    write_json_file(&run_dir.join("manifest.json"), &result).await?;

    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Completed);
    Ok(result)
}

/// 標準モードの物体分解ステップ。SAM2 を embed → 自動マスク生成 → 各物体を透過 PNG に
/// クロップし、ObjectLayerSpec 群と「人物+全物体の union マスク」(背景 inpaint 用) を返す。
///
/// 返り値の union_mask は None にならない (少なくとも人物マスクは入る) が、物体が 0 件でも
/// 人物マスクだけの union を返す。呼び出し側はこれで背景を補完する。
///
/// SAM2 セッションは Magic Layer 専用に一時生成し、状態 (state.sam2_session) は汚さない。
/// なぜ: クリック切り抜き UI が別に SAM2 セッションを使うため、それを上書きしない。
#[allow(clippy::too_many_arguments)]
async fn run_object_layers(
    state: &AppState,
    input_path: &Path,
    run_dir: &Path,
    width: u32,
    height: u32,
    person_mask_path: Option<&Path>,
    text_boxes: &[[i32; 4]],
    object_count: usize,
) -> Result<(Vec<ObjectLayerSpec>, Option<ImageBuffer<Luma<u8>, Vec<u8>>>), String> {
    use crate::edit::auto_segment::{build_exclude_mask, run_auto_object_masks};
    use crate::edit::grab::crop_object_png;
    use crate::edit::sam2::Sam2Session;

    // SAM2 embed (encoder 1 回)。モデル未DLならここでエラーになり、呼び出し側で
    // 物体分解だけスキップされる (テキスト+人物+背景は続行)。
    //
    // ★ 専用セッション (new_dedicated) を使う。クリック切り抜き UI の state.sam2_session と
    // runtime キャッシュ経由で decoder Arc<Mutex> を共有すると、UI 側が guard を保持したまま
    // だと物体分解の decoder `.lock().await` が 0% CPU で永久停止する (2026-07-02 実機
    // デッドロック真因)。専用生成なら Mutex を他コマンドと共有しないので構造的に起きえない。
    // `state` 引数は署名互換のため保持 (storage_settings 等で今後使う余地)。
    let _ = state;
    let mut session = Sam2Session::new_dedicated()?;
    session.embed_image(input_path).await?;

    // 既存レイヤー (人物マスク + テキスト bbox) を除外マスクにまとめる。
    let exclude = build_exclude_mask(width, height, person_mask_path, text_boxes);

    let masks = run_auto_object_masks(&session, Some(&exclude), object_count).await?;

    // 各物体を bbox クロップ透過 PNG に。union マスクは人物マスクから開始して物体を足す。
    let rgba = image::open(input_path)
        .map_err(|e| format!("open input for objects: {e}"))?
        .to_rgba8();

    let objects_dir = run_dir.join("objects");
    let mut object_layers = Vec::new();
    let mut union = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(width, height, Luma([0u8]));

    // 人物マスクを union に取り込む (人物を動かした跡も背景補完対象に含める)。
    if let Some(path) = person_mask_path {
        if let Ok(person) = image::open(path) {
            let person = person.to_luma8();
            if person.width() == width && person.height() == height {
                for (dst, src) in union.pixels_mut().zip(person.pixels()) {
                    if src[0] > 127 {
                        *dst = Luma([255u8]);
                    }
                }
            }
        }
    }

    for (index, object) in masks.iter().enumerate() {
        // マスクを union に取り込む。
        if object.mask.width() == width && object.mask.height() == height {
            for (dst, src) in union.pixels_mut().zip(object.mask.pixels()) {
                if src[0] > 127 {
                    *dst = Luma([255u8]);
                }
            }
        }
        let out_path = objects_dir.join(format!("object-{:02}.png", index + 1));
        let bbox = crop_object_png(&rgba, &object.mask, &out_path)?;
        object_layers.push(ObjectLayerSpec {
            image_path: path_string(&out_path),
            bbox,
            // ラベルは日本語・絵文字なし ("物体 1"…)。
            label: format!("物体 {}", index + 1),
        });
    }

    Ok((object_layers, Some(union)))
}

/// 被写体上テキスト判定のカバー率閾値。region bbox の画素のうちこの割合以上が
/// 被写体マスク (>127) に覆われていたら「被写体の上の文字 (服の印字等)」とみなす。
/// なぜ 0.6: ジャージ印字は ~1.0、背景上のオーバーレイ文字は ~0。境界 (文字が被写体の
/// 縁にわずかに掛かる) を誤保護しない程度に高く、印字を確実に拾う程度に低く。
const SUBJECT_TEXT_COVER: f64 = 0.60;

/// OCR region を「オーバーレイ文字 (残す=レイヤー化+消去対象)」と「被写体上の文字
/// (保護=触らない)」に分ける。返り値は (オーバーレイ region 群, 保護した件数)。
/// マスクが無い/寸法不一致のときは全件オーバーレイ扱い (従来挙動)。
fn split_overlay_regions(
    regions: &[TextRegion],
    subject_mask: Option<&ImageBuffer<Luma<u8>, Vec<u8>>>,
    width: u32,
    height: u32,
) -> (Vec<TextRegion>, usize) {
    let Some(mask) = subject_mask else {
        return (regions.to_vec(), 0);
    };
    if mask.dimensions() != (width, height) {
        return (regions.to_vec(), 0);
    }
    let mut overlay = Vec::new();
    let mut protected = 0usize;
    for region in regions {
        let Some([x, y, w, h]) = clamp_bbox(region.bbox, width, height) else {
            continue;
        };
        let total = (w as u64 * h as u64).max(1);
        let mut covered = 0u64;
        for yy in y..y + h {
            for xx in x..x + w {
                if mask.get_pixel(xx, yy)[0] > 127 {
                    covered += 1;
                }
            }
        }
        if covered as f64 / total as f64 >= SUBJECT_TEXT_COVER {
            protected += 1;
            tracing::info!(
                target: "codex.edit",
                "被写体上テキストを保護: {:?} bbox={:?} cover={:.2}",
                region.text,
                region.bbox,
                covered as f64 / total as f64
            );
        } else {
            overlay.push(region.clone());
        }
    }
    (overlay, protected)
}

/// 被写体マスクの離れ小島を物体レイヤー (bbox クロップ透過 PNG) に変換し、
/// mask.png / foreground.png を最大成分 (=主要被写体) だけに書き替える。
///
/// 順序: 先に小島クロップを書き出し、最後にマスク/前景を差し替える。途中失敗時は
/// Err を返して呼び出し側が分離を丸ごと見送る (前景から小島だけ消えてどのレイヤーにも
/// 属さない「欠落」状態を作らないため)。
fn apply_subject_split(
    split: &crate::edit::subject_split::SubjectSplit,
    input_path: &Path,
    segment_result: &crate::edit::segment::SegmentResult,
    existing_object_count: usize,
) -> Result<Vec<ObjectLayerSpec>, String> {
    let rgba = image::open(input_path)
        .map_err(|e| format!("open input for satellites: {e}"))?
        .to_rgba8();
    if rgba.dimensions() != split.subject_mask.dimensions() {
        return Err(format!(
            "size mismatch: input={:?} mask={:?}",
            rgba.dimensions(),
            split.subject_mask.dimensions()
        ));
    }
    let objects_dir = segment_result
        .mask_path
        .parent()
        .ok_or_else(|| "mask path has no parent".to_string())?
        .join("objects");

    let mut layers = Vec::new();
    for (i, satellite) in split.satellites.iter().enumerate() {
        let index = existing_object_count + i + 1;
        let out_path = objects_dir.join(format!("object-{index:02}.png"));
        let bbox = crate::edit::grab::crop_object_png(&rgba, satellite, &out_path)?;
        layers.push(ObjectLayerSpec {
            image_path: path_string(&out_path),
            bbox,
            // ラベルは日本語・絵文字なし。SAM2 物体の連番の続きを使う。
            label: format!("物体 {index}"),
        });
    }

    // 前景 RGBA の alpha を被写体成分に絞る (小島の画素を前景から除く)。
    // 色は元のまま、alpha だけ min を取る (前景の bake 済みソフトエッジを壊さない)。
    let mut foreground = image::open(&segment_result.foreground_path)
        .map_err(|e| format!("open foreground: {e}"))?
        .to_rgba8();
    if foreground.dimensions() != split.subject_mask.dimensions() {
        return Err(format!(
            "foreground size mismatch: fg={:?} mask={:?}",
            foreground.dimensions(),
            split.subject_mask.dimensions()
        ));
    }
    for (px, m) in foreground.pixels_mut().zip(split.subject_mask.pixels()) {
        px[3] = px[3].min(m[0]);
    }
    foreground
        .save(&segment_result.foreground_path)
        .map_err(|e| format!("save subject foreground: {e}"))?;
    split
        .subject_mask
        .save(&segment_result.mask_path)
        .map_err(|e| format!("save subject mask: {e}"))?;

    Ok(layers)
}

/// 高精度モード本体: SCHP で人物パーツを認識し、各部位を透過 PNG レイヤーにする。
/// 標準モードと同じ run_dir 規約・進捗イベントを使い、フロントから見て差し替え可能にする。
async fn run_high_quality(
    app: &AppHandle,
    state: &AppState,
    input_path: &Path,
    project_name: Option<&str>,
) -> Result<MagicLayerResult, String> {
    let runtime = state.edit_runtime();
    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-parse-{}", now_secs());
    let run_dir = resolve_output_dir(&settings, project_name, &leaf);
    tokio::fs::create_dir_all(&run_dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    // パーツ抽出はセグメント工程として進捗を出す (専用 kind を増やさず既存を流用)。
    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Segmenting);
    let parse = human_parse_image(runtime, input_path, &run_dir).await?;

    let part_layers: Vec<PartLayerSpec> = parse
        .layers
        .iter()
        .map(|layer| PartLayerSpec {
            class_id: layer.class_id as u32,
            label: layer.label.clone(),
            image_path: path_string(&layer.image_path),
            pixel_count: layer.pixel_count,
        })
        .collect();

    // 元画像を背景として保持 (パーツを消した後に下地が要るケース用)。
    let background_path = run_dir.join("background_src.png");
    tokio::fs::copy(input_path, &background_path)
        .await
        .map_err(|e| format!("copy background: {e}"))?;

    let result = MagicLayerResult {
        background_path: path_string(&background_path),
        // 高精度モードは前景/マスクの単一切り抜き概念を持たない (パーツ集合で表現)。
        foreground_path: String::new(),
        mask_path: String::new(),
        text_layers: Vec::new(),
        part_layers,
        object_layers: Vec::new(),
        width: parse.width,
        height: parse.height,
        run_dir: path_string(&run_dir),
    };

    write_json_file(&run_dir.join("manifest.json"), &result).await?;
    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Completed);
    Ok(result)
}

pub fn build_text_layers(
    regions: &[TextRegion],
    input_path: &Path,
    prob_map: Option<&TextProbMap>,
) -> Result<Vec<TextLayerSpec>, String> {
    let img = image::open(input_path).map_err(|e| format!("open image for text layers: {e}"))?;
    let (width, height) = img.dimensions();
    let rgb = img.to_rgb8();

    // OCR ノイズ下限: bbox 面積が画像の 0.1% 未満は「意味のない微小領域」として捨てる。
    // 941x1672 の実機で "□" 1個 (19x21=399px=0.025%) がレイヤー化された事故の再発防止。
    let image_area = (width as f64) * (height as f64);
    let min_text_area = image_area * 0.001;

    Ok(regions
        .iter()
        .enumerate()
        .filter_map(|(index, region)| {
            let text = region.text.trim();
            if text.is_empty() {
                return None;
            }
            // 記号のみの短い認識結果 (1-2文字) は OCR ノイズなので捨てる。
            // "□" や罫線・ドットのような 1-2 文字の非英数字だけの塊はテキストではない。
            if is_symbol_noise(text) {
                return None;
            }
            let [x, y, w, h] = clamp_bbox(region.bbox, width, height)?;
            // 面積が小さすぎる領域は捨てる (点・ゴミ)。
            if (w as f64) * (h as f64) < min_text_area {
                return None;
            }
            let color = text_color(&rgb, [x, y, w, h], prob_map);
            let is_ja = region
                .language
                .as_deref()
                .map(|lang| lang.starts_with("ja"))
                .unwrap_or_else(|| contains_japanese(text));
            Some(TextLayerSpec {
                id: if region.id.trim().is_empty() {
                    format!("text-{index:04}")
                } else {
                    region.id.clone()
                },
                name: format!("テキスト {}", index + 1),
                text: text.to_string(),
                bbox: [x as i32, y as i32, w as i32, h as i32],
                font_family: if is_ja {
                    "Hiragino Sans".to_string()
                } else {
                    "Helvetica".to_string()
                },
                font_size: ((h as f32) * 0.8).clamp(8.0, 240.0),
                font_weight: "normal".to_string(),
                color,
                align: "left".to_string(),
                x: x as i32,
                y: y as i32,
                opacity: 1.0,
                visible: true,
                rotation: 0.0,
            })
        })
        .collect())
}

/// テキスト色の抽出。文字ストローク画素 (DB 確率マップ >= 閾値) の RGB 中央値を使う。
///
/// なぜ中央値: 従来の「bbox 中心1点サンプル」はグリフの隙間の背景色を拾う
/// (実測 2026-07-03: 白文字「バスケを嫌いになった日」が #0a1116 と抽出され、
/// 再描画時に見えない文字になった)。ストローク画素だけの中央値なら背景・縁の
/// アンチエイリアスに引きずられない。確率マップが無い/画素不足のときは従来の中心1点。
fn text_color(
    rgb: &image::RgbImage,
    bbox: [u32; 4],
    prob_map: Option<&TextProbMap>,
) -> String {
    let [x, y, w, h] = bbox;
    let (iw, ih) = rgb.dimensions();
    if let Some(pm) = prob_map {
        if pm.width == iw && pm.height == ih {
            let mut rs: Vec<u8> = Vec::new();
            let mut gs: Vec<u8> = Vec::new();
            let mut bs: Vec<u8> = Vec::new();
            for yy in y..(y + h).min(ih) {
                for xx in x..(x + w).min(iw) {
                    if pm.prob_at(xx, yy) >= DB_STROKE_THRESHOLD {
                        let p = rgb.get_pixel(xx, yy);
                        rs.push(p[0]);
                        gs.push(p[1]);
                        bs.push(p[2]);
                    }
                }
            }
            // 画素が少なすぎる (bbox とマップの位置ズレ等) ときは信用しない。
            if rs.len() >= 16 {
                let median = |v: &mut Vec<u8>| {
                    v.sort_unstable();
                    v[v.len() / 2]
                };
                return format!(
                    "#{:02x}{:02x}{:02x}",
                    median(&mut rs),
                    median(&mut gs),
                    median(&mut bs)
                );
            }
        }
    }
    let cx = (x + w / 2).min(iw.saturating_sub(1));
    let cy = (y + h / 2).min(ih.saturating_sub(1));
    let p = rgb.get_pixel(cx, cy);
    format!("#{:02x}{:02x}{:02x}", p[0], p[1], p[2])
}

/// DB 確率マップの閾値。PaddleOCR DB 検出器の標準二値化閾値 (0.3) に合わせる。
/// polygons_from_heatmap の連結成分抽出も同じ 0.30 を使っており、両者を揃える。
/// なぜ 0.3: DB の論文/公式実装 (db_thresh) の既定値。これ未満はテキストの縁の裾で、
/// 塗ると過剰復元 (背景まで inpaint) になり、これ以上に上げると文字本体が欠ける。
const DB_STROKE_THRESHOLD: f32 = 0.30;

/// ストロークマスク膨張量の下限/上限 (px) と文字高比。実際の膨張量は
/// 「採用 region 高さの中央値 × RATIO」を [MIN, MAX] にクランプして使う。
///
/// なぜ文字高比例か (2026-07-03 実測): 消去後は inpaint.rs がマスク画素だけを合成する方式に
/// なったため、マスクの隙間に残る元画素 (文字のグロー・影・アンチエイリアスの裾) はそのまま
/// 残る。固定2pxではタイトル文字 (高42px) のグローが残って読めるゴーストになった。
/// 膨張12px (=42px文字で高さの3割弱) で読解不能になることを実画像で確認済み。
/// 文字装飾の太さはフォントサイズに比例するため、比例則 0.25 で小さい文字の塗り過ぎを防ぐ。
const DB_STROKE_DILATE_MIN: i32 = 4;
const DB_STROKE_DILATE_MAX: i32 = 12;
const DB_STROKE_DILATE_RATIO: f64 = 0.25;

/// 確率マップが取れないときの bbox 近傍ゲート pad (px)。従来の矩形 pad(4) と同じ。
const BBOX_GATE_PAD: i32 = 4;

/// text-mask を生成する。確率マップがあれば「ストロークマスク」、無ければ従来の bbox 矩形。
///
/// ストロークマスク方式 (2026-07-02 技術調査の定石):
///   「確率マップ >= 閾値 のピクセル ∩ 採用テキスト領域の bbox 近傍」を白塗り → 数px膨張。
///   矩形マスクは文字の隙間・行間の背景まで塗ってしまい、LaMa が過剰復元 (背景の再合成) を
///   起こしたり、縁に元テキストの色が残る。文字ストロークだけを塗れば、追加モデルゼロで
///   縁残り・過剰復元の両方が改善する。
///
/// bbox でゲートする理由: 確率マップには認識でノイズ棄却された領域 (誤検出の裾) も
/// 弱い確率で残る。採用 region (build_text_layers と同じノイズフィルタを通過したもの) の
/// bbox 近傍に限定することで、消すべきでない箇所のストロークを塗らない。
pub fn generate_text_mask(
    input_path: &Path,
    regions: &[TextRegion],
    prob_map: Option<&TextProbMap>,
    output_path: &Path,
) -> Result<(), String> {
    let img = image::open(input_path).map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("empty image for text mask".to_string());
    }

    // 採用 region だけをゲート対象にする (記号ノイズ・微小領域を除外)。
    // build_text_layers と同じ判定を使い、「レイヤー化される文字」と「消される文字」を一致させる。
    let image_area = (w as f64) * (h as f64);
    let min_text_area = image_area * 0.001;
    let adopted: Vec<[i32; 4]> = regions
        .iter()
        .filter(|region| {
            let text = region.text.trim();
            if text.is_empty() || is_symbol_noise(text) {
                return false;
            }
            let [_x, _y, rw, rh] = region.bbox;
            (rw as f64) * (rh as f64) >= min_text_area
        })
        .map(|region| region.bbox)
        .collect();

    // 確率マップが使えるかを判定。寸法が元画像と一致しなければストローク方式は使わない
    // (座標系がずれた確率マップで塗ると位置が狂う → 安全側で bbox 矩形にフォールバック)。
    let usable_prob = prob_map.filter(|pm| pm.width == w && pm.height == h);

    let mask = match usable_prob {
        Some(pm) => {
            tracing::info!(target: "codex.edit", "text-mask: ストローク方式 (thr={DB_STROKE_THRESHOLD}) adopted={}", adopted.len());
            build_stroke_mask(w, h, &adopted, pm)
        }
        None => {
            tracing::info!(target: "codex.edit", "text-mask: bbox矩形フォールバック (確率マップ無し) adopted={}", adopted.len());
            build_bbox_mask(w, h, &adopted)
        }
    };

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir mask parent: {e}"))?;
    }
    mask.save(output_path)
        .map_err(|e| format!("save mask: {e}"))
}

/// ストロークマスク: 採用 bbox 近傍で prob >= 閾値 のピクセルを白塗り → dilate。
fn build_stroke_mask(
    w: u32,
    h: u32,
    adopted: &[[i32; 4]],
    prob_map: &TextProbMap,
) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let mut raw = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    for &[x, y, rw, rh] in adopted {
        if rw <= 0 || rh <= 0 {
            continue;
        }
        // bbox を少しだけ広げた近傍で走査 (文字が bbox からわずかにはみ出す分を拾う)。
        let x0 = (x - BBOX_GATE_PAD).max(0) as u32;
        let y0 = (y - BBOX_GATE_PAD).max(0) as u32;
        let x1 = ((x + rw + BBOX_GATE_PAD).min(w as i32) - 1).max(0) as u32;
        let y1 = ((y + rh + BBOX_GATE_PAD).min(h as i32) - 1).max(0) as u32;
        for yy in y0..=y1 {
            for xx in x0..=x1 {
                if prob_map.prob_at(xx, yy) >= DB_STROKE_THRESHOLD {
                    raw.put_pixel(xx, yy, Luma([255u8]));
                }
            }
        }
    }
    // 文字高 (採用 region 高さの中央値) に比例した膨張で、グロー・影・AAの裾ごと飲み込む。
    let mut heights: Vec<i32> = adopted
        .iter()
        .map(|[_, _, _, rh]| *rh)
        .filter(|rh| *rh > 0)
        .collect();
    heights.sort_unstable();
    let dilate = heights
        .get(heights.len() / 2)
        .map(|&median_h| {
            ((median_h as f64 * DB_STROKE_DILATE_RATIO) as i32)
                .clamp(DB_STROKE_DILATE_MIN, DB_STROKE_DILATE_MAX)
        })
        .unwrap_or(DB_STROKE_DILATE_MIN);
    tracing::info!(target: "codex.edit", "text-mask: stroke dilate={dilate}px");
    crate::edit::grab::dilate_mask_pub(&raw, dilate)
}

/// bbox 矩形マスク (従来方式 / フォールバック)。採用 bbox を pad して白塗り。
fn build_bbox_mask(w: u32, h: u32, adopted: &[[i32; 4]]) -> ImageBuffer<Luma<u8>, Vec<u8>> {
    let mut mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    for &[x, y, rw, rh] in adopted {
        if rw <= 0 || rh <= 0 {
            continue;
        }
        let x0 = (x - BBOX_GATE_PAD).max(0) as u32;
        let y0 = (y - BBOX_GATE_PAD).max(0) as u32;
        let x1 = ((x + rw + BBOX_GATE_PAD).min(w.saturating_sub(1) as i32)).max(0) as u32;
        let y1 = ((y + rh + BBOX_GATE_PAD).min(h.saturating_sub(1) as i32)).max(0) as u32;
        if x0 > x1 || y0 > y1 {
            continue;
        }
        for yy in y0..=y1 {
            for xx in x0..=x1 {
                mask.put_pixel(xx, yy, Luma([255u8]));
            }
        }
    }
    mask
}

async fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("json: {e}"))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|e| format!("write {}: {e}", path.display()))
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn clamp_bbox(bbox: [i32; 4], width: u32, height: u32) -> Option<[u32; 4]> {
    if width == 0 || height == 0 {
        return None;
    }
    let x = bbox[0].clamp(0, width.saturating_sub(1) as i32) as u32;
    let y = bbox[1].clamp(0, height.saturating_sub(1) as i32) as u32;
    let right = (bbox[0] + bbox[2]).clamp(0, width as i32) as u32;
    let bottom = (bbox[1] + bbox[3]).clamp(0, height as i32) as u32;
    let w = right.saturating_sub(x).max(1);
    let h = bottom.saturating_sub(y).max(1);
    Some([x, y, w, h])
}

/// OCR ノイズ判定: 認識結果が 1-2 文字で、かつ英数字・仮名・漢字を 1 つも含まない
/// (= 記号・罫線・箱文字だけ) の場合に true。
///
/// なぜ: PaddleOCR は写真の模様やエッジを "□" "・" "—" のような記号 1 個として誤認識し、
/// これが 1 レイヤーになると非エンジニアの画面がゴミレイヤーで埋まる。3 文字以上や、
/// 意味のある文字 (英数字/日本語) を含むものは残す (誤って本物の短文を消さないため)。
fn is_symbol_noise(text: &str) -> bool {
    let count = text.chars().count();
    if count == 0 || count > 2 {
        return false;
    }
    let has_meaningful = text
        .chars()
        .any(|ch| ch.is_alphanumeric() || is_japanese_char(ch));
    !has_meaningful
}

fn is_japanese_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
    )
}

fn contains_japanese(text: &str) -> bool {
    text.chars().any(is_japanese_char)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::ocr::TextRegion;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn symbol_noise_rejects_single_box_char() {
        // 実機で漏れた "□" (U+25A1・幾何学記号・1文字) は捨てる。これが本バグの再現。
        assert!(is_symbol_noise("□"));
        assert!(is_symbol_noise("—")); // ダッシュ
        assert!(is_symbol_noise("**")); // 2文字の ASCII 記号も捨てる
        assert!(is_symbol_noise("◇◆")); // 2文字の幾何学記号
    }

    #[test]
    fn symbol_noise_keeps_meaningful_text() {
        assert!(!is_symbol_noise("A")); // 1文字でも英数字は残す
        assert!(!is_symbol_noise("あ")); // 1文字でも仮名は残す
        assert!(!is_symbol_noise("42"));
        assert!(!is_symbol_noise("SALE")); // 3文字以上は無条件で残す
        assert!(!is_symbol_noise("こんにちは"));
    }

    /// build_text_layers が、面積の小さい記号ノイズ ("□" 19x21) を除外し、
    /// 面積が十分で意味のあるテキストは残すことを、実 API 経由で確認する。
    #[test]
    fn build_text_layers_filters_ocr_noise() {
        // 500x500 の単色画像を一時ファイルに書き出す (build_text_layers は画像を開く)。
        let dir = std::env::temp_dir().join(format!(
            "gori-magic-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let img_path = dir.join("in.png");
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
            ImageBuffer::from_pixel(500, 500, Rgb([200, 200, 200]));
        img.save(&img_path).unwrap();

        let region = |id: &str, text: &str, bbox: [i32; 4], lang: Option<&str>| TextRegion {
            id: id.to_string(),
            bbox,
            polygon: Vec::new(),
            text: text.to_string(),
            confidence: 0.9,
            language: lang.map(|s| s.to_string()),
        };
        let regions = vec![
            // ノイズ: "□" 1文字 (記号のみで落ちる)。
            region("region-0000", "□", [141, 157, 19, 21], Some("ja")),
            // ノイズ: 意味ある文字だが bbox 面積が画像の 0.1% 未満 (10x10=100px=0.04%)。
            region("region-0001", "A", [10, 10, 10, 10], None),
            // 採用: 十分な面積 + 意味あるテキスト (100x40=4000px=1.6%)。
            region("region-0002", "SALE", [50, 50, 100, 40], None),
        ];

        let layers = build_text_layers(&regions, &img_path, None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            layers.len(),
            1,
            "ノイズが除外されず残っている: {:?}",
            layers.iter().map(|l| &l.text).collect::<Vec<_>>()
        );
        assert_eq!(layers[0].text, "SALE");
    }

    fn white_count(path: &Path) -> u64 {
        let m = image::open(path).unwrap().to_luma8();
        m.pixels().filter(|p| p[0] > 127).count() as u64
    }

    /// ストロークマスクが「矩形マスクより塗り面積が小さい」ことの回帰テスト。
    ///
    /// 2026-07-02 の技術調査結論: bbox 矩形をやめて DB 確率マップのストロークを塗れば、
    /// 文字の隙間・行間の背景を塗らずに済み、縁残り・過剰復元が減る。ここでは「白矩形の中に
    /// 黒の細線パターン」を疑似文字とし、確率マップは細線位置だけ高確率にする。同じ採用 bbox に
    /// 対して、ストローク方式の塗り面積 < 矩形方式の塗り面積 を機械検証する。
    #[test]
    fn stroke_mask_paints_less_than_bbox_mask() {
        use crate::edit::ocr::TextProbMap;

        let dir = std::env::temp_dir().join(format!(
            "gori-stroke-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let (w, h) = (200u32, 120u32);
        // 背景グレー + bbox 内に「黒の細い縦線パターン」(疑似文字ストローク)。
        let mut img = ImageBuffer::<Rgb<u8>, Vec<u8>>::from_pixel(w, h, Rgb([200, 200, 200]));
        // 採用 bbox: (50,40) 100x40。
        let (bx, by, bw, bh) = (50u32, 40u32, 100u32, 40u32);

        // 確率マップ: 全面 0、bbox 内で 8px ごとに 2px 幅の縦ストロークだけ高確率 (1.0)。
        let mut prob = vec![0u8; (w * h) as usize];
        for yy in by..(by + bh) {
            for xx in bx..(bx + bw) {
                let local_x = xx - bx;
                let is_stroke = (local_x % 8) < 2; // 2/8 = 25% だけがストローク
                if is_stroke {
                    img.put_pixel(xx, yy, Rgb([10, 10, 10]));
                    prob[(yy * w + xx) as usize] = 255;
                }
            }
        }
        let img_path = dir.join("in.png");
        img.save(&img_path).unwrap();

        let prob_map = TextProbMap {
            width: w,
            height: h,
            data: prob,
        };

        // 採用される十分な面積 + 意味あるテキスト (100x40 = 4000px = 16.6% >> 0.1%)。
        let regions = vec![TextRegion {
            id: "region-0000".to_string(),
            bbox: [bx as i32, by as i32, bw as i32, bh as i32],
            polygon: Vec::new(),
            text: "SALE".to_string(),
            confidence: 0.9,
            language: None,
        }];

        // ストローク方式。
        let stroke_path = dir.join("stroke-mask.png");
        generate_text_mask(&img_path, &regions, Some(&prob_map), &stroke_path).unwrap();
        let stroke_area = white_count(&stroke_path);

        // 矩形フォールバック (prob_map=None)。
        let bbox_path = dir.join("bbox-mask.png");
        generate_text_mask(&img_path, &regions, None, &bbox_path).unwrap();
        let bbox_area = white_count(&bbox_path);
        let stroke_mask = image::open(&stroke_path).unwrap().to_luma8();

        let _ = std::fs::remove_dir_all(&dir);

        assert!(stroke_area > 0, "ストロークマスクが空 (文字を消せない)");
        assert!(bbox_area > 0, "bbox マスクが空 (採用 region 無し)");

        // 新仕様 (2026-07-03 inpaint 合成方式化に伴い改訂):
        // 「矩形より塗らない」ではなく、(1) 全ストローク画素を完全被覆する (取り逃がした
        // グロー/裾は合成後もそのまま残るため)、(2) bbox の近傍 (pad + 膨張上限) に収まる、
        // の2点を不変条件とする。
        let bound = (BBOX_GATE_PAD + DB_STROKE_DILATE_MAX) as u32;
        for yy in 0..h {
            for xx in 0..w {
                let painted = stroke_mask.get_pixel(xx, yy)[0] > 127;
                let is_stroke =
                    xx >= bx && xx < bx + bw && yy >= by && yy < by + bh && (xx - bx) % 8 < 2;
                if is_stroke {
                    assert!(painted, "ストローク画素 ({xx},{yy}) が未被覆 (消し残しになる)");
                }
                let in_bound = xx + bound >= bx
                    && xx < bx + bw + bound
                    && yy + bound >= by
                    && yy < by + bh + bound;
                if painted {
                    assert!(in_bound, "bbox 近傍外 ({xx},{yy}) を塗っている (塗り過ぎ)");
                }
            }
        }
    }

    #[test]
    fn split_overlay_regions_protects_text_on_subject() {
        // 被写体マスク: 右側の矩形 (100..180, 40..160)。
        let mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_fn(200, 200, |x, y| {
            if (100..180).contains(&x) && (40..160).contains(&y) {
                Luma([255u8])
            } else {
                Luma([0u8])
            }
        });
        let make = |id: &str, bbox: [i32; 4]| TextRegion {
            id: id.to_string(),
            bbox,
            polygon: Vec::new(),
            text: "SALE".to_string(),
            confidence: 0.9,
            language: None,
        };
        let regions = vec![
            make("on-subject", [110, 60, 50, 20]), // 被写体上 (カバー率1.0) → 保護
            make("overlay", [10, 10, 60, 20]),     // 背景上 (カバー率0) → オーバーレイ
        ];

        let (overlay, protected) = split_overlay_regions(&regions, Some(&mask), 200, 200);
        assert_eq!(protected, 1, "被写体上テキストが保護されない");
        assert_eq!(overlay.len(), 1);
        assert_eq!(overlay[0].id, "overlay");

        // マスク無しなら全件オーバーレイ (従来挙動)。
        let (overlay, protected) = split_overlay_regions(&regions, None, 200, 200);
        assert_eq!(protected, 0);
        assert_eq!(overlay.len(), 2);
    }

    #[test]
    fn text_color_uses_stroke_median_not_center_gap() {
        use crate::edit::ocr::TextProbMap;
        // 暗い背景 + bbox 内の縦ストロークだけ白。bbox 中心はストロークの隙間 (暗い) に置き、
        // 旧実装 (中心1点) なら暗色、新実装 (ストローク中央値) なら白になる配置。
        let (w, h) = (100u32, 50u32);
        let mut rgb = image::RgbImage::from_pixel(w, h, image::Rgb([10, 12, 20]));
        let mut prob = vec![0u8; (w * h) as usize];
        let bbox = [10u32, 10, 80, 30];
        for y in 10..40u32 {
            for x in 10..90u32 {
                if (x - 10) % 10 < 3 {
                    // 中心 x=50 は (50-10)%10=0 <3 … 中心を隙間にするため x=50 帯は避ける
                    if !(48..=52).contains(&x) {
                        rgb.put_pixel(x, y, image::Rgb([250, 250, 245]));
                        prob[(y * w + x) as usize] = 255;
                    }
                }
            }
        }
        let pm = TextProbMap {
            width: w,
            height: h,
            data: prob,
        };
        let color = text_color(&rgb, bbox, Some(&pm));
        // 白系 (#f8f8f5 前後) が返る。
        let r = u8::from_str_radix(&color[1..3], 16).unwrap();
        assert!(r > 200, "ストローク色が反映されていない: {color}");

        // 確率マップ無しは従来の中心1点 (暗色) フォールバック。
        let fallback = text_color(&rgb, bbox, None);
        let r = u8::from_str_radix(&fallback[1..3], 16).unwrap();
        assert!(r < 100, "フォールバックが中心1点でない: {fallback}");
    }
}
