//! ことばで分離 (SAM3 テキストプロンプト・セグメンテーション) コマンド。
//!
//! フロントから「ことば (英語プロンプト + 表示名)」を受け取り、検出インスタンスごとに
//! bbox クロップ透過 PNG を書き出してレイヤー候補として返す。vision embed は
//! AppState 内のセッションにキャッシュされ、同じ画像への語の追加は数秒で返る。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::edit_segment::now_secs;
use crate::commands::storage::{resolve_output_dir, StorageSettings};
use crate::edit::inpaint::inpaint_image;
use crate::edit::magic_layer::{
    build_text_layers, generate_text_erase_mask, split_overlay_regions, TextLayerSpec,
};
use crate::edit::ocr::ocr_image_with_probmap;
use crate::edit::sam3_text::{Sam3TextSession, DEFAULT_SCORE_THRESHOLD};
use crate::events::EVENT_EDIT_WORDS_PROGRESS;
use crate::state::AppState;

/// フロントから渡す「ことば」1件。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordInput {
    /// SAM3 へ渡す英語プロンプト (例: "basketball")。
    pub prompt: String,
    /// レイヤー名に使う表示名 (例: "バスケットボール")。省略時は prompt。
    pub label: Option<String>,
}

/// 検出インスタンス1件 = レイヤー候補1件。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WordLayerSpec {
    /// bbox クロップ透過 PNG のパス (マスクのソフトエッジを alpha に焼き込み済み)。
    pub image_path: String,
    /// 元画像ピクセル座標での [x, y, width, height]。
    pub bbox: [i32; 4],
    /// 表示名。同一語で複数インスタンスなら "ボール 2" のように連番。
    pub label: String,
    /// 検出に使った英語プロンプト。
    pub prompt: String,
    /// 確信度 (0..1)。
    pub score: f32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WordsSegmentResult {
    pub layers: Vec<WordLayerSpec>,
    /// full モードのみ: 切り出し跡地を補完し、オーバーレイ文字を消した背景画像。
    pub background_path: Option<String>,
    /// full モードのみ: OCR で検出した編集可能テキストレイヤー群 (Magic Layer と同形式)。
    pub text_layers: Vec<TextLayerSpec>,
    pub run_dir: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WordsProgress {
    /// vision encoder 実行中 (画像ごと1回、数秒〜数十秒)。
    Embedding,
    /// 1語の推論中。
    Word { label: String },
    /// full モード: 文字の検出・消去中。
    DetectingText,
    /// full モード: 切り出し跡地の背景補完中。
    FillingBackground,
    Completed,
    Failed { reason: String },
}

#[tauri::command]
pub async fn edit_words_segment(
    app: AppHandle,
    state: State<'_, AppState>,
    input_path: String,
    words: Vec<WordInput>,
    project_name: Option<String>,
    // 確信度の下限。省略時 DEFAULT_SCORE_THRESHOLD (0.60)。
    score_threshold: Option<f32>,
    // "full" = 背景補完+テキストレイヤー化まで行う初回分解 / 省略・"layersOnly" = レイヤー追記のみ。
    mode: Option<String>,
) -> Result<WordsSegmentResult, String> {
    let full = mode.as_deref() == Some("full");
    match run_words_segment(
        &app,
        &state,
        &input_path,
        words,
        project_name,
        score_threshold,
        full,
    )
    .await
    {
        Ok(result) => {
            let _ = app.emit(EVENT_EDIT_WORDS_PROGRESS, WordsProgress::Completed);
            Ok(result)
        }
        Err(reason) => {
            let _ = app.emit(
                EVENT_EDIT_WORDS_PROGRESS,
                WordsProgress::Failed {
                    reason: reason.clone(),
                },
            );
            Err(reason)
        }
    }
}

async fn run_words_segment(
    app: &AppHandle,
    state: &AppState,
    input_path: &str,
    words: Vec<WordInput>,
    project_name: Option<String>,
    score_threshold: Option<f32>,
    full: bool,
) -> Result<WordsSegmentResult, String> {
    let input = Path::new(input_path);
    if !input.exists() {
        return Err(format!("input image not found: {input_path}"));
    }
    if words.is_empty() {
        return Err("words is empty".to_string());
    }
    let threshold = score_threshold.unwrap_or(DEFAULT_SCORE_THRESHOLD).clamp(0.05, 0.95);

    // セッションを確保 (初回はモデルロード)。embed キャッシュを活かすため AppState に保持。
    {
        let mut guard = state.sam3_text_session.write().await;
        if guard.is_none() {
            *guard = Some(Sam3TextSession::new(state.edit_runtime()).await?);
        }
        let session = guard.as_mut().expect("sam3 session just set");
        let _ = app.emit(EVENT_EDIT_WORDS_PROGRESS, WordsProgress::Embedding);
        session.embed_image(input).await?;
    }

    let settings = match state.storage_settings().await {
        Some(settings) => settings,
        None => StorageSettings::load()?,
    };
    let leaf = format!("edit-words-{}", now_secs());
    let run_dir = resolve_output_dir(&settings, project_name.as_deref(), &leaf);
    tokio::fs::create_dir_all(&run_dir)
        .await
        .map_err(|e| format!("mkdir: {e}"))?;

    let rgba = image::open(input)
        .map_err(|e| format!("open input: {e}"))?
        .to_rgba8();
    let (width, height) = rgba.dimensions();

    // 1) 全語の検出をまず収集する (クロップはクロスワード重複排除の後)。
    struct Pending {
        word_index: usize,
        score: f32,
        mask: image::ImageBuffer<image::Luma<u8>, Vec<u8>>,
    }
    let mut pending: Vec<Pending> = Vec::new();
    {
        let guard = state.sam3_text_session.read().await;
        let session = guard
            .as_ref()
            .ok_or_else(|| "sam3 session missing".to_string())?;
        for (word_index, word) in words.iter().enumerate() {
            let label_base = word.label.clone().unwrap_or_else(|| word.prompt.clone());
            let _ = app.emit(
                EVENT_EDIT_WORDS_PROGRESS,
                WordsProgress::Word { label: label_base },
            );
            let detections = session.predict_word(&word.prompt, threshold).await?;
            for det in detections {
                pending.push(Pending {
                    word_index,
                    score: det.score,
                    mask: det.mask,
                });
            }
        }
    }

    // 2) クロスワード重複排除 + 部品マージ:
    //    - 重複: 同じ物体を複数の語 (ball と basketball) が拾ったら確信度の高い方だけ。
    //    - 部品: マスクが別のマスクにほぼ包含される検出 (例: ロボットの中のユニフォーム) は
    //      「その物体の一部」なのでレイヤー化しない。人物は服・装備ごと1レイヤーにまとめる
    //      (2026-07-03 STΛCK指摘「人物は人物、小物は小物でグループしてほしい」)。
    //      包含判定は面積の大きい方を親として残す (スコア順でなく構造優先)。
    const CROSS_WORD_NMS_IOU: f64 = 0.70;
    const PART_CONTAINMENT: f64 = 0.80;
    // 面積降順で走査: 親 (大きい物体) から確定させ、部品を後から弾く。
    pending.sort_by(|a, b| {
        mask_area(&b.mask)
            .cmp(&mask_area(&a.mask))
            .then(b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut kept: Vec<Pending> = Vec::new();
    for candidate in pending {
        let dup = kept
            .iter()
            .any(|k| mask_iou(&candidate.mask, &k.mask) > CROSS_WORD_NMS_IOU);
        if dup {
            continue;
        }
        let contained = kept
            .iter()
            .any(|k| containment(&candidate.mask, &k.mask) > PART_CONTAINMENT);
        if contained {
            tracing::info!(
                target: "codex.edit",
                "words: 部品マージ (word='{}' score={:.2} は既存レイヤーに包含)",
                words[candidate.word_index].prompt,
                candidate.score
            );
            continue;
        }
        kept.push(candidate);
    }

    // full モード: 背景補完 + 編集可能テキストレイヤー化 (Magic Layer 相当の仕上げ)。
    // - 切り出した物体の union 跡地を LaMa で補完した「背景」を作る
    //   (元画像を下に敷いたままだと、レイヤーを動かしたとき下に同じ絵が残る)
    // - オーバーレイ文字は編集可能テキストレイヤーへ変換し背景から消す。
    //   切り出した物体の上に載っている文字 (印字・ロゴ) は物体の柄として保護する
    let mut background_path_out: Option<String> = None;
    let mut text_layers_out: Vec<TextLayerSpec> = Vec::new();
    if full {
        let runtime = state.edit_runtime();

        // 物体 union マスク (テキスト保護の「被写体」判定と跡地補完の両方に使う)。
        let mut union =
            image::ImageBuffer::<image::Luma<u8>, Vec<u8>>::from_pixel(width, height, image::Luma([0u8]));
        for k in &kept {
            if k.mask.dimensions() == (width, height) {
                for (dst, src) in union.pixels_mut().zip(k.mask.pixels()) {
                    if src[0] > 127 {
                        *dst = image::Luma([255u8]);
                    }
                }
            }
        }

        // テキスト: OCR → 物体上の印字を保護 → オーバーレイのみ消去+レイヤー化。
        let _ = app.emit(EVENT_EDIT_WORDS_PROGRESS, WordsProgress::DetectingText);
        let text_removed_path = run_dir.join("text-removed.png");
        match ocr_image_with_probmap(runtime, input).await {
            Ok((regions, prob_map)) => {
                let (overlay_regions, protected) =
                    split_overlay_regions(&regions, Some(&union), width, height);
                if protected > 0 {
                    tracing::info!(target: "codex.edit", "words: 物体上テキスト{protected}件を保護");
                }
                let text_mask_path = run_dir.join("text-mask.png");
                generate_text_erase_mask(input, &overlay_regions, &text_mask_path)?;
                if overlay_regions.is_empty() {
                    tokio::fs::copy(input, &text_removed_path)
                        .await
                        .map_err(|e| format!("copy text-removed: {e}"))?;
                } else if let Err(reason) = crate::edit::inpaint::remove_text_by_interpolation(
                    input,
                    &text_mask_path,
                    &text_removed_path,
                ) {
                    tracing::warn!(target: "codex.edit", "words: テキスト消去失敗、原画像で続行 ({reason})");
                    tokio::fs::copy(input, &text_removed_path)
                        .await
                        .map_err(|e| format!("copy text-removed (fallback): {e}"))?;
                }
                text_layers_out = build_text_layers(&overlay_regions, input, prob_map.as_ref())?;
            }
            Err(reason) => {
                // OCR 不能 (モデル未DL等) でも物体分解は成立させる。文字はそのまま背景に残る。
                tracing::warn!(target: "codex.edit", "words: OCRスキップ ({reason})");
                tokio::fs::copy(input, &text_removed_path)
                    .await
                    .map_err(|e| format!("copy text-removed (no-ocr): {e}"))?;
            }
        }

        // 背景: 物体 union の跡地を補完する (テキスト消去済み画像がベース)。
        let _ = app.emit(EVENT_EDIT_WORDS_PROGRESS, WordsProgress::FillingBackground);
        let background_path = run_dir.join("background.png");
        let union_area = union.pixels().filter(|p| p[0] > 127).count();
        if union_area > 0 {
            let union_path = run_dir.join("object-union-mask.png");
            let dilated = crate::edit::grab::dilate_mask_pub(&union, 6);
            let filled = dilated.save(&union_path).is_ok()
                && inpaint_image(runtime, &text_removed_path, &union_path, &background_path)
                    .await
                    .is_ok();
            if !filled {
                tracing::warn!(target: "codex.edit", "words: 背景補完失敗、テキスト消去済み画像で続行");
                tokio::fs::copy(&text_removed_path, &background_path)
                    .await
                    .map_err(|e| format!("copy background (fallback): {e}"))?;
            }
        } else {
            tokio::fs::copy(&text_removed_path, &background_path)
                .await
                .map_err(|e| format!("copy background: {e}"))?;
        }
        background_path_out = Some(background_path.to_string_lossy().into_owned());
    }

    // 3) 採用分をクロップしてレイヤー化。同一語の複数インスタンスは連番を振る。
    let mut per_word_count: Vec<usize> = vec![0; words.len()];
    for k in &kept {
        per_word_count[k.word_index] += 1;
    }
    let mut per_word_seen: Vec<usize> = vec![0; words.len()];
    let mut layers: Vec<WordLayerSpec> = Vec::new();
    for k in &kept {
        let word = &words[k.word_index];
        let label_base = word.label.clone().unwrap_or_else(|| word.prompt.clone());
        per_word_seen[k.word_index] += 1;
        let seq = per_word_seen[k.word_index];
        let file_stem = sanitize_file_stem(&word.prompt);
        let out_path = run_dir.join(format!("word-{file_stem}-{seq:02}.png"));
        let bbox = crate::edit::grab::crop_object_png(&rgba, &k.mask, &out_path)?;
        let label = if per_word_count[k.word_index] > 1 {
            format!("{label_base} {seq}")
        } else {
            label_base
        };
        layers.push(WordLayerSpec {
            image_path: out_path.to_string_lossy().into_owned(),
            bbox,
            label,
            prompt: word.prompt.clone(),
            score: k.score,
        });
    }

    tracing::info!(
        target: "codex.edit",
        "words segment: {}語 → {}レイヤー ({})",
        words.len(),
        layers.len(),
        run_dir.display()
    );
    Ok(WordsSegmentResult {
        layers,
        background_path: background_path_out,
        text_layers: text_layers_out,
        run_dir: run_dir.to_string_lossy().into_owned(),
        width,
        height,
    })
}

/// マスクの白画素数 (>127)。
fn mask_area(m: &image::ImageBuffer<image::Luma<u8>, Vec<u8>>) -> u64 {
    m.pixels().filter(|p| p[0] > 127).count() as u64
}

/// a のうち b に覆われている割合 (a の部品度)。a が空か寸法不一致は 0。
fn containment(
    a: &image::ImageBuffer<image::Luma<u8>, Vec<u8>>,
    b: &image::ImageBuffer<image::Luma<u8>, Vec<u8>>,
) -> f64 {
    if a.dimensions() != b.dimensions() {
        return 0.0;
    }
    let mut inter = 0u64;
    let mut area_a = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        if pa[0] > 127 {
            area_a += 1;
            if pb[0] > 127 {
                inter += 1;
            }
        }
    }
    if area_a == 0 {
        0.0
    } else {
        inter as f64 / area_a as f64
    }
}

/// 2つのソフトマスク (>127 が対象) の IoU。寸法不一致は 0。
fn mask_iou(
    a: &image::ImageBuffer<image::Luma<u8>, Vec<u8>>,
    b: &image::ImageBuffer<image::Luma<u8>, Vec<u8>>,
) -> f64 {
    if a.dimensions() != b.dimensions() {
        return 0.0;
    }
    let mut inter = 0u64;
    let mut union = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let wa = pa[0] > 127;
        let wb = pb[0] > 127;
        if wa && wb {
            inter += 1;
        }
        if wa || wb {
            union += 1;
        }
    }
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// プロンプトをファイル名に使える形へ (ASCII英数字以外は '_')。
fn sanitize_file_stem(prompt: &str) -> String {
    let cleaned: String = prompt
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if cleaned.chars().all(|c| c == '_') {
        "word".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_ascii_and_replaces_rest() {
        assert_eq!(sanitize_file_stem("basketball"), "basketball");
        assert_eq!(sanitize_file_stem("fire truck"), "fire_truck");
        assert_eq!(sanitize_file_stem("ボール"), "word");
    }
}
