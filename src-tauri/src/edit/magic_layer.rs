use std::path::Path;

use image::{GenericImageView, ImageBuffer, Luma};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::edit_segment::now_secs;
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::human_parse::human_parse_image;
use crate::edit::inpaint::inpaint_image;
use crate::edit::ocr::{ocr_image, TextRegion};
use crate::edit::segment::segment_image;
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MagicLayerResult {
    pub background_path: String,
    pub foreground_path: String,
    pub mask_path: String,
    pub text_layers: Vec<TextLayerSpec>,
    /// 高精度モードで認識した人物パーツ群。standard モードでは空。
    pub part_layers: Vec<PartLayerSpec>,
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
) -> Result<MagicLayerResult, String> {
    match run_magic_layer_inner(app, state, input_path, project_name, mode).await {
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
    let segment_result = segment_image(runtime, &text_removed_path, &run_dir).await?;
    tracing::info!(target: "codex.edit", "magic_layer: セグメント完了 {}x{}", segment_result.width, segment_result.height);

    // 背景レイヤーは「元画像そのもの」を使う (昔の SAM3 run_split と同方式)。
    // 以前は LaMa で被写体領域を背景補完していたが、それは被写体を消して塗りつぶす
    // 処理であり、BiRefNet マスクが破綻すると画面が真っ白になる原因だった
    // (2026-06-18 STΛCK 実機報告)。元画像を最背面に残せばマスクが多少崩れても
    // 元の絵は必ず見える。前景(切り抜き被写体)はその上に重ねる。
    // LaMa は「レイヤーを動かした跡を埋める」用途で別途呼ぶ設計に寄せる(段階2)。
    let background_path = run_dir.join("background.png");
    tokio::fs::copy(input_path, &background_path)
        .await
        .map_err(|e| format!("copy original as background: {e}"))?;

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
        width: segment_result.width,
        height: segment_result.height,
        run_dir: path_string(&run_dir),
    };

    write_json_file(&run_dir.join("manifest.json"), &result).await?;

    let _ = app.emit(EVENT_EDIT_MAGIC_PROGRESS, MagicLayerProgress::Completed);
    Ok(result)
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

    Ok(regions
        .iter()
        .enumerate()
        .filter_map(|(index, region)| {
            let text = region.text.trim();
            if text.is_empty() {
                return None;
            }
            let [x, y, w, h] = clamp_bbox(region.bbox, width, height)?;
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

fn contains_japanese(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch as u32,
            0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff
        )
    })
}
