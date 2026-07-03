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
) -> Result<WordsSegmentResult, String> {
    match run_words_segment(&app, &state, &input_path, words, project_name, score_threshold).await
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

    let mut layers: Vec<WordLayerSpec> = Vec::new();
    let guard = state.sam3_text_session.read().await;
    let session = guard
        .as_ref()
        .ok_or_else(|| "sam3 session missing".to_string())?;
    for word in &words {
        let label_base = word
            .label
            .clone()
            .unwrap_or_else(|| word.prompt.clone());
        let _ = app.emit(
            EVENT_EDIT_WORDS_PROGRESS,
            WordsProgress::Word {
                label: label_base.clone(),
            },
        );
        let detections = session.predict_word(&word.prompt, threshold).await?;
        for (i, det) in detections.iter().enumerate() {
            let file_stem = sanitize_file_stem(&word.prompt);
            let out_path = run_dir.join(format!("word-{file_stem}-{:02}.png", i + 1));
            let bbox = crate::edit::grab::crop_object_png(&rgba, &det.mask, &out_path)?;
            let label = if detections.len() > 1 {
                format!("{label_base} {}", i + 1)
            } else {
                label_base.clone()
            };
            layers.push(WordLayerSpec {
                image_path: out_path.to_string_lossy().into_owned(),
                bbox,
                label,
                prompt: word.prompt.clone(),
                score: det.score,
            });
        }
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
        run_dir: run_dir.to_string_lossy().into_owned(),
        width,
        height,
    })
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
