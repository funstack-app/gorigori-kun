//! ONNX Runtime (ort) を必要とする編集コマンドの、非 Windows 向けスタブ (2026-07-28)。
//!
//! なぜこのファイルがあるか:
//!   ort-sys 2.0.0-rc.12 が Intel Mac (x86_64-apple-darwin) の prebuilt 配布を
//!   終了したため、ort を全プラットフォーム依存のままにすると Intel Mac がビルド
//!   できない。ort を Windows 限定に格下げして Intel Mac 対応を復活させた
//!   (Cargo.toml の [target.'cfg(target_os = "windows")'.dependencies] 参照)。
//!
//!   ort を使う編集機能群 (SAM2 / SAM3 / LaMa / BiRefNet / PP-OCR) はフロントで
//!   封印済みだが、`src/lib/ipc.ts` に invoke ラッパが残っており、編集タブ
//!   (EditWorkspace) 自体はマウントされる。つまり「呼ばれない」ことをコードで
//!   証明できない。コマンド未登録のまま呼ばれると Tauri は
//!   "Command xxx not found" という原因の分からない生エラーを返すため、
//!   ここで意味の分かる日本語エラーに変換する。
//!
//!   Mac の背景透過は Vision (resources/removebg.swift) 経由で、ort とは無関係に
//!   動く (commands/images.rs)。この差し替えの影響を受けない。

/// 非 Windows で ort 依存コマンドが呼ばれたときに返す文言。
///
/// フロントはこの文字列をそのままトースト表示する想定。原因 (Windows 限定) と
/// 代替 (背景透過は使える) が1文で分かるようにしてある。
const UNSUPPORTED: &str = "この機能は現在 Windows 版のみです。Mac では画像の背景透過をご利用ください。";

fn unsupported<T>() -> Result<T, String> {
    Err(UNSUPPORTED.to_string())
}

// ──────────── edit_segment ────────────

#[tauri::command]
pub async fn edit_segment_run(
    input_path: String,
    project_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = (input_path, project_name);
    unsupported()
}

// ──────────── edit_sam2 ────────────

#[tauri::command]
pub async fn edit_sam2_embed(input_path: String) -> Result<(), String> {
    let _ = input_path;
    unsupported()
}

#[tauri::command]
pub async fn edit_sam2_predict(
    x: f32,
    y: f32,
    positive: bool,
) -> Result<serde_json::Value, String> {
    let _ = (x, y, positive);
    unsupported()
}

// ──────────── edit_ocr ────────────

#[tauri::command]
pub async fn edit_ocr_detect(input_path: String) -> Result<serde_json::Value, String> {
    let _ = input_path;
    unsupported()
}

// ──────────── edit_inpaint ────────────

#[tauri::command]
pub async fn edit_inpaint_run(
    input_path: String,
    mask_path: String,
    project_name: Option<String>,
) -> Result<String, String> {
    let _ = (input_path, mask_path, project_name);
    unsupported()
}

// ──────────── edit_grab ────────────

#[tauri::command]
pub async fn edit_grab_object(
    input_path: String,
    mask_path: String,
    project_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = (input_path, mask_path, project_name);
    unsupported()
}

// ──────────── edit_magic ────────────

#[tauri::command]
pub async fn edit_magic_run(
    input_path: String,
    project_name: Option<String>,
    mode: Option<String>,
    include_objects: Option<bool>,
    object_count: Option<usize>,
) -> Result<serde_json::Value, String> {
    let _ = (input_path, project_name, mode, include_objects, object_count);
    unsupported()
}

// ──────────── edit_words ────────────

#[tauri::command]
pub async fn edit_words_segment(
    input_path: String,
    words: serde_json::Value,
    project_name: Option<String>,
    score_threshold: Option<f32>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = (input_path, words, project_name, score_threshold, mode);
    unsupported()
}

// ──────────── segment (背景除去タブの BiRefNet 経路) ────────────
//
// 注意: `segment_image` は BiRefNet (ort) を使う経路。Mac の背景透過
// (images.rs の removebg.swift / Vision) とは別物で、そちらは影響を受けない。

#[tauri::command]
pub async fn segment_image(
    image_path: String,
    model: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let _ = (image_path, model);
    unsupported()
}
