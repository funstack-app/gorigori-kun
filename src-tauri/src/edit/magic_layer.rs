use std::path::Path;

use image::{GenericImageView, ImageBuffer, Luma};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::edit_segment::now_secs;
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::human_parse::human_parse_image;
use crate::edit::inpaint::inpaint_image;
use crate::edit::ocr::{ocr_image, TextRegion};
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
    let regions = ocr_image(runtime, input_path).await?;
    tracing::info!(target: "codex.edit", "magic_layer: OCR完了 regions={}", regions.len());

    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::RemovingText);
    let text_mask_path = run_dir.join("text-mask.png");
    generate_mask_from_regions(input_path, &regions, &text_mask_path)?;
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

    // 物体分解: 人物・テキスト以外の主要物体を SAM2 自動マスクでレイヤー化する。
    // segment_result (人物マスク) と OCR regions (テキスト領域) を「既存レイヤー」として
    // 除外マスクを作り、それと重なる物体は二重化になるので拾わない。
    let width = segment_result.width;
    let height = segment_result.height;
    let text_boxes: Vec<[i32; 4]> = regions
        .iter()
        .filter_map(|region| clamp_bbox(region.bbox, width, height))
        .map(|[x, y, w, h]| [x as i32, y as i32, w as i32, h as i32])
        .collect();

    let (object_layers, union_mask) = if object_options.enabled {
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
    let inpaint_mask = if object_layers.is_empty() {
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
        if dilated.save(&union_mask_path).is_ok()
            && inpaint_image(runtime, input_path, &union_mask_path, &background_path)
                .await
                .is_ok()
        {
            background_ready = true;
        }
    }
    if !background_ready {
        tokio::fs::copy(input_path, &background_path)
            .await
            .map_err(|e| format!("copy original as background: {e}"))?;
    }

    let _ = app.emit(
        EVENT_EDIT_MAGIC_PROGRESS,
        MagicLayerProgress::BuildingTextLayers,
    );
    let text_layers = build_text_layers(&regions, input_path)?;

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
            let cx = (x + w / 2).min(width.saturating_sub(1));
            let cy = (y + h / 2).min(height.saturating_sub(1));
            let p = rgb.get_pixel(cx, cy);
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
                color: format!("#{:02x}{:02x}{:02x}", p[0], p[1], p[2]),
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

pub fn generate_mask_from_regions(
    input_path: &Path,
    regions: &[TextRegion],
    output_path: &Path,
) -> Result<(), String> {
    let img = image::open(input_path).map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    let mut mask = ImageBuffer::<Luma<u8>, Vec<u8>>::from_pixel(w, h, Luma([0u8]));
    for region in regions {
        let [x, y, rw, rh] = region.bbox;
        if rw <= 0 || rh <= 0 || w == 0 || h == 0 {
            continue;
        }
        let pad = 4;
        let x0 = (x - pad).max(0) as u32;
        let y0 = (y - pad).max(0) as u32;
        let x1 = ((x + rw + pad).min(w.saturating_sub(1) as i32)).max(0) as u32;
        let y1 = ((y + rh + pad).min(h.saturating_sub(1) as i32)).max(0) as u32;
        if x0 > x1 || y0 > y1 {
            continue;
        }
        for yy in y0..=y1 {
            for xx in x0..=x1 {
                mask.put_pixel(xx, yy, Luma([255u8]));
            }
        }
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir mask parent: {e}"))?;
    }
    mask.save(output_path)
        .map_err(|e| format!("save mask: {e}"))
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

        let layers = build_text_layers(&regions, &img_path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            layers.len(),
            1,
            "ノイズが除外されず残っている: {:?}",
            layers.iter().map(|l| &l.text).collect::<Vec<_>>()
        );
        assert_eq!(layers[0].text, "SALE");
    }
}
